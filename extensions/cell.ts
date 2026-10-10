/**
 * What the Pi and pi-durable adapters share about one `ipython` call: the description, the reset notice, and the cell's
 * result as data. Each adapter builds the text its host shows from that data.
 */
import { type BridgeResult, INTERRUPT_GRACE_MS, OUTPUT_CAPTURE_LIMIT_BYTES } from "./kernel-runtime.ts";
import { finalOutput, formatSize, OUTPUT_MAX_BYTES, OUTPUT_MAX_LINES } from "./output.ts";

export const RESET_NOTICE = [
	"<ipython_kernel_reset>",
	"The IPython kernel stopped. All in-memory variables, imports, tasks, and open resources from the previous kernel were lost; recreate them before continuing.",
	"</ipython_kernel_reset>",
].join("\n");

/** The description in both hosts. Pi adds a paragraph on what codemode scripts receive. */
export const DESCRIPTION = [
	"Execute Python in a persistent IPython kernel. Reuse variables, functions, datasets, and intermediate results across calls. Supports top-level await and native IPython magics. Checkpointed state follows the conversation branch; reloads and crashes restore the latest saved cell on that branch. Live resources, process state, and files are not rewound. The kernel runs with local user permissions, including filesystem and network access; it is not sandboxed.",
	"ipython is your persistent control environment, not the native runtime of the project. Run project code, tests, and CLIs through the project's own interface (documented commands, `uv run ...`, `.venv/bin/python ...`) and treat their result as the relevant result. Do not install project dependencies into the kernel.",
	"Kernel state persists across cells and checkpointed names survive resets and reloads. Keep reusable functions, datasets, read/search results, and intermediate computations in named variables. Save valuable results to explicit artifacts for recovery.",
	"Use Python for loops, parsing, and state. Use the shell only to invoke programs.",
	`Output is truncated to ${OUTPUT_MAX_LINES} lines or ${formatSize(OUTPUT_MAX_BYTES)}; full truncated output is saved to a temporary file. Runaway cells exceeding ${formatSize(OUTPUT_CAPTURE_LIMIT_BYTES)} of output are interrupted; the kernel is killed only if it does not stop within ${INTERRUPT_GRACE_MS / 1000} seconds.`,
].join("\n\n");

/** A cell's result as data, as scripts that call the tool receive it. Pi's `outputSchema` declares this shape. */
export type CellResult = {
	status: "ok" | "error";
	/** The tail of the output, without ANSI codes. */
	output: string;
	truncated: boolean;
	/** Kernel resets and checkpoint restores that happened before the cell ran. */
	notices: string[];
	executionCount?: number;
	error?: { ename: string; evalue: string };
	fullOutputPath?: string;
};

/**
 * The result of a cell that ran, with the restores before it in `notices`; a reset kernel adds its notice in front.
 * `header` is the line that tells the model the output was truncated and where `save` stored all of it.
 */
export function cellResult(
	execution: { result: BridgeResult; kernelReset: boolean },
	notices: string[],
	save: (text: string) => string,
): { data: CellResult; header?: string } {
	const { result, kernelReset } = execution;
	const final = finalOutput(result.output, save);
	const data: CellResult = {
		status: result.status === "ok" ? "ok" : "error",
		output: final.output,
		truncated: final.truncated,
		notices: kernelReset ? [RESET_NOTICE, ...notices] : notices,
	};
	// Absent fields stay absent, so scripts receive strict JSON.
	if (result.executionCount !== undefined) data.executionCount = result.executionCount;
	if (data.status === "error") data.error = { ename: result.error?.ename ?? "Error", evalue: result.error?.evalue ?? "" };
	if (final.fullOutputPath !== undefined) data.fullOutputPath = final.fullOutputPath;
	return { data, header: final.header };
}
