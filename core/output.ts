/**
 * Text of cell output. The limits and the tail truncation are the ones Pi's own tools use (`truncateTail` and
 * `formatSize` in pi-coding-agent). They are copied here because the pi-durable adapter runs in hosts that do not
 * load pi-coding-agent.
 */

export const OUTPUT_MAX_LINES = 2000;
export const OUTPUT_MAX_BYTES = 50 * 1024;

const ESC = "\x1b";
const BEL = "\x07";

/** Removes OSC sequences up to BEL or ESC \, and ESC sequences with parameter, intermediate and final bytes. */
export function stripAnsi(value: string): string {
	let result = "";
	let kept = 0;
	let index = value.indexOf(ESC);

	while (index !== -1) {
		const end = escapeSequenceEnd(value, index);

		if (end === undefined) {
			index = value.indexOf(ESC, index + 1);
		} else {
			result += value.slice(kept, index);
			kept = end;
			index = value.indexOf(ESC, end);
		}
	}

	return result + value.slice(kept);
}

/** The index after the sequence that starts with the ESC at `start`, or undefined if it is not a sequence. */
function escapeSequenceEnd(value: string, start: number): number | undefined {
	if (value[start + 1] === "]") {
		// An OSC ends at the first BEL. Without one, it ends at the last ESC \.
		const bell = value.indexOf(BEL, start + 2);

		if (bell !== -1) return bell + 1;
		const terminator = value.lastIndexOf(`${ESC}\\`);

		if (terminator >= start + 2) return terminator + 2;
	}

	if (!inRange(value.charCodeAt(start + 1), 0x40, 0x5f)) return undefined;
	let end = start + 2;

	while (inRange(value.charCodeAt(end), 0x30, 0x3f)) end++;

	while (inRange(value.charCodeAt(end), 0x20, 0x2f)) end++;

	return inRange(value.charCodeAt(end), 0x40, 0x7e) ? end + 1 : undefined;
}

function inRange(code: number, low: number, high: number): boolean {
	return code >= low && code <= high;
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

export interface FinalOutput {
	output: string;
	truncated: boolean;
	header?: string;
	fullOutputPath?: string;
}

/**
 * Final output of a cell: its tail, and for truncated output a header that names the file where `save` stored the full
 * text.
 */
export function finalOutput(output: string, save: (text: string) => string): FinalOutput {
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
