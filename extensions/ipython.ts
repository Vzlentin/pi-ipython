import type { JsonObject } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CellsView } from "./cells.ts";
import { describeError, INTERRUPT_GRACE_MS, KernelRuntime, OUTPUT_CAPTURE_LIMIT_BYTES } from "./kernel-runtime.ts";
import { CHECKPOINT_ENTRY_TYPE, createRuntime } from "./persistence.ts";

const RESET_NOTICE = [
	"<ipython_kernel_reset>",
	"The IPython kernel was restarted. All in-memory variables, imports, tasks, and open resources from the previous kernel were lost; recreate them before continuing.",
	"</ipython_kernel_reset>",
].join("\n");

const DESCRIPTION = [
	"Execute Python in a persistent IPython kernel. Reuse variables, functions, datasets, and intermediate results across calls. Supports top-level await and native IPython magics. Checkpointed state follows the conversation branch; reloads and crashes restore the latest saved cell on that branch. Live resources, process state, and files are not rewound. The kernel runs with local user permissions, including filesystem and network access; it is not sandboxed.",
	"ipython is your persistent control environment, not the native runtime of the project. Run project code, tests, and CLIs through the project's own interface (documented commands, `uv run ...`, `.venv/bin/python ...`) and treat their result as the relevant result. Do not install project dependencies into the kernel.",
	"Kernel state persists across cells and checkpointed names survive resets and reloads. Keep reusable functions, datasets, read/search results, and intermediate computations in named variables. Save valuable results to explicit artifacts for recovery.",
	"Use Python for loops, parsing, and state. Use the shell only to invoke programs.",
	"In codemode scripts, a Python exception resolves with `status: \"error\"`; the call rejects when the kernel is lost. Pass data into a cell as a JSON string, for example `json.loads(${JSON.stringify(JSON.stringify(data))})`.",
	`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full truncated output is saved to a temporary file. Runaway cells exceeding ${formatSize(OUTPUT_CAPTURE_LIMIT_BYTES)} of output are interrupted; the kernel is killed only if it does not stop within ${INTERRUPT_GRACE_MS / 1000} seconds.`,
].join("\n\n");

const parameters = Type.Object({
	code: Type.String({ description: "Python or an IPython cell" }),
});

const outputSchema = Type.Object({
	status: Type.Union([Type.Literal("ok"), Type.Literal("error")], {
		description: "\"error\" when the cell raised or was interrupted",
	}),
	output: Type.String({ description: "Streams, display output and tracebacks, without ANSI codes" }),
	executionCount: Type.Optional(Type.Number()),
	error: Type.Optional(Type.Object({ ename: Type.String(), evalue: Type.String() })),
	truncated: Type.Boolean({ description: "Only the tail of the output is kept" }),
	fullOutputPath: Type.Optional(Type.String()),
	notices: Type.Array(Type.String(), {
		description: "Kernel restarts and checkpoint restores that happened before the cell ran",
	}),
});

interface IpythonDetails {
	status: "ok" | "error" | "running" | "starting";
	executionCount?: number;
	kernelReset?: boolean;
	truncated?: boolean;
	fullOutputPath?: string;
	checkpoint?: string;
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|[@-_][0-?]*[ -/]*[@-~])/g, "");
}

function partialText(output: string): string {
	const clean = stripAnsi(output);
	const truncated = truncateTail(clean, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncated.truncated) return truncated.content || "[no output yet]";
	return `[Live output truncated; showing the tail]\n${truncated.content}`;
}

function finalText(output: string, kernel: KernelRuntime): {
	text: string;
	output: string;
	truncated: boolean;
	fullOutputPath?: string;
} {
	const clean = stripAnsi(output);
	const truncated = truncateTail(clean, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncated.truncated) {
		return { text: truncated.content || "[no output]", output: truncated.content, truncated: false };
	}

	const fullOutputPath = kernel.saveOutput(clean);
	const omittedLines = truncated.totalLines - truncated.outputLines;
	const omittedBytes = truncated.totalBytes - truncated.outputBytes;
	const notice = [
		`[Output truncated: showing the last ${truncated.outputLines} of ${truncated.totalLines} lines`,
		`(${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}).`,
		`${omittedLines} lines (${formatSize(omittedBytes)}) omitted.`,
		`Full output saved to: ${fullOutputPath}]`,
	].join(" ");
	return {
		text: `${notice}\n${truncated.content}`,
		output: truncated.content,
		truncated: true,
		fullOutputPath,
	};
}

export default function ipythonExtension(pi: ExtensionAPI) {
	let runtime: ReturnType<typeof createRuntime> | undefined;
	// Checkpoint notices from opening the console, delivered with the next result.
	let undelivered: string[] = [];
	// Notices of cells that another tool ran, keyed by that tool's call until its result reaches the model.
	const forwarded = new Map<string, string[]>();
	const cells = new CellsView(pi);
	const getRuntime = (ctx: ExtensionContext) => runtime ??= createRuntime(pi, ctx.cwd);
	const toggleCells = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || process.env.HERDR_ENV !== "1") {
			ctx.ui.notify("/cells requires interactive Pi in Herdr.", "warning");
			return;
		}
		try {
			const { kernel, checkpoints } = getRuntime(ctx);
			const progress = (message: string) => ctx.ui.notify(message, "info");
			undelivered.push(...await checkpoints.sync(ctx.sessionManager.getBranch(), ctx.cwd, ctx.signal, progress));
			const connectionFile = await kernel.getConnectionFile(ctx.cwd, ctx.signal, progress);
			await cells.toggle(ctx.cwd, connectionFile);
		} catch (error) {
			ctx.ui.notify(String(error), "error");
		}
	};
	pi.registerCommand("cells", {
		description: "Toggle an IPython console on the kernel in Herdr: recorded history, live cells, and your own input",
		handler: async (_args, ctx) => toggleCells(ctx),
	});
	pi.registerShortcut("ctrl+shift+i", {
		description: "Toggle the IPython console in Herdr",
		handler: toggleCells,
	});

	pi.registerTool({
		name: "ipython",
		label: "IPython",
		description: DESCRIPTION,
		promptSnippet: "Persistent Python workspace for computation and data analysis",
		parameters,
		outputSchema,
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { kernel, checkpoints } = getRuntime(ctx);
			const transcript = ctx.mode === "tui" && process.env.HERDR_ENV === "1" ? cells : undefined;
			transcript?.begin(params.code);
			let latestOutput = "";
			let lastUpdate = 0;
			let updateTimer: ReturnType<typeof setTimeout> | undefined;
			const progress = (message: string) => {
				transcript?.note(message);
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
				lastUpdate = Date.now();
				const status = message.startsWith("Starting") || message.startsWith("Provisioning") ? "starting" : "running";
				const text = latestOutput ? `${message}\n\n${partialText(latestOutput)}` : message;
				onUpdate?.({
					content: [{ type: "text", text }],
					details: { status } satisfies IpythonDetails,
				});
			};
			const emitOutput = () => {
				updateTimer = undefined;
				lastUpdate = Date.now();
				onUpdate?.({
					content: [{ type: "text", text: partialText(latestOutput) }],
					details: { status: "running" } satisfies IpythonDetails,
				});
			};
			const output = (text: string) => {
				transcript?.output(text);
				latestOutput = text;
				const delay = Math.max(0, 100 - (Date.now() - lastUpdate));
				if (delay === 0) emitOutput();
				else if (!updateTimer) updateTimer = setTimeout(emitOutput, delay);
			};

			let execution: Awaited<ReturnType<KernelRuntime["execute"]>>;
			let notices: string[];
			try {
				notices = await checkpoints.sync(ctx.sessionManager.getBranch(), ctx.cwd, signal, progress);
				execution = await kernel.execute(toolCallId, params.code, ctx.cwd, signal, progress, output);
			} catch (error) {
				transcript?.finish(`error: ${String(error)}`);
				throw error;
			} finally {
				if (updateTimer) clearTimeout(updateTimer);
			}
			const { result, kernelReset } = execution;
			const cellNotices = [...(kernelReset ? [RESET_NOTICE] : []), ...undelivered, ...notices];
			const notice = cellNotices.join("\n\n");
			undelivered = [];
			transcript?.output(result.output);
			if (notice) transcript?.note(notice);
			if (result.status !== "ok" && !result.output) transcript?.note(describeError(result.error));
			transcript?.finish(`${result.status}${result.executionCount === undefined ? "" : ` | In [${result.executionCount}]`}`);
			const formatted = finalText(result.output, kernel);
			let visible = formatted.text;
			if (notice) {
				visible = formatted.text === "[no output]" ? notice : `${notice}\n\n${formatted.text}`;
			}
			if (result.status !== "ok") {
				const fallback = describeError(result.error);
				if (visible === "[no output]" && fallback) visible = fallback;
			}
			const status = result.status === "ok" ? "ok" : "error";
			const details: IpythonDetails = {
				status,
				executionCount: result.executionCount,
				kernelReset,
				truncated: formatted.truncated,
				fullOutputPath: formatted.fullOutputPath,
				checkpoint: checkpoints.save(),
			};
			const structuredContent: JsonObject = {
				status,
				output: formatted.output,
				truncated: formatted.truncated,
				notices: cellNotices,
			};
			if (result.executionCount !== undefined) structuredContent.executionCount = result.executionCount;
			if (status === "error") {
				structuredContent.error = { ename: result.error?.ename ?? "Error", evalue: result.error?.evalue ?? "" };
			}
			if (formatted.fullOutputPath) structuredContent.fullOutputPath = formatted.fullOutputPath;
			return { content: [{ type: "text", text: visible }], details, structuredContent, isError: status === "error" };
		},
	});

	pi.on("tool_result", (event) => {
		const notices = forwarded.get(event.toolCallId) ?? [];
		forwarded.delete(event.toolCallId);
		if (event.toolName === "ipython" && event.parentToolCallId !== undefined) {
			const checkpoint = (event.details as IpythonDetails | undefined)?.checkpoint;
			// Must be on the branch before the calling tool runs its next cell.
			if (checkpoint !== undefined) pi.appendEntry(CHECKPOINT_ENTRY_TYPE, { checkpoint });
			notices.push(...((event.structuredContent as { notices?: string[] } | undefined)?.notices ?? []));
		}
		if (notices.length === 0) return;
		if (event.parentToolCallId !== undefined) {
			forwarded.set(event.parentToolCallId, [...(forwarded.get(event.parentToolCallId) ?? []), ...notices]);
			return;
		}
		return {
			content: [...event.content, { type: "text", text: notices.join("\n\n") }],
			structuredContent: event.structuredContent,
		};
	});

	pi.on("session_shutdown", async () => {
		const closing = runtime;
		runtime = undefined;
		forwarded.clear();
		try {
			await closing?.checkpoints.close();
		} finally {
			try {
				await closing?.kernel.shutdown();
			} finally {
				await cells.shutdown();
			}
		}
	});
}
