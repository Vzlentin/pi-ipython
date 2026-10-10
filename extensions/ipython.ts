import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { cellResult, DESCRIPTION, RESET_NOTICE } from "./cell.ts";
import { CellsView } from "./cells.ts";
import { describeError, KernelLostError, type KernelRuntime } from "./kernel-runtime.ts";
import { partialText } from "./output.ts";
import { createRuntime, type Runtime } from "./persistence.ts";

const CODEMODE_NOTE =
	"In codemode scripts, a Python exception resolves with `status: \"error\"`; the call rejects when the kernel is lost. Pass data into a cell as a JSON string, for example `json.loads(${JSON.stringify(JSON.stringify(data))})`.";

/** Custom entry type for checkpoints of cells that another tool ran, since Pi does not save their results. */
const CHECKPOINT_ENTRY_TYPE = "ipython-checkpoint";

/** The checkpoint IDs on `branch`, newest first. */
function checkpointIds(branch: SessionEntry[]): string[] {
	const ids: string[] = [];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		let checkpoint: unknown;
		if (entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY_TYPE) {
			checkpoint = (entry.data as { checkpoint?: unknown } | undefined)?.checkpoint;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "ipython") {
			checkpoint = (entry.message.details as { checkpoint?: unknown } | undefined)?.checkpoint;
		}
		if (typeof checkpoint === "string") ids.push(checkpoint);
	}
	return ids;
}

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

export default function ipythonExtension(pi: ExtensionAPI) {
	let runtime: (Runtime & { sigterm: () => void }) | undefined;
	// Checkpoint notices from opening the console, delivered with the next result.
	let undelivered: string[] = [];
	// Notices of cells that another tool ran, keyed by that tool's call until its result reaches the model.
	const forwarded = new Map<string, string[]>();
	const cells = new CellsView(pi);
	const getRuntime = (ctx: ExtensionContext) => {
		if (runtime) return runtime;
		const created = createRuntime(pi, ctx.cwd);
		const sigterm = () => {
			// Another handler can remove itself while shutdown is in progress.
			const ownsExit = process.listeners("SIGTERM").every((listener) => listener === sigterm);
			void created.kernel.shutdown().catch(() => {}).finally(() => {
				if (ownsExit) {
					process.off("SIGTERM", sigterm);
					process.kill(process.pid, "SIGTERM");
				}
			});
		};
		process.prependOnceListener("SIGTERM", sigterm);
		return runtime = { ...created, sigterm };
	};
	const toggleCells = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || process.env.HERDR_ENV !== "1") {
			ctx.ui.notify("/cells requires interactive Pi in Herdr.", "warning");
			return;
		}
		try {
			const { kernel, checkpoints } = getRuntime(ctx);
			const progress = (message: string) => ctx.ui.notify(message, "info");
			undelivered.push(...await checkpoints.sync(checkpointIds(ctx.sessionManager.getBranch()), ctx.cwd, ctx.signal, progress));
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
		description: `${DESCRIPTION}\n\n${CODEMODE_NOTE}`,
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
				notices = await checkpoints.sync(checkpointIds(ctx.sessionManager.getBranch()), ctx.cwd, signal, progress);
				execution = await kernel.execute(toolCallId, params.code, ctx.cwd, signal, progress, output);
			} catch (error) {
				if (error instanceof KernelLostError) forwarded.set(toolCallId, [RESET_NOTICE]);
				transcript?.finish(`error: ${String(error)}`);
				throw error;
			} finally {
				if (updateTimer) clearTimeout(updateTimer);
			}
			const { result, kernelReset } = execution;
			const { data, header } = cellResult(execution, [...undelivered, ...notices], (text) => kernel.saveOutput(text));
			const notice = data.notices.join("\n\n");
			undelivered = [];
			transcript?.output(result.output);
			if (notice) transcript?.note(notice);
			if (result.status !== "ok" && !result.output) transcript?.note(describeError(result.error));
			transcript?.finish(`${result.status}${result.executionCount === undefined ? "" : ` | In [${result.executionCount}]`}`);
			const body = header ? `${header}\n${data.output}` : data.output;
			const text = (notice && body ? `${notice}\n\n${body}` : notice || body)
				|| (data.status === "error" && describeError(result.error)) || "[no output]";
			const details: IpythonDetails = {
				status: data.status,
				executionCount: data.executionCount,
				kernelReset,
				truncated: data.truncated,
				fullOutputPath: data.fullOutputPath,
				checkpoint: checkpoints.save(),
			};
			const structuredContent: Static<typeof outputSchema> = data;
			return { content: [{ type: "text", text }], details, structuredContent, isError: data.status === "error" };
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
			await closing?.close();
		} finally {
			if (closing) process.off("SIGTERM", closing.sigterm);
			await cells.shutdown();
		}
	});
}
