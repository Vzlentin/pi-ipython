import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import ipythonExtension from "../extensions/ipython.ts";
import { preserveEnvironment, waitFor } from "./helpers.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-ipython-events-")));
const agentDir = join(root, "agent");
const restoreEnvironment = preserveEnvironment("XDG_CACHE_HOME", "PI_IPYTHON_PERSISTENCE", "PI_OFFLINE");

process.env.XDG_CACHE_HOME = join(root, "cache");

process.env.PI_OFFLINE = "1";

delete process.env.PI_IPYTHON_PERSISTENCE;

/** `[event, toolCallId, marker file exists]` for every ipython event on Pi's bus, and when the nested call settles, in order. */
const seen = [];

/** The file that each cell writes when it runs. A listener checks it to see if the cell ran yet. */
const ranMarker = join(root, "ran");

/**
 * When set, the next cell-start listener runs the `marker` tool through the ctx.
 * When the call settles, the listener writes the text of its result to this file, and the cell waits for the file.
 */
let toolMarker;

/** The outcome of the tool call that the cell-start listener made through the ctx. */
let nestedCall;

/** The text blocks of a tool result, joined. */
const text = (result) => result.content.map((block) => block.text ?? "").join("\n");

/** A listener extension, as a host such as harness registers it. */
const listener = (pi) => {
	pi.registerTool({
		name: "marker",
		label: "Marker",
		description: "Returns a text that names the path",
		parameters: Type.Object({ path: Type.String() }),
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: `marker wrote ${params.path}` }], details: {} };
		},
	});

	pi.events.on("ipython:cell-start", ({ toolCallId, ctx }) => {
		seen.push(["start", toolCallId, existsSync(ranMarker)]);

		if (toolMarker) {
			const path = toolMarker;
			toolMarker = undefined;
			nestedCall = ctx.executeTool("marker", { path }).then((outcome) => {
				seen.push(["settled", toolCallId, existsSync(ranMarker)]);
				writeFileSync(path, text(outcome.result));

				return outcome;
			});
		}
	});

	pi.events.on("ipython:cell-end", ({ toolCallId }) => seen.push(["end", toolCallId, existsSync(ranMarker)]));
};

const faux = fauxProvider({ models: [{ id: "model" }] });
const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });

modelRuntime.registerNativeProvider(faux.provider);

const settingsManager = SettingsManager.inMemory();

const resourceLoader = new DefaultResourceLoader({
	cwd: root,
	agentDir,
	settingsManager,
	extensionFactories: [ipythonExtension, listener],
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});

await resourceLoader.reload();

const sessionManager = SessionManager.inMemory(root);

const { session } = await createAgentSession({
	cwd: root,
	agentDir,
	modelRuntime,
	model: faux.getModel(),
	settingsManager,
	resourceLoader,
	sessionManager,
	tools: ["ipython", "marker"],
});

/** Python that writes the ran marker first, then runs `code`. */
const cell = (code) => `open(${JSON.stringify(ranMarker)}, "w").close()\n${code}`;

/** The tool results of ipython calls on the branch, oldest first. */
const ipythonResults = () =>
	sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
		.map((entry) => entry.message)
		.filter((message) => message.toolName === "ipython");

/** Lets the model call ipython once with `code`, then answer, and returns the new events and the result. */
async function turn(code, { whileRunning } = {}) {
	rmSync(ranMarker, { force: true });
	seen.length = 0;
	const before = ipythonResults().length;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("ipython", { code: cell(code) })),
		fauxAssistantMessage("done"),
	]);
	const prompt = session.prompt("run it");
	await whileRunning?.();
	await prompt;
	const results = ipythonResults();
	assert.equal(results.length, before + 1, "the turn ran one ipython call");

	return { events: [...seen], result: results.at(-1) };
}

try {
	// A cell gives one start before it runs and one end after it ran, both with the call's ID.
	const ok = await turn("print(40 + 2)");
	assert.equal(ok.result.isError, false);
	assert.match(text(ok.result), /42/);
	assert.deepEqual(ok.events, [
		["start", ok.result.toolCallId, false],
		["end", ok.result.toolCallId, true],
	]);

	// A Python exception still ends the cell.
	const raised = await turn("raise ValueError('boom')");
	assert.equal(raised.result.isError, true);
	assert.match(text(raised.result), /ValueError: boom/);
	assert.deepEqual(raised.events, [
		["start", raised.result.toolCallId, false],
		["end", raised.result.toolCallId, true],
	]);

	// An abort during the cell ends it, and the next cell runs on the same kernel.
	const aborted = await turn("import time\nkept = 7\ntime.sleep(60)", {
		whileRunning: async () => {
			await waitFor(() => existsSync(ranMarker), 60_000);
			await session.abort();
		},
	});

	assert.deepEqual(
		aborted.events.map(([name, id]) => [name, id]),
		[
			["start", aborted.result.toolCallId],
			["end", aborted.result.toolCallId],
		],
	);
	const recovered = await turn("print(kept * 6)");
	assert.equal(recovered.result.isError, false);
	assert.match(text(recovered.result), /42/);
	assert.deepEqual(recovered.events, [
		["start", recovered.result.toolCallId, false],
		["end", recovered.result.toolCallId, true],
	]);

	// A listener runs another tool through the ctx of cell-start while the cell runs.
	const toolPath = join(root, "tool-marker");
	toolMarker = toolPath;

	const nested = await turn(
		[
			"import os, time",
			"deadline = time.monotonic() + 30",
			`while not os.path.exists(${JSON.stringify(toolPath)}) and time.monotonic() < deadline:`,
			"    time.sleep(0.05)",
			`print(open(${JSON.stringify(toolPath)}).read())`,
		].join("\n"),
	);

	assert.equal(nested.result.isError, false, text(nested.result));
	assert.ok(text(nested.result).includes(`marker wrote ${toolPath}`), text(nested.result));
	assert.deepEqual(
		nested.events.map(([name, id]) => [name, id]),
		[
			["start", nested.result.toolCallId],
			["settled", nested.result.toolCallId],
			["end", nested.result.toolCallId],
		],
	);

	const outcome = await nestedCall;
	assert.equal(outcome.isError, false, text(outcome.result));
	assert.equal(outcome.toolCall.name, "marker");
	assert.equal(text(outcome.result), `marker wrote ${toolPath}`);
} finally {
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
	restoreEnvironment();
	rmSync(root, { recursive: true, force: true });
}

console.log("pi events: cell-start and cell-end around ok, raised and aborted cells, and a tool run through ctx");
