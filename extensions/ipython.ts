import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { INTERRUPT_GRACE_MS, KernelRuntime, OUTPUT_CAPTURE_LIMIT_BYTES } from "./kernel-runtime.ts";

const RESET_NOTICE = [
	"<ipython_kernel_reset>",
	"The IPython kernel was restarted. All in-memory variables, imports, tasks, and open resources from the previous kernel were lost; recreate them before continuing.",
	"</ipython_kernel_reset>",
].join("\n");

const DESCRIPTION = [
	"Execute Python in a persistent IPython kernel. Reuse variables, functions, datasets, and intermediate results across calls. Supports top-level await and native IPython magics. State lasts only for the kernel process; resets and reloads lose it. The kernel runs with local user permissions, including filesystem and network access; it is not sandboxed.",
	"ipython is your persistent control environment, not the native runtime of the project. Run project code, tests, and CLIs through the project's own interface (documented commands, `uv run ...`, `.venv/bin/python ...`) and treat their result as the relevant result. Do not install project dependencies into the kernel.",
	"Kernel state persists across cells, not resets or reloads. Keep reusable functions, datasets, read/search results, and intermediate computations in named variables. Save valuable results to explicit artifacts for recovery.",
	"Use Python for loops, parsing, and state. Use the shell only to invoke programs.",
	`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full truncated output is saved to a temporary file. Runaway cells exceeding ${formatSize(OUTPUT_CAPTURE_LIMIT_BYTES)} of output are interrupted; the kernel is killed only if it does not stop within ${INTERRUPT_GRACE_MS / 1000} seconds.`,
].join("\n\n");

const parameters = Type.Object({
	code: Type.String({ description: "Python or an IPython cell" }),
});

interface IpythonDetails {
	status: "ok" | "error" | "running" | "starting";
	executionCount?: number;
	kernelReset?: boolean;
	truncated?: boolean;
	fullOutputPath?: string;
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

async function finalText(output: string): Promise<{
	text: string;
	truncated: boolean;
	fullOutputPath?: string;
}> {
	const clean = stripAnsi(output);
	const truncated = truncateTail(clean, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncated.truncated) return { text: truncated.content || "[no output]", truncated: false };

	const directory = await mkdtemp(join(tmpdir(), "pi-ipython-"));
	const fullOutputPath = join(directory, "output.txt");
	await writeFile(fullOutputPath, clean, "utf8");
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
		truncated: true,
		fullOutputPath,
	};
}

export default function ipythonExtension(pi: ExtensionAPI) {
	let runtime: KernelRuntime | undefined;
	const cells = new CellsView(pi);
	const getRuntime = () => runtime ??= new KernelRuntime(pi);
	const toggleCells = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || process.env.HERDR_ENV !== "1") {
			ctx.ui.notify("/cells requires interactive Pi in Herdr.", "warning");
			return;
		}
		try {
			const connectionFile = await getRuntime().getConnectionFile(
				ctx.cwd, ctx.signal, (message) => ctx.ui.notify(message, "info"),
			);
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
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const kernel = getRuntime();
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
			try {
				execution = await kernel.execute(toolCallId, params.code, ctx.cwd, signal, progress, output);
			} catch (error) {
				transcript?.finish(`error: ${String(error)}`);
				throw error;
			} finally {
				if (updateTimer) clearTimeout(updateTimer);
			}
			const { result, kernelReset } = execution;
			transcript?.output(result.output);
			if (kernelReset) transcript?.note(RESET_NOTICE);
			if (result.status !== "ok" && !result.output) {
				transcript?.note([result.error?.ename, result.error?.evalue].filter(Boolean).join(": "));
			}
			transcript?.finish(`${result.status}${result.executionCount === undefined ? "" : ` | In [${result.executionCount}]`}`);
			const formatted = await finalText(result.output);
			let visible = formatted.text;
			if (kernelReset) {
				visible = formatted.text === "[no output]" ? RESET_NOTICE : `${RESET_NOTICE}\n\n${formatted.text}`;
			}
			if (result.status !== "ok") {
				const fallback = [result.error?.ename, result.error?.evalue].filter(Boolean).join(": ");
				if (visible === "[no output]" && fallback) visible = fallback;
			}
			const details: IpythonDetails = {
				status: result.status === "ok" ? "ok" : "error",
				executionCount: result.executionCount,
				kernelReset,
				truncated: formatted.truncated,
				fullOutputPath: formatted.fullOutputPath,
			};
			return { content: [{ type: "text", text: visible }], details };
		},
	});

	// Mark failed cells as errors without throwing away their output.
	pi.on("tool_result", (event) => {
		if (event.toolName === "ipython" && (event.details as IpythonDetails | undefined)?.status === "error") {
			return { isError: true };
		}
	});

	pi.on("session_shutdown", async () => {
		try {
			await runtime?.shutdown();
		} finally {
			await cells.shutdown();
		}
	});
}
