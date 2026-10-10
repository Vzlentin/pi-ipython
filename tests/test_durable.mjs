import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as ai from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as durable from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import ipython from "../durable/index.ts";
import { preserveEnvironment } from "./helpers.mjs";

const context = BACKGROUND_CONTEXT;
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-ipython-durable-")));
const restoreEnvironment = preserveEnvironment("XDG_CACHE_HOME", "PI_IPYTHON_PERSISTENCE");
process.env.XDG_CACHE_HOME = join(root, "cache");
delete process.env.PI_IPYTHON_PERSISTENCE;

const faux = fauxProvider({ models: [{ id: "model" }] });
const models = createModels();
models.setProvider(faux.provider);
const store = join(root, "session.sqlite");
let turns = 0;
/** `[event name, conversation ID]` for every ipython event on the host bus, in order. */
const seen = [];
/** When set, the next cell-start listener commits a task-owned conversation and then writes this file. */
let commitMarker;
/** The result of the last ipython call that the `caller` tool made through `executeTool`. */
let nested;

const caller = durable.defineTool({
	name: "caller",
	description: "Runs code through the ipython tool",
	parameters: ai.Type.Object({ code: ai.Type.String() }),
	async execute(args, api, context) {
		nested = await api.executeTool("ipython", { code: args.code }, context);
		return { output: [{ type: "text", text: "called" }] };
	},
});

/** A host process: a Harness over the store, with the ipython extension installed from its pi-durable entry. */
async function openHost() {
	const events = new EventEmitter();
	for (const name of ["ipython:cell-start", "ipython:cell-end", "ipython:kernel-starting"]) {
		events.on(name, (data) => seen.push([name, String(data.conversationId)]));
	}
	events.on("ipython:cell-start", ({ api, context }) => {
		const marker = commitMarker;
		if (marker === undefined) return;
		commitMarker = undefined;
		api.commit((tx) => tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } }), context)
			.then(() => writeFileSync(marker, ""), (error) => console.error("commit from cell-start failed:", error));
	});
	const tool = ipython({ durable, ai, events });
	const registry = durable.createRegistry();
	for (const extension of tool.extensions) registry.install(extension);
	registry.install(durable.defineExtension({ name: "caller", tools: [caller] }));
	const harness = await durable.Harness.open(await openNodeSqliteStorage(store), { models, registry }, context);
	const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "model" }, cwd: root } });
	return {
		conversation,
		async close() {
			try {
				await harness.close(context);
			} finally {
				await tool.close();
			}
		},
	};
}

/** The events of one turn, which must be exactly a start and an end for `id`. */
function assertPaired(from, id) {
	assert.deepEqual(seen.slice(from), [["ipython:cell-start", id], ["ipython:cell-end", id]]);
}

/** One model turn that runs `code` as a call of `tool`; returns the call's result as the model saw it. */
async function cell(conversation, code, tool = "ipython") {
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall(tool, { code }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	turns += 1;
	const submission = await conversation.submit({ type: "input", content: `turn ${turns}`, requestId: `turn-${turns}` }, context);
	const settled = await submission.wait(context);
	assert.equal(settled.status, "done", `turn ${turns} was not answered: ${settled.reason ?? ""}`);
	const page = await conversation.entries({}, 20, undefined, context);
	const entry = page.items.find((item) => durable.ToolResultEntry.is(item));
	assert.ok(entry, `turn ${turns} has no tool result`);
	const message = entry.model[0];
	const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	return { text, isError: message.isError === true, entryId: entry.id };
}

try {
	let host = await openHost();
	try {
		const id = String(host.conversation.id);
		let from = seen.length;
		const first = await cell(host.conversation, "x = 41");
		assert.equal(first.isError, false, first.text);
		assert.deepEqual(seen.slice(from), [
			["ipython:cell-start", id],
			["ipython:kernel-starting", id],
			["ipython:cell-end", id],
		], "cell-start comes before the kernel exists, and kernel-starting names the conversation");

		const marker = join(root, "committed");
		commitMarker = marker;
		from = seen.length;
		const poll = `import os, time\nfor _ in range(500):\n    if os.path.exists(${JSON.stringify(marker)}): break\n    time.sleep(0.01)\nprint(x + 1)\nprint(os.path.exists(${JSON.stringify(marker)}))`;
		const reuse = await cell(host.conversation, poll);
		assert.match(reuse.text, /^42$/m, "state carries across cells of one conversation");
		assert.doesNotMatch(reuse.text, /ipython_state_restored/, "a live kernel on the same branch needs no restore");
		assert.match(reuse.text, /^True$/m, "the api from cell-start commits a task-owned conversation while the cell runs");
		assertPaired(from, id);

		from = seen.length;
		const exception = await cell(host.conversation, "raise ValueError('bad input')");
		assert.equal(exception.isError, true);
		assert.match(exception.text, /ValueError/);
		assertPaired(from, id);

		from = seen.length;
		const crash = await cell(host.conversation, "import os; os._exit(17)");
		assert.equal(crash.isError, true, "a lost kernel is an error result");
		assert.match(crash.text, /kernel state was lost/);
		assertPaired(from, id);

		from = seen.length;
		const recovered = await cell(host.conversation, "print(x)");
		assert.ok(seen.slice(from).some((event) => event[0] === "ipython:kernel-starting" && event[1] === id), "the restarted kernel names the conversation");
		assert.equal(recovered.isError, false, recovered.text);
		assert.match(recovered.text, /<ipython_kernel_reset>/, "the next cell reports the lost kernel");
		assert.match(recovered.text, /<ipython_state_restored>/, "the next cell restores the checkpoint");
		assert.match(recovered.text, /^41$/m);
	} finally {
		await host.close();
	}

	// A new process on the same store finds the checkpoints through the conversation's entries.
	host = await openHost();
	try {
		const reopened = await cell(host.conversation, "print(x * 2)");
		assert.equal(reopened.isError, false, reopened.text);
		assert.match(reopened.text, /<ipython_state_restored>/);
		assert.match(reopened.text, /^82$/m);

		const before = await cell(host.conversation, "x = 7");
		await cell(host.conversation, "x = 8");
		const fork = await host.conversation.fork(before.entryId, { ownership: { kind: "ownerless" } }, context);
		const from = seen.length;
		const forked = await cell(fork, "print(x)");
		assert.deepEqual(seen.slice(from), [
			["ipython:cell-start", String(fork.id)],
			["ipython:kernel-starting", String(fork.id)],
			["ipython:cell-end", String(fork.id)],
		], "a fork's kernel names the fork");
		assert.match(forked.text, /<ipython_state_restored>/, "a fork restores its own history");
		assert.match(forked.text, /^7$/m, "the fork sees the state at its fork entry");

		const main = await cell(host.conversation, "print(x)");
		assert.match(main.text, /^8$/m, "the parent keeps its own state");

		const long = await cell(host.conversation, "for i in range(3000): print(f'line {i}')");
		assert.equal(long.isError, false, long.text);
		assert.match(long.text, /^line 2999$/m, "long output keeps its end");
		assert.doesNotMatch(long.text, /^line 999$/m, "long output loses its start");
		const saved = long.text.match(/\[info\] \[Output truncated: showing the last 2000 of 3000 lines.*Full output saved to: ([^\]]+)\]/);
		assert.ok(saved, "a diagnostic names the file with the full output");
		assert.equal(readFileSync(saved[1], "utf8").trimEnd().split("\n").length, 3000);
		assert.doesNotMatch(long.text, /Output truncated to its end/, "the harness does not cut the tail again");

		await cell(host.conversation, "print(6 * 7)", "caller");
		assert.equal(nested.isError, false, JSON.stringify(nested));
		assert.equal(nested.structuredOutput.status, "ok");
		assert.equal(nested.structuredOutput.output, "42\n", "a tool gets the CellResult of a nested cell");

		await cell(host.conversation, "raise ValueError('bad')", "caller");
		assert.equal(nested.isError, true, JSON.stringify(nested));
		assert.equal(nested.structuredOutput.status, "error");
		assert.equal(nested.structuredOutput.error.ename, "ValueError", "a nested exception is data in the CellResult");
	} finally {
		await host.close();
	}

	console.log("durable: cells, exceptions, kernel crash, host bus events, reopened store, forks, long output and nested calls passed");
} finally {
	restoreEnvironment();
	rmSync(root, { recursive: true, force: true });
}
