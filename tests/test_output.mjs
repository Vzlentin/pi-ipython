import assert from "node:assert/strict";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize as piFormatSize,
	truncateTail as piTruncateTail,
} from "@earendil-works/pi-coding-agent";
import { formatSize, OUTPUT_MAX_BYTES, OUTPUT_MAX_LINES, truncateTail } from "../extensions/output.ts";

// output.ts copies Pi's truncation so that hosts without pi-coding-agent can use it. Both must cut output the same way.
assert.equal(OUTPUT_MAX_LINES, DEFAULT_MAX_LINES);
assert.equal(OUTPUT_MAX_BYTES, DEFAULT_MAX_BYTES);

const lines = (count, text = "line") => Array.from({ length: count }, (_, index) => `${text} ${index}`).join("\n");
const exactBytes = "x".repeat(DEFAULT_MAX_BYTES);
const cases = {
	empty: "",
	"one line": "hello",
	"final newline": "a\nb\n",
	"blank lines": "\n\n\n",
	"lines at the limit": lines(DEFAULT_MAX_LINES),
	"lines at the limit, final newline": `${lines(DEFAULT_MAX_LINES)}\n`,
	"one line over the limit": lines(DEFAULT_MAX_LINES + 1),
	"far over the line limit": lines(DEFAULT_MAX_LINES * 3),
	"bytes at the limit": exactBytes,
	"one byte over the limit": `${exactBytes}x`,
	"last two lines fill the limit exactly": ["c".repeat(10), "b".repeat(1000), "a".repeat(DEFAULT_MAX_BYTES - 1001)].join("\n"),
	"last two lines one byte over the limit": ["c".repeat(10), "b".repeat(1000), "a".repeat(DEFAULT_MAX_BYTES - 1000)].join("\n"),
	// The byte limit is a multiple of 2 and 4, so these cuts start inside a character, counted from the end.
	"cut inside a three-byte character": "€".repeat(DEFAULT_MAX_BYTES),
	"cut inside a four-byte character": `${"😀".repeat(100)}${"x".repeat(DEFAULT_MAX_BYTES - 1)}`,
	"one long line": "y".repeat(DEFAULT_MAX_BYTES * 2),
	"long last line after short ones": `short\n${"z".repeat(DEFAULT_MAX_BYTES + 10)}`,
	"two-byte characters at the cut": "é".repeat(DEFAULT_MAX_BYTES),
	"four-byte characters at the cut": "😀".repeat(DEFAULT_MAX_BYTES / 2 + 1),
	"multi-byte lines over the byte limit": lines(3000, "ünïcödé text with 😀"),
	"carriage returns": lines(2500).replaceAll("\n", "\r\n"),
};

for (const [name, content] of Object.entries(cases)) {
	const expected = piTruncateTail(content);
	const actual = truncateTail(content);
	for (const field of ["content", "truncated", "totalLines", "totalBytes", "outputLines", "outputBytes"]) {
		assert.equal(actual[field], expected[field], `${name}: ${field} differs from Pi's truncateTail`);
	}
}

for (const bytes of [0, 1, 1023, 1024, 1025, 50 * 1024, 1024 * 1024 - 1, 1024 * 1024, 5 * 1024 * 1024 + 7]) {
	assert.equal(formatSize(bytes), piFormatSize(bytes), `formatSize(${bytes})`);
}

console.log("output: truncation and sizes match Pi's on edge cases");
