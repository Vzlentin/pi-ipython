import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createChildCompleter } from "./child-completion.ts";
import { CellsView } from "./cells.ts";
import {
	BRIDGE_PROTOCOL_VERSION,
	KernelRuntime,
	OUTPUT_CAPTURE_LIMIT_BYTES,
} from "./kernel-runtime.ts";
import {
	HOST_PROTOCOL_VERSION,
	MAX_CHILDREN_RUNNING,
	MAX_CHILD_REQUEST_BYTES,
	MAX_CHILD_TEXT_BYTES,
	MAX_HOST_RESPONSE_BYTES,
	MAX_LIVE_HANDLES,
} from "./rlm-host.ts";

const RESET_NOTICE = [
	"<ipython_kernel_reset>",
	"The IPython kernel was restarted. All in-memory variables, imports, tasks, and open resources from the previous kernel were lost; recreate them before continuing.",
	"</ipython_kernel_reset>",
].join("\n");

const parameters = Type.Object({
	code: Type.String({ description: "Python or an IPython cell" }),
});

interface IpythonDetails {
	status: "ok" | "error" | "running" | "starting";
	executionCount?: number;
	kernelReset?: boolean;
	truncated?: boolean;
	fullOutputPath?: string;
	final?: unknown;
	nestedUsage?: Usage;
	children?: {
		spawned: number;
		gathered: number;
	};
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

function renderFinal(value: unknown): string {
	if (typeof value === "string") return value;
	const encoded = JSON.stringify(value, null, 2);
	return encoded === undefined ? String(value) : encoded;
}

function hasUsage(usage: Usage): boolean {
	return usage.totalTokens > 0 || usage.cost.total > 0;
}

export default function rlmExtension(pi: ExtensionAPI) {
	let runtime: KernelRuntime | undefined;
	const cells = new CellsView(pi);
	const getRuntime = (ctx: ExtensionContext) => runtime ??= new KernelRuntime(pi, createChildCompleter(ctx.modelRegistry));
	const toggleCells = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || process.env.HERDR_ENV !== "1") {
			ctx.ui.notify("/cells requires interactive Pi in Herdr.", "warning");
			return;
		}
		try {
			const connectionFile = await getRuntime(ctx).getConnectionFile(
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
		description: `Execute code in a persistent IPython kernel. Supports top-level await, native IPython magics, and the Python APIs rlm.spawn(task, context=...), rlm.gather(handles), rlm.release(handles), and rlm.final(value). Gather delivers each handle once and recovers committed results after transport loss. Child calls are limited to ${MAX_CHILDREN_RUNNING} concurrent/${MAX_LIVE_HANDLES} live handles, ${formatSize(MAX_CHILD_REQUEST_BYTES)} input, ${formatSize(MAX_CHILD_TEXT_BYTES)} returned text, and a 5-minute deadline. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full truncated output is saved to a temporary file. Runaway cells exceeding ${formatSize(OUTPUT_CAPTURE_LIMIT_BYTES)} of output are stopped and reset the kernel.`,
		promptSnippet: "Persistent IPython scratchpad with focused recursive child calls",
		promptGuidelines: [
			"ipython is your persistent control environment, not the native runtime of the project. Run project code, tests, and CLIs through the project's own interface (documented commands, `uv run ...`, `.venv/bin/python ...`) and treat their result as the relevant result. Do not install project dependencies into the kernel.",
			"Kernel state persists across cells. Assign read, search, and parsed results to named variables and reuse them instead of re-reading files or re-running commands.",
			"Use Python for loops, parsing, and state. Use the shell only to invoke programs.",
			"Use rlm.spawn and rlm.gather when independent, context-heavy sub-tasks can be processed without placing their context in the root prompt. Do a single known lookup, edit, or command inline.",
			"Pass each child only the task and the context slice it needs. Gather delivers each handle once; keep handles in variables and gather them together. Use rlm.final only when the value is the complete answer.",
		],
		parameters,
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const kernel = getRuntime(ctx);
			const transcript = ctx.mode === "tui" && process.env.HERDR_ENV === "1" ? cells : undefined;
			transcript?.begin(params.code);
			let latestOutput = "";
			let lastUpdate = 0;
			let updateTimer: ReturnType<typeof setTimeout> | undefined;
			const progressWidgetId = "pi-ipython-rlm-progress";
			const progress = (message: string) => {
				transcript?.note(message);
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
				lastUpdate = Date.now();
				const status = message.startsWith("Starting") || message.startsWith("Provisioning") ? "starting" : "running";
				const text = latestOutput ? `${message}\n\n${partialText(latestOutput)}` : message;
				if (ctx.mode === "tui") ctx.ui.setWidget(progressWidgetId, [`RLM: ${message}`]);
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
				execution = await kernel.execute(
					toolCallId,
					params.code,
					{
						cwd: ctx.cwd,
						model: ctx.model,
						thinkingLevel: ctx.thinkingLevel ?? "off",
					},
					signal,
					progress,
					output,
				);
			} catch (error) {
				transcript?.finish(`error: ${String(error)}`);
				throw error;
			} finally {
				if (updateTimer) clearTimeout(updateTimer);
				if (ctx.mode === "tui") ctx.ui.setWidget(progressWidgetId, undefined);
			}
			const { result, kernelReset } = execution;
			const host = result.host;
			transcript?.output(result.output);
			if (kernelReset) transcript?.note(RESET_NOTICE);
			if (host.hasFinal) transcript?.note(`RLM final: ${renderFinal(host.finalValue)}`);
			if (result.status !== "ok" && !result.output) {
				transcript?.note([result.error?.ename, result.error?.evalue].filter(Boolean).join(": "));
			}
			transcript?.finish(`${result.status}${result.executionCount === undefined ? "" : ` | In [${result.executionCount}]`}`);
			const formatted = await finalText(result.output);
			let visible = formatted.text;
			if (kernelReset) {
				visible = formatted.text === "[no output]" ? RESET_NOTICE : `${RESET_NOTICE}\n\n${formatted.text}`;
			}
			if (host.hasFinal) {
				const finalValue = `[RLM final — terminating]\n${renderFinal(host.finalValue)}`;
				visible = visible === "[no output]" ? finalValue : `${visible}\n\n${finalValue}`;
			}
			const details: IpythonDetails = {
				status: result.status === "ok" ? "ok" : "error",
				executionCount: result.executionCount,
				kernelReset,
				truncated: formatted.truncated,
				fullOutputPath: formatted.fullOutputPath,
				final: host.hasFinal ? host.finalValue : undefined,
				nestedUsage: hasUsage(host.usage) ? host.usage : undefined,
				children: { spawned: host.spawned, gathered: host.gathered },
			};

			if (result.status !== "ok") {
				const fallback = [result.error?.ename, result.error?.evalue].filter(Boolean).join(": ");
				if (visible === "[no output]" && fallback) visible = fallback;
			}
			return {
				content: [{ type: "text", text: visible }],
				details,
				usage: hasUsage(host.usage) ? host.usage : undefined,
				terminate: (result.status === "ok" && host.hasFinal) || undefined,
			};
		},
	});

	// Mark failed cells without throwing away their result and child usage.
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

export {
	BRIDGE_PROTOCOL_VERSION,
	HOST_PROTOCOL_VERSION,
	MAX_CHILD_REQUEST_BYTES,
	MAX_HOST_RESPONSE_BYTES,
};
