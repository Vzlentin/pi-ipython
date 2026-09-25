import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import ipythonExtension from "../extensions/ipython.ts";
import { KernelRuntime } from "../extensions/kernel-runtime.ts";

const execFileAsync = promisify(execFile);
let toolIndex = 0;
let kernelIndex = 0;

export async function execShim(command, args, options) {
	try {
		return { ...await execFileAsync(command, args, options), code: 0 };
	} catch (error) {
		return { code: error.code ?? 1, stderr: error.stderr ?? error.message, stdout: error.stdout ?? "" };
	}
}

export function preserveEnvironment(...names) {
	const saved = new Map(names.map((name) => [name, process.env[name]]));
	return () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

export async function waitFor(condition, timeout = 10_000) {
	const deadline = Date.now() + timeout;
	while (!condition()) {
		assert.ok(Date.now() < deadline, "timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

export function createKernel(startup) {
	const bus = new EventEmitter();
	if (startup) bus.on("ipython:kernel-starting", startup);
	const kernel = new KernelRuntime({
		events: { emit: (name, data) => bus.emit(name, data) },
		exec: execShim,
	});
	return kernel;
}

export function runKernel(kernel, code, cwd, options = {}) {
	return kernel.execute(
		`kernel-${++kernelIndex}`, code, cwd, options.signal,
		options.onProgress ?? (() => {}), options.onOutput ?? (() => {}),
	);
}

export function createExtensionHarness({ root, sessionManager, startup } = {}) {
	const handlers = new Map();
	const bus = new EventEmitter();
	if (startup) bus.on("ipython:kernel-starting", startup);
	let tool;
	const ctx = {
		cwd: root,
		sessionManager,
		mode: "json",
		hasUI: false,
		signal: undefined,
		ui: { notify() {}, setWidget() {} },
	};
	ipythonExtension({
		events: { emit: (name, data) => bus.emit(name, data) },
		on(name, handler) { handlers.set(name, handler); },
		appendEntry(name, data) { return sessionManager.appendCustomEntry(name, data); },
		registerTool(definition) { tool = definition; },
		registerCommand() {},
		registerShortcut() {},
		exec: execShim,
	});
	return {
		ctx,
		fire(name, event = {}) { return handlers.get(name)?.(event, ctx); },
		async cell(code, { signal } = {}) {
			const toolCallId = `tool-${++toolIndex}`;
			const result = await tool.execute(toolCallId, { code }, signal, () => {}, ctx);
			const message = {
				role: "toolResult",
				toolCallId,
				toolName: "ipython",
				content: result.content,
				details: result.details,
				isError: result.details?.status === "error",
				timestamp: Date.now(),
			};
			const entryId = sessionManager.appendMessage(message);
			return { ...result, text: result.content[0].text, entryId };
		},
		user(content) {
			return sessionManager.appendMessage({ role: "user", content, timestamp: Date.now() });
		},
		shutdown(reason = "quit") { return handlers.get("session_shutdown")?.({ reason }, ctx); },
	};
}

export function copyBranch(source, target) {
	for (const entry of source.getBranch()) {
		if (entry.type === "message") target.appendMessage(structuredClone(entry.message));
		else if (entry.type === "custom") target.appendCustomEntry(entry.customType, structuredClone(entry.data));
	}
}
