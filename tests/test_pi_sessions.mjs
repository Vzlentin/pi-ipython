import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import ipythonExtension from "../extensions/ipython.ts";
import { createExtensionHarness, preserveEnvironment } from "./helpers.mjs";

const NAMES = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"];

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-ipython-sessions-")));
const agentDir = join(root, "agent");
const restoreEnvironment = preserveEnvironment("XDG_CACHE_HOME", "PI_IPYTHON_PERSISTENCE", "PI_OFFLINE", ...NAMES);

process.env.XDG_CACHE_HOME = join(root, "cache");

process.env.PI_OFFLINE = "1";

delete process.env.PI_IPYTHON_PERSISTENCE;

// Values that Pi's own process inherited from an older session, as after a resume in the same terminal.
Object.assign(process.env, {
	PI_SESSION_ID: "stale-id",
	PI_SESSION_FILE: "/stale/older.jsonl",
	PI_PROVIDER: "stale-provider",
	PI_MODEL: "stale-model",
	PI_REASONING_LEVEL: "stale-level",
});

/** Python that prints the `PI_*` variables of the kernel as JSON. */
const PRINT_ENVIRONMENT = `import json, os\nprint(json.dumps({name: os.environ.get(name) for name in ${JSON.stringify(NAMES)}}))`;

/** The `PI_*` values that Pi's bash tool gives a command in `session`. */
const bashEnvironment = (session) => ({
	PI_SESSION_ID: session.sessionManager.getSessionId(),
	PI_SESSION_FILE: session.sessionManager.getSessionFile() ?? null,
	PI_PROVIDER: session.model?.provider ?? null,
	PI_MODEL: session.model?.id ?? null,
	PI_REASONING_LEVEL: session.thinkingLevel || null,
});

/** The JSON object that a cell printed. */
const printed = (text) => JSON.parse(text.split("\n").find((line) => line.startsWith("{")));

const faux = fauxProvider({ models: [{ id: "model" }] });
const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });

modelRuntime.registerNativeProvider(faux.provider);

const settingsManager = SettingsManager.inMemory();

const runtime = await createAgentSessionRuntime(
	async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			modelRuntime,
			resourceLoaderOptions: {
				extensionFactories: [ipythonExtension],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});

		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: faux.getModel(),
			tools: ["ipython"],
		});

		return { ...created, services, diagnostics: services.diagnostics };
	},
	{ cwd: root, agentDir, sessionManager: SessionManager.create(root, join(root, "sessions")) },
);

/** Lets the model run the environment cell once in the current session, and returns what the kernel printed. */
async function kernelEnvironment() {
	const { session } = runtime;

	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("ipython", { code: PRINT_ENVIRONMENT })),
		fauxAssistantMessage("done"),
	]);
	await session.prompt("run it");

	const result = session.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
		.at(-1).message;

	assert.equal(result.isError, false);

	return printed(result.content.map((block) => block.text ?? "").join("\n"));
}

try {
	// The first cell of a session sees that session's values, as bash does, not the ones Pi inherited.
	const first = await kernelEnvironment();
	assert.equal(first.PI_SESSION_FILE, runtime.session.sessionFile);
	assert.deepEqual(first, bashEnvironment(runtime.session));

	// A new session starts a new kernel with the new session's values.
	assert.equal((await runtime.newSession()).cancelled, false);
	const second = await kernelEnvironment();
	assert.notEqual(second.PI_SESSION_ID, first.PI_SESSION_ID);
	assert.notEqual(second.PI_SESSION_FILE, first.PI_SESSION_FILE);
	assert.equal(second.PI_SESSION_FILE, runtime.session.sessionFile);
	assert.deepEqual(second, bashEnvironment(runtime.session));
} finally {
	await runtime.dispose();
}

// A session without a file, model or thinking level removes the inherited values, as bash does.
const memory = SessionManager.inMemory(root);
const extension = createExtensionHarness({ root, sessionManager: memory });

try {
	const values = printed((await extension.cell(PRINT_ENVIRONMENT)).text);
	assert.deepEqual(values, {
		PI_SESSION_ID: memory.getSessionId(),
		PI_SESSION_FILE: null,
		PI_PROVIDER: null,
		PI_MODEL: null,
		PI_REASONING_LEVEL: null,
	});
} finally {
	await extension.shutdown("quit");
	restoreEnvironment();
	rmSync(root, { recursive: true, force: true });
}

console.log("pi sessions: the kernel gets the PI_* values of each session, and removes the inherited ones");
