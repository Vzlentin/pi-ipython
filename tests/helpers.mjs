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

export function createKernel(startup, startupCode) {
	const bus = new EventEmitter();
	if (startup) bus.on("ipython:kernel-starting", startup);
	return new KernelRuntime({
		events: { emit: (name, data) => bus.emit(name, data) },
	}, startupCode);
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
		registerTool(definition) { tool = definition; },
		registerCommand() {},
		registerShortcut() {},
		appendEntry(customType, data) { sessionManager.appendCustomEntry(customType, data); },
		exec: execShim,
	});
	// Pi's merge of a tool_result hook's changes into the executed result.
	const finalize = async (event, executed) => {
		const hook = await handlers.get("tool_result")?.({
			type: "tool_result",
			...event,
			content: executed.content,
			details: executed.details,
			structuredContent: executed.structuredContent,
			isError: executed.isError === true,
		}, ctx);
		if (!hook) return executed;
		return {
			content: hook.content ?? executed.content,
			details: hook.details ?? executed.details,
			structuredContent: hook.structuredContent ?? (hook.content ? undefined : executed.structuredContent),
			isError: hook.isError ?? executed.isError,
		};
	};
	return {
		ctx,
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
		// Like a codemode tool call: cells are nested calls whose results Pi does not save. The script
		// receives structured results, and its own result is what the model sees.
		async codemode(script) {
			const parentToolCallId = `tool-${++toolIndex}`;
			let nested = 0;
			const ipython = async (code, { signal, onUpdate } = {}) => {
				const toolCallId = `${parentToolCallId}/${++nested}`;
				let executed;
				try {
					executed = await tool.execute(toolCallId, { code }, signal, onUpdate ?? (() => {}), ctx);
				} catch (error) {
					executed = { content: [{ type: "text", text: error.message }], details: {}, isError: true };
				}
				const result = await finalize({ toolName: "ipython", toolCallId, parentToolCallId, input: { code } }, executed);
				if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
				if (result.isError) throw new Error(result.content[0].text);
				return result.content[0].text;
			};
			let value;
			let failure;
			try {
				value = await script(ipython);
			} catch (error) {
				failure = error;
			}
			const result = await finalize({ toolName: "codemode", toolCallId: parentToolCallId, input: {} }, {
				content: [{ type: "text", text: failure ? `Script failed\n${failure.message}` : "Script completed" }],
				details: {},
				isError: failure !== undefined,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: parentToolCallId,
				toolName: "codemode",
				content: result.content,
				isError: result.isError,
				timestamp: Date.now(),
			});
			return { value, isError: result.isError, text: result.content.map((block) => block.text).join("\n") };
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
	}
}
