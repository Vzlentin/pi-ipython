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
	"ipython is your workspace for data in memory: load it, parse it, count it, compare it, and keep the results. It is not the native runtime of the project. Do not install project dependencies into the kernel.",
	"Write and edit files with the write and edit tools, and run commands, tests and searches with bash. Never do these jobs from Python. hs.sauve only writes data that the kernel computed.",
	"Kernel state persists across cells, and checkpointed names survive resets and reloads. Keep datasets and intermediate results in named variables. Save valuable data with hs.sauve for recovery.",
	[
		"hs is headstart, the agent toolkit of this kernel. Version 1: data verbs on pandas, with French names. Do not use hs as a variable.",
		"hs.charge(path, sheet=None) -> DataFrame         load jsonl, csv, json, xlsx, xlsm, xls, xlsb, ods; codes keep their zeros; skips bad jsonl lines",
		"hs.sauve(path, data) -> Path                     save json, jsonl, csv, xlsx, no index; only data that the kernel computed, never text",
		"hs.montre(x, n=40) -> x                          show a bounded view of any value; as the last line of a cell, it prints once",
		"hs.combien(df, key, *keys, n=20) -> DataFrame    count the most common values of the keys, with n and share; keeps missing values",
		"hs.compare(a, b, key) -> DataFrame               compare: one row for each key that differs, only a, only b, or changed",
		"Each verb also takes records, a list[dict]. toml and other json load as plain values.",
		"For xlsx, a dict of DataFrames saves one sheet per key. pandas, numpy and every Excel engine are installed.",
	].join("\n"),
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

export interface CellReport {
	data: CellResult;
	header?: string;
}

/**
 * The result of a cell that ran, with the restores before it in `notices`; a reset kernel adds its notice in front.
 * `header` is the line that tells the model the output was truncated and where `save` stored all of it.
 */
export function cellResult(
	execution: { result: BridgeResult; kernelReset: boolean },
	notices: string[],
	save: (text: string) => string,
): CellReport {
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

	if (data.status === "error")
		data.error = { ename: result.error?.ename ?? "Error", evalue: result.error?.evalue ?? "" };

	if (final.fullOutputPath !== undefined) data.fullOutputPath = final.fullOutputPath;

	return { data, header: final.header };
}
