/**
 * Text of cell output. The limits and the tail truncation are the ones Pi's own tools use (`truncateTail` and
 * `formatSize` in pi-coding-agent). They are copied here because the pi-durable adapter runs in hosts that do not
 * load pi-coding-agent.
 */

export const OUTPUT_MAX_LINES = 2000;
export const OUTPUT_MAX_BYTES = 50 * 1024;

export function stripAnsi(value: string): string {
	return value.replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|[@-_][0-?]*[ -/]*[@-~])/g, "");
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export interface Tail {
	content: string;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
}

/** The last `OUTPUT_MAX_LINES` lines that fit in `OUTPUT_MAX_BYTES`; a last line that alone is too long keeps its end. */
export function truncateTail(content: string): Tail {
	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.length === 0 ? [] : content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	const totalLines = lines.length;
	if (totalLines <= OUTPUT_MAX_LINES && totalBytes <= OUTPUT_MAX_BYTES) {
		return { content, truncated: false, totalLines, totalBytes, outputLines: totalLines, outputBytes: totalBytes };
	}
	const kept: string[] = [];
	let keptBytes = 0;
	for (let index = lines.length - 1; index >= 0 && kept.length < OUTPUT_MAX_LINES; index--) {
		const line = lines[index];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0);
		if (keptBytes + lineBytes > OUTPUT_MAX_BYTES) {
			if (kept.length === 0) kept.unshift(endOfLine(line, OUTPUT_MAX_BYTES));
			break;
		}
		kept.unshift(line);
		keptBytes += lineBytes;
	}
	const tail = kept.join("\n");
	return {
		content: tail,
		truncated: true,
		totalLines,
		totalBytes,
		outputLines: kept.length,
		outputBytes: Buffer.byteLength(tail, "utf-8"),
	};
}

/** The end of `line` within `maxBytes`, starting on a UTF-8 character boundary. */
function endOfLine(line: string, maxBytes: number): string {
	const bytes = Buffer.from(line, "utf-8");
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf-8");
}

/** Running output for progress updates. */
export function partialText(output: string): string {
	const tail = truncateTail(stripAnsi(output));
	if (!tail.truncated) return tail.content || "[no output yet]";
	return `[Live output truncated; showing the tail]\n${tail.content}`;
}

/**
 * Final output of a cell: its tail, and for truncated output a header that names the file where `save` stored the full
 * text.
 */
export function finalOutput(output: string, save: (text: string) => string): {
	output: string;
	truncated: boolean;
	header?: string;
	fullOutputPath?: string;
} {
	const clean = stripAnsi(output);
	const tail = truncateTail(clean);
	if (!tail.truncated) return { output: tail.content, truncated: false };

	const fullOutputPath = save(clean);
	const header = [
		`[Output truncated: showing the last ${tail.outputLines} of ${tail.totalLines} lines`,
		`(${formatSize(tail.outputBytes)} of ${formatSize(tail.totalBytes)}).`,
		`${tail.totalLines - tail.outputLines} lines (${formatSize(tail.totalBytes - tail.outputBytes)}) omitted.`,
		`Full output saved to: ${fullOutputPath}]`,
	].join(" ");
	return { output: tail.content, truncated: true, header, fullOutputPath };
}
