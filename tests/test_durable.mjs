import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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

/** A host process: a Harness over the store, with the ipython extension installed from its pi-durable entry. */
async function openHost() {
	const tool = ipython({ durable, ai, events: new EventEmitter() });
	const registry = durable.createRegistry();
	for (const extension of tool.extensions) registry.install(extension);
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

/** One model turn that runs `code` as an ipython call; returns the call's result as the model saw it. */
async function cell(conversation, code) {
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("ipython", { code }), { stopReason: "toolUse" }),
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
		const first = await cell(host.conversation, "x = 41");
		assert.equal(first.isError, false, first.text);

		const reuse = await cell(host.conversation, "print(x + 1)");
		assert.match(reuse.text, /^42$/m, "state carries across cells of one conversation");
		assert.doesNotMatch(reuse.text, /ipython_state_restored/, "a live kernel on the same branch needs no restore");

		const exception = await cell(host.conversation, "raise ValueError('bad input')");
		assert.equal(exception.isError, true);
		assert.match(exception.text, /ValueError/);

		const crash = await cell(host.conversation, "import os; os._exit(17)");
		assert.equal(crash.isError, true, "a lost kernel is an error result");
		assert.match(crash.text, /kernel state was lost/);

		const recovered = await cell(host.conversation, "print(x)");
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
		const forked = await cell(fork, "print(x)");
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
	} finally {
		await host.close();
	}

	console.log("durable: cells, exceptions, kernel crash, reopened store, forks and long output passed");
} finally {
	restoreEnvironment();
	rmSync(root, { recursive: true, force: true });
}
