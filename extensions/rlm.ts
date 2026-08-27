import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = join(EXTENSION_DIR, "ipkl.py");
const RUNTIME_DIR = join(EXTENSION_DIR, ".rlm-python");
const PYTHON_PATH = join(RUNTIME_DIR, "bin", "python");
const PROVISION_LOCK = join(EXTENSION_DIR, ".rlm-python.lock");
const STARTUP_TIMEOUT_MS = 45_000;
const PROVISION_TIMEOUT_MS = 6 * 60_000;
const OUTPUT_CAPTURE_LIMIT_BYTES = 1024 * 1024;
const MAX_CHILDREN_RUNNING = 4;
const MAX_LIVE_HANDLES = 16;
const MAX_CHILD_REQUEST_BYTES = 1024 * 1024;
const MAX_CHILD_TEXT_BYTES = 256 * 1024;
const MAX_HOST_REQUEST_BYTES = MAX_CHILD_REQUEST_BYTES + 64 * 1024;
const MAX_HOST_RESPONSE_BYTES = 5 * 1024 * 1024;
const CHILD_DEADLINE_MS = 5 * 60_000;
const CHILD_CLEANUP_GRACE_MS = 2_000;
const HOST_REQUEST_LINE_TIMEOUT_MS = 10_000;
const HOST_PROTOCOL_VERSION = 1;
const CHILD_SYSTEM_PROMPT = [
	"You are a focused child model in a recursive language-model computation.",
	"Complete only the task in the user message using the supplied context.",
	"You have no tools and no access to the parent transcript. Return a concise final answer.",
].join("\n");
const RESET_NOTICE = [
	"<ipython_kernel_reset>",
	"The IPython kernel was restarted. All in-memory variables, imports, tasks, and open resources from the previous kernel were lost; recreate them before continuing.",
	"</ipython_kernel_reset>",
].join("\n");

const parameters = Type.Object({
	code: Type.String({ description: "Python or an IPython cell" }),
});

type ActiveModel = NonNullable<ExtensionContext["model"]>;
type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;
type ChildSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

interface IpythonDetails {
	status: "ok" | "error" | "running" | "starting";
	executionCount?: number;
	kernelReset?: boolean;
	truncated?: boolean;
	fullOutputPath?: string;
	final?: unknown;
	nestedUsage?: Usage;
	children?: {
		spawned: number;
		gathered: number;
	};
}

interface BridgeResult {
	status: string;
	executionCount?: number;
	error?: { ename?: string; evalue?: string };
	output: string;
}

interface ActiveExecution {
	requestId: string;
	output: string;
	onProgress: (message: string) => void;
	onOutput?: (output: string) => void;
	resolve: (result: BridgeResult) => void;
	reject: (error: Error) => void;
}

interface ReadyWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
}

interface ChildConfig {
	cwd: string;
	model?: ActiveModel;
	thinkingLevel: ThinkingLevel;
	modelRuntime: ModelRuntime;
}

interface ChildResult {
	status: "ok" | "error" | "cancelled" | "timeout";
	text: string | null;
	error: string | null;
	usage: Usage;
	elapsed_ms: number;
	truncated: boolean;
}

interface ChildRecord {
	handle: string;
	originExecutionId: string;
	owners: Set<string>;
	controller: AbortController;
	promise: Promise<ChildResult>;
	session?: ChildSession;
	timedOut: boolean;
	gatherClaim?: string;
}

interface ExecutionState {
	config: ChildConfig;
	controller: AbortController;
	finalSet: boolean;
	finalValue?: unknown;
	usage: Usage;
	spawned: number;
	gathered: number;
	attributedHandles: Set<string>;
}

interface ExecutionSummary {
	hasFinal: boolean;
	finalValue?: unknown;
	usage: Usage;
	spawned: number;
	gathered: number;
}

type HostRequest =
	| {
			version: 1;
			auth: string;
			id: string;
			execution_id: string;
			op: "spawn";
			task: string;
			context: string | null;
			cwd: string;
	  }
	| {
			version: 1;
			auth: string;
			id: string;
			execution_id: string;
			op: "gather";
			handles: string[];
	  }
	| {
			version: 1;
			auth: string;
			id: string;
			execution_id: string;
			op: "final";
			value: unknown;
	  };

interface HostResponse {
	version: 1;
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|[@-_][0-?]*[ -/]*[@-~])/g, "");
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.totalTokens += source.totalTokens;
	target.cost.input += source.cost.input;
	target.cost.output += source.cost.output;
	target.cost.cacheRead += source.cost.cacheRead;
	target.cost.cacheWrite += source.cost.cacheWrite;
	target.cost.total += source.cost.total;
	if (source.cacheWrite1h !== undefined) target.cacheWrite1h = (target.cacheWrite1h ?? 0) + source.cacheWrite1h;
	if (source.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + source.reasoning;
}

function hasUsage(usage: Usage): boolean {
	return usage.totalTokens > 0 || usage.cost.total > 0;
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
	const encoded = Buffer.from(value, "utf8");
	if (encoded.byteLength <= maxBytes) return { text: value, truncated: false };
	const notice = "\n[child response truncated at 256 KiB]";
	const budget = Math.max(0, maxBytes - Buffer.byteLength(notice));
	return { text: encoded.subarray(0, budget).toString("utf8") + notice, truncated: true };
}

function boundedError(error: unknown): string {
	return truncateUtf8(errorText(error), 16 * 1024).text;
}

function partialText(output: string): string {
	const clean = stripAnsi(output);
	const truncated = truncateTail(clean, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncated.truncated) return truncated.content || "[no output yet]";
	return `[Live output truncated; showing the tail]\n${truncated.content}`;
}

async function finalText(output: string): Promise<{
	text: string;
	truncated: boolean;
	fullOutputPath?: string;
}> {
	const clean = stripAnsi(output);
	const truncated = truncateTail(clean, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncated.truncated) {
		return { text: truncated.content || "[no output]", truncated: false };
	}

	const directory = await mkdtemp(join(tmpdir(), "pi-ipython-"));
	const fullOutputPath = join(directory, "output.txt");
	await writeFile(fullOutputPath, clean, "utf8");
	const omittedLines = truncated.totalLines - truncated.outputLines;
	const omittedBytes = truncated.totalBytes - truncated.outputBytes;
	const notice = [
		`[Output truncated: showing the last ${truncated.outputLines} of ${truncated.totalLines} lines`,
		`(${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}).`,
		`${omittedLines} lines (${formatSize(omittedBytes)}) omitted.`,
		`Full output saved to: ${fullOutputPath}]`,
	].join(" ");
	return {
		text: `${notice}\n${truncated.content}`,
		truncated: true,
		fullOutputPath,
	};
}

function renderFinal(value: unknown): string {
	if (typeof value === "string") return value;
	const encoded = JSON.stringify(value, null, 2);
	return encoded === undefined ? String(value) : encoded;
}

class Semaphore {
	private running = 0;
	private readonly waiters: Array<{
		resolve: (release: () => void) => void;
		reject: (error: Error) => void;
		signal: AbortSignal;
		onAbort: () => void;
	}> = [];

	constructor(private readonly limit: number) {}

	acquire(signal: AbortSignal): Promise<() => void> {
		if (signal.aborted) return Promise.reject(new Error("Child cancelled before admission"));
		if (this.running < this.limit) {
			this.running += 1;
			return Promise.resolve(this.releaseFunction());
		}
		return new Promise((resolve, reject) => {
			const waiter = {
				resolve,
				reject,
				signal,
				onAbort: () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(new Error("Child cancelled before admission"));
				},
			};
			signal.addEventListener("abort", waiter.onAbort, { once: true });
			this.waiters.push(waiter);
		});
	}

	private releaseFunction(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			while (this.waiters.length > 0) {
				const waiter = this.waiters.shift()!;
				waiter.signal.removeEventListener("abort", waiter.onAbort);
				if (waiter.signal.aborted) continue;
				waiter.resolve(this.releaseFunction());
				return;
			}
			this.running -= 1;
		};
	}
}

async function settleChildrenWithin(records: readonly ChildRecord[]): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.allSettled(records.map((record) => record.promise)).then(() => undefined),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, CHILD_CLEANUP_GRACE_MS);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

class RlmHostBridge {
	private server?: Server;
	private socketDirectory?: string;
	private socketPath?: string;
	private readonly authToken = randomBytes(32).toString("hex");
	private readonly executions = new Map<string, ExecutionState>();
	private readonly children = new Map<string, ChildRecord>();
	private readonly sockets = new Set<Socket>();
	private readonly limiter = new Semaphore(MAX_CHILDREN_RUNNING);
	private starting?: Promise<void>;
	private resetting?: Promise<void>;
	private disposed = false;

	constructor(private readonly onActivity: (executionId: string, message: string) => void) {}

	get environment(): Record<string, string> {
		if (!this.socketPath) throw new Error("RLM host bridge has not started");
		return {
			RLM_HOST_SOCKET: this.socketPath,
			RLM_HOST_TOKEN: this.authToken,
		};
	}

	async ensureStarted(): Promise<void> {
		if (this.disposed) throw new Error("RLM host bridge is shutting down");
		await this.resetting;
		if (this.server) return;
		if (!this.starting) {
			const start = this.start();
			const tracked = start.finally(() => {
				if (this.starting === tracked) this.starting = undefined;
			});
			this.starting = tracked;
		}
		await this.starting;
	}

	beginExecution(executionId: string, config: ChildConfig): void {
		if (this.executions.has(executionId)) throw new Error("Duplicate IPython execution id");
		this.executions.set(executionId, {
			config,
			controller: new AbortController(),
			finalSet: false,
			usage: emptyUsage(),
			spawned: 0,
			gathered: 0,
			attributedHandles: new Set(),
		});
	}

	async endExecution(executionId: string, successful: boolean): Promise<ExecutionSummary> {
		const execution = this.executions.get(executionId);
		if (!execution) {
			return { hasFinal: false, usage: emptyUsage(), spawned: 0, gathered: 0 };
		}
		if (!successful) await this.cancelExecution(executionId);
		else execution.controller.abort(new Error("IPython execution finished"));
		this.executions.delete(executionId);
		return {
			hasFinal: successful && execution.finalSet,
			finalValue: successful && execution.finalSet ? execution.finalValue : undefined,
			usage: execution.usage,
			spawned: execution.spawned,
			gathered: execution.gathered,
		};
	}

	async cancelExecution(executionId: string): Promise<void> {
		const execution = this.executions.get(executionId);
		execution?.controller.abort(new Error("Outer IPython execution cancelled"));
		const records = [...this.children.values()].filter((record) => record.owners.has(executionId));
		for (const record of records) {
			record.controller.abort(new Error("Outer IPython execution cancelled"));
			record.session?.dispose();
		}
		await settleChildrenWithin(records);
		for (const record of records) this.children.delete(record.handle);
	}

	resetGeneration(): Promise<void> {
		if (this.resetting) return this.resetting;
		const reset = (async () => {
			for (const execution of this.executions.values()) {
				execution.controller.abort(new Error("IPython kernel generation ended"));
			}
			const records = [...this.children.values()];
			for (const record of records) {
				record.controller.abort(new Error("IPython kernel generation ended"));
				record.session?.dispose();
			}
			await settleChildrenWithin(records);
			for (const record of records) this.children.delete(record.handle);
			this.executions.clear();
		})();
		const tracked = reset.finally(() => {
			if (this.resetting === tracked) this.resetting = undefined;
		});
		this.resetting = tracked;
		return tracked;
	}

	private async start(): Promise<void> {
		const directory = await mkdtemp(join(tmpdir(), "pi-rlm-host-"));
		const socketPath = join(directory, "host.sock");
		const server = createServer((socket) => this.handleConnection(socket));
		server.on("error", () => {});
		try {
			await chmod(directory, 0o700);
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => {
					server.off("listening", onListening);
					reject(error);
				};
				const onListening = () => {
					server.off("error", onError);
					resolve();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				server.listen(socketPath);
			});
			await chmod(socketPath, 0o600);
			this.socketDirectory = directory;
			this.socketPath = socketPath;
			this.server = server;
		} catch (error) {
			await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => {});
			await rm(directory, { recursive: true, force: true }).catch(() => {});
			throw error;
		}
	}

	private handleConnection(socket: Socket): void {
		let input = Buffer.alloc(0);
		let handled = false;
		this.sockets.add(socket);
		socket.once("close", () => this.sockets.delete(socket));
		socket.on("error", () => {});
		socket.setTimeout(HOST_REQUEST_LINE_TIMEOUT_MS, () => socket.destroy());
		socket.on("data", (chunk: Buffer) => {
			if (handled) return;
			input = Buffer.concat([input, chunk]);
			if (input.byteLength > MAX_HOST_REQUEST_BYTES) {
				handled = true;
				socket.end(`${JSON.stringify(this.failure("", "Host request exceeded the size limit"))}\n`);
				return;
			}
			const newline = input.indexOf(0x0a);
			if (newline < 0) return;
			handled = true;
			socket.setTimeout(0);
			socket.pause();
			const line = input.subarray(0, newline).toString("utf8");
			void this.processLine(line)
				.then((response) => socket.end(`${JSON.stringify(response)}\n`))
				.catch((error) => socket.end(`${JSON.stringify(this.failure("", boundedError(error)))}\n`));
		});
	}

	private async processLine(line: string): Promise<HostResponse> {
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			return this.failure("", "Invalid JSON host request");
		}
		if (!raw || typeof raw !== "object") return this.failure("", "Host request must be an object");
		const candidate = raw as Record<string, unknown>;
		const id = typeof candidate.id === "string" ? candidate.id : "";
		if (candidate.version !== HOST_PROTOCOL_VERSION) return this.failure(id, "Unsupported host protocol version");
		if (typeof candidate.auth !== "string" || !this.authMatches(candidate.auth)) {
			return this.failure(id, "Host authentication failed");
		}
		try {
			return await this.dispatch(candidate as unknown as HostRequest);
		} catch (error) {
			return this.failure(id, boundedError(error));
		}
	}

	private authMatches(candidate: string): boolean {
		const left = Buffer.from(candidate);
		const right = Buffer.from(this.authToken);
		return left.byteLength === right.byteLength && timingSafeEqual(left, right);
	}

	private activity(executionId: string, message: string): void {
		try {
			this.onActivity(executionId, message);
		} catch {}
	}

	private async dispatch(request: HostRequest): Promise<HostResponse> {
		if (typeof request.id !== "string" || typeof request.execution_id !== "string") {
			throw new Error("Host request requires string id and execution_id");
		}
		const execution = this.executions.get(request.execution_id);
		if (!execution) throw new Error("The originating IPython execution is no longer active");

		if (request.op === "spawn") {
			if (typeof request.task !== "string" || (request.context !== null && typeof request.context !== "string")) {
				throw new Error("spawn requires a string task and optional string context");
			}
			if (typeof request.cwd !== "string" || !request.cwd.startsWith("/")) {
				throw new Error("spawn requires the kernel's absolute cwd");
			}
			let cwdIsDirectory = false;
			try {
				cwdIsDirectory = statSync(request.cwd).isDirectory();
			} catch {}
			if (!cwdIsDirectory) throw new Error("The kernel cwd is not an accessible directory");
			if (!request.task.trim()) throw new Error("spawn task must not be empty");
			const requestBytes = utf8Bytes(request.task) + (request.context === null ? 0 : utf8Bytes(request.context));
			if (requestBytes > MAX_CHILD_REQUEST_BYTES) {
				throw new Error(`Child task and context exceed ${formatSize(MAX_CHILD_REQUEST_BYTES)}`);
			}
			if (this.children.size >= MAX_LIVE_HANDLES) {
				throw new Error(`At most ${MAX_LIVE_HANDLES} live child handles are allowed`);
			}
			if (!execution.config.model) throw new Error("No active model is available for child creation");
			const handle = randomBytes(18).toString("base64url");
			const record: ChildRecord = {
				handle,
				originExecutionId: request.execution_id,
				owners: new Set([request.execution_id]),
				controller: new AbortController(),
				promise: undefined as unknown as Promise<ChildResult>,
				timedOut: false,
			};
			record.promise = this.runChild(
				record,
				{ ...execution.config, cwd: request.cwd },
				request.task,
				request.context,
			);
			this.children.set(handle, record);
			execution.spawned += 1;
			return this.success(request.id, { handle });
		}

		if (request.op === "gather") {
			if (!Array.isArray(request.handles) || request.handles.some((handle) => typeof handle !== "string")) {
				throw new Error("gather requires a list of handle ids");
			}
			if (request.handles.length > MAX_LIVE_HANDLES) throw new Error("Too many handles in gather");
			const records = request.handles.map((handle) => {
				const record = this.children.get(handle);
				if (!record) throw new Error(`Unknown or already gathered child handle: ${handle}`);
				if (record.gatherClaim && record.gatherClaim !== request.id) {
					throw new Error(`Child handle is already being gathered: ${handle}`);
				}
				return record;
			});
			const uniqueRecords = [...new Set(records)];
			for (const record of uniqueRecords) {
				record.gatherClaim = request.id;
				record.owners.add(request.execution_id);
			}
			let committed = false;
			try {
				let completed = 0;
				if (uniqueRecords.length > 0) {
					this.activity(request.execution_id, `Waiting for ${uniqueRecords.length} RLM child${uniqueRecords.length === 1 ? "" : "ren"}…`);
				}
				const settled = new Map<string, ChildResult>();
				const gatherWork = Promise.all(
					uniqueRecords.map(async (record) => {
						settled.set(record.handle, await record.promise);
						completed += 1;
						this.activity(request.execution_id, `RLM children completed: ${completed}/${uniqueRecords.length}`);
					}),
				).then(() => undefined);
				let rejectOnCancel: ((error: Error) => void) | undefined;
				const cancelled = new Promise<never>((_resolve, reject) => {
					rejectOnCancel = reject;
				});
				const cancelGather = () => {
					const reason = execution.controller.signal.reason;
					rejectOnCancel?.(reason instanceof Error ? reason : new Error("RLM gather cancelled"));
				};
				execution.controller.signal.addEventListener("abort", cancelGather, { once: true });
				try {
					if (execution.controller.signal.aborted) cancelGather();
					await Promise.race([gatherWork, cancelled]);
				} finally {
					execution.controller.signal.removeEventListener("abort", cancelGather);
					rejectOnCancel = undefined;
				}
				if (execution.controller.signal.aborted || this.executions.get(request.execution_id) !== execution) {
					throw new Error("The originating IPython execution is no longer active");
				}
				const results = records.map((record) => settled.get(record.handle)!);
				const response = this.success(request.id, { results });
				if (utf8Bytes(JSON.stringify(response)) + 1 > MAX_HOST_RESPONSE_BYTES) {
					throw new Error(`Gather response exceeds ${formatSize(MAX_HOST_RESPONSE_BYTES)}; gather fewer handles at a time`);
				}
				for (const record of uniqueRecords) {
					const result = settled.get(record.handle)!;
					if (!execution.attributedHandles.has(record.handle)) {
						addUsage(execution.usage, result.usage);
						execution.attributedHandles.add(record.handle);
						execution.gathered += 1;
					}
					this.children.delete(record.handle);
				}
				committed = true;
				return response;
			} finally {
				if (!committed) {
					for (const record of uniqueRecords) {
						if (record.gatherClaim === request.id) record.gatherClaim = undefined;
					}
				}
			}
		}

		if (request.op === "final") {
			const encoded = JSON.stringify(request.value);
			if (encoded === undefined) throw new Error("final value must be JSON serializable");
			if (utf8Bytes(encoded) > MAX_CHILD_REQUEST_BYTES) throw new Error("final value exceeds 1 MiB");
			if (!execution.finalSet) {
				execution.finalSet = true;
				execution.finalValue = request.value;
			}
			return this.success(request.id, { accepted: true, value: execution.finalValue });
		}

		throw new Error("Unknown host operation");
	}

	private async runChild(
		record: ChildRecord,
		config: ChildConfig,
		task: string,
		context: string | null,
	): Promise<ChildResult> {
		const started = Date.now();
		let release: (() => void) | undefined;
		let session: ChildSession | undefined;
		const deadline = setTimeout(() => {
			record.timedOut = true;
			record.controller.abort(new Error("Child deadline exceeded"));
			record.session?.dispose();
		}, CHILD_DEADLINE_MS);
		try {
			release = await this.limiter.acquire(record.controller.signal);
			if (record.controller.signal.aborted) throw new Error("Child cancelled before startup");
			const settingsManager = SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
			});
			const loader = new DefaultResourceLoader({
				cwd: config.cwd,
				agentDir: getAgentDir(),
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt: CHILD_SYSTEM_PROMPT,
				appendSystemPrompt: [],
			});
			await loader.reload();
			if (record.controller.signal.aborted) throw new Error("Child cancelled during setup");
			const created = await createAgentSession({
				cwd: config.cwd,
				agentDir: getAgentDir(),
				model: config.model,
				thinkingLevel: config.thinkingLevel,
				modelRuntime: config.modelRuntime,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(config.cwd),
				settingsManager,
				noTools: "all",
				tools: [],
			});
			session = created.session;
			record.session = session;
			if (record.controller.signal.aborted) {
				session.dispose();
				throw new Error("Child cancelled during setup");
			}
			if (session.getActiveToolNames().length !== 0) {
				throw new Error("Focused child unexpectedly loaded tools");
			}
			const prompt = context === null ? task : `${task}\n\n<context>\n${context}\n</context>`;
			let rejectOnAbort: ((error: Error) => void) | undefined;
			const aborted = new Promise<never>((_resolve, reject) => {
				rejectOnAbort = reject;
			});
			const abort = () => {
				session?.dispose();
				const reason = record.controller.signal.reason;
				rejectOnAbort?.(reason instanceof Error ? reason : new Error("Child cancelled"));
			};
			record.controller.signal.addEventListener("abort", abort, { once: true });
			try {
				if (record.controller.signal.aborted) {
					abort();
					await aborted;
				} else {
					await Promise.race([
						session.prompt(prompt, { expandPromptTemplates: false, source: "extension" }),
						aborted,
					]);
				}
			} finally {
				record.controller.signal.removeEventListener("abort", abort);
				rejectOnAbort = undefined;
			}

			const usage = this.collectUsage(session.state.messages);
			const assistant = [...session.state.messages].reverse().find((message) => message.role === "assistant");
			if (!assistant || assistant.role !== "assistant") throw new Error("Child returned no assistant message");
			if (assistant.stopReason === "aborted") throw new Error("Child was cancelled");
			if (assistant.stopReason === "error") throw new Error(assistant.errorMessage || "Child model request failed");
			if (assistant.stopReason !== "stop") {
				throw new Error(`Child response was incomplete (${assistant.stopReason})`);
			}
			const text = assistant.content
				.filter((part): part is Extract<(typeof assistant.content)[number], { type: "text" }> => part.type === "text")
				.map((part) => part.text)
				.join("");
			const bounded = truncateUtf8(text, MAX_CHILD_TEXT_BYTES);
			return {
				status: "ok",
				text: bounded.text,
				error: null,
				usage,
				elapsed_ms: Date.now() - started,
				truncated: bounded.truncated,
			};
		} catch (error) {
			const usage = session ? this.collectUsage(session.state.messages) : emptyUsage();
			const status = record.timedOut ? "timeout" : record.controller.signal.aborted ? "cancelled" : "error";
			return {
				status,
				text: null,
				error: boundedError(error),
				usage,
				elapsed_ms: Date.now() - started,
				truncated: false,
			};
		} finally {
			clearTimeout(deadline);
			session?.dispose();
			if (record.session === session) record.session = undefined;
			release?.();
		}
	}

	private collectUsage(messages: readonly unknown[]): Usage {
		const total = emptyUsage();
		for (const raw of messages) {
			const message = raw as { role?: string; usage?: Usage };
			if (message.role === "assistant" && message.usage) addUsage(total, message.usage);
		}
		return total;
	}

	private success(id: string, result: unknown): HostResponse {
		return { version: HOST_PROTOCOL_VERSION, id, ok: true, result };
	}

	private failure(id: string, error: string): HostResponse {
		return { version: HOST_PROTOCOL_VERSION, id, ok: false, error };
	}

	async shutdown(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.starting?.catch(() => {});
		for (const execution of this.executions.values()) {
			execution.controller.abort(new Error("RLM host bridge shutting down"));
		}
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		const server = this.server;
		this.server = undefined;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => {});
		}
		const records = [...this.children.values()];
		for (const record of records) {
			record.controller.abort(new Error("RLM host bridge shutting down"));
			record.session?.dispose();
		}
		await settleChildrenWithin(records);
		this.children.clear();
		this.executions.clear();
		if (this.socketDirectory) await rm(this.socketDirectory, { recursive: true, force: true }).catch(() => {});
		this.socketDirectory = undefined;
		this.socketPath = undefined;
	}
}

class KernelRuntime {
	private child?: ChildProcessWithoutNullStreams;
	private ready = false;
	private readyWaiter?: ReadyWaiter;
	private starting?: Promise<void>;
	private provisioning?: Promise<void>;
	private active?: ActiveExecution;
	private stderr = "";
	private stopping = false;
	private stoppingPromise?: Promise<void>;
	private kernelPgid?: number;
	private pendingResetNotice = false;
	private disposed = false;
	private readonly lifecycle = new AbortController();
	private readonly host: RlmHostBridge;

	constructor(private readonly pi: ExtensionAPI) {
		this.host = new RlmHostBridge((executionId, message) => {
			const active = this.active;
			if (active?.requestId === executionId) active.onProgress(message);
		});
	}

	async execute(
		requestId: string,
		code: string,
		config: ChildConfig,
		signal: AbortSignal | undefined,
		onProgress: (message: string) => void,
		onOutput: (output: string) => void,
	): Promise<{ result: BridgeResult; kernelReset: boolean; host: ExecutionSummary }> {
		if (this.disposed) throw new Error("IPython runtime is shutting down");
		const operationSignal = signal
			? AbortSignal.any([signal, this.lifecycle.signal])
			: this.lifecycle.signal;
		await this.ensureStarted(config.cwd, operationSignal, onProgress);
		if (!this.child || !this.ready) throw new Error("IPython kernel did not start");
		if (this.active) throw new Error("IPython kernel is already executing a cell");
		if (operationSignal.aborted) throw new Error("IPython execution cancelled before it started");

		const kernelReset = this.pendingResetNotice;
		this.pendingResetNotice = false;
		this.host.beginExecution(requestId, config);
		let successful = false;
		try {
			const result = await new Promise<BridgeResult>((resolve, reject) => {
				const active: ActiveExecution = {
					requestId,
					output: "",
					onProgress,
					onOutput,
					resolve,
					reject,
				};
				this.active = active;

				const abort = () => {
					if (this.active !== active) return;
					this.active = undefined;
					this.pendingResetNotice = true;
					void this.host.cancelExecution(requestId);
					void this.terminate().finally(() => {
						reject(
							new Error(
								"IPython execution cancelled. Associated child work was aborted and the kernel was killed, so all in-memory state was lost; the next call will start a fresh kernel.",
							),
						);
					});
				};
				operationSignal.addEventListener("abort", abort, { once: true });

				const settle = (callback: () => void) => {
					operationSignal.removeEventListener("abort", abort);
					callback();
				};
				active.resolve = (value) => settle(() => resolve(value));
				active.reject = (error) => settle(() => reject(error));

				try {
					this.child!.stdin.write(
						`${JSON.stringify({ type: "execute", request_id: requestId, code })}\n`,
						(error) => {
							if (error) this.handleStdinError(this.child, error);
						},
					);
				} catch (error) {
					this.handleStdinError(this.child, error);
				}
			});
			successful = result.status === "ok";
			const host = await this.host.endExecution(requestId, successful);
			return { result, kernelReset, host };
		} catch (error) {
			await this.host.endExecution(requestId, false);
			throw error;
		}
	}

	private async ensureStarted(
		cwd: string,
		signal: AbortSignal | undefined,
		onProgress: (message: string) => void,
	): Promise<void> {
		if (this.stoppingPromise) await this.stoppingPromise;
		if (this.child && this.ready) return;
		if (!this.starting) {
			const startup = this.start(cwd, signal, onProgress);
			const tracked = startup.finally(() => {
				if (this.starting === tracked) this.starting = undefined;
			});
			this.starting = tracked;
		}
		await this.starting;
	}

	private async ensureRuntime(signal: AbortSignal | undefined, onProgress: (message: string) => void): Promise<void> {
		if (!this.provisioning) {
			const provision = this.provision(signal, onProgress);
			const tracked = provision.catch((error) => {
				if (this.provisioning === tracked) this.provisioning = undefined;
				throw error;
			});
			this.provisioning = tracked;
		}
		await this.provisioning;
	}

	private async provision(signal: AbortSignal | undefined, onProgress: (message: string) => void): Promise<void> {
		const validation = [
			"import sys",
			"assert sys.version_info[:2] == (3, 12)",
			"import IPython, ipykernel, jupyter_client, zmq",
		].join("; ");
		const check = await this.pi.exec(PYTHON_PATH, ["-I", "-c", validation], {
			signal,
			timeout: 15_000,
		});
		if (check.code === 0) return;
		if (signal?.aborted) throw new Error("IPython runtime provisioning cancelled");

		onProgress("Provisioning extension-owned Python 3.12 and IPython runtime with uv...");
		const script = [
			"set -eu",
			`if ${shellQuote(PYTHON_PATH)} -I -c ${shellQuote(validation)} >/dev/null 2>&1; then exit 0; fi`,
			`uv venv --no-project --no-config --managed-python --clear --python 3.12 ${shellQuote(RUNTIME_DIR)}`,
			`uv pip install --no-config --strict --python ${shellQuote(PYTHON_PATH)} 'ipykernel>=7,<8' 'jupyter-client>=8,<9'`,
			`${shellQuote(PYTHON_PATH)} -I -c ${shellQuote(validation)}`,
		].join("\n");
		const result = await this.pi.exec(
			"flock",
			["-w", "300", PROVISION_LOCK, "bash", "-c", script],
			{ signal, timeout: PROVISION_TIMEOUT_MS, cwd: EXTENSION_DIR },
		);
		if (result.code !== 0) {
			const diagnostics = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
			throw new Error(`Failed to provision the IPython runtime with uv${diagnostics ? `:\n${diagnostics}` : ""}`);
		}
	}

	private async start(
		cwd: string,
		signal: AbortSignal | undefined,
		onProgress: (message: string) => void,
	): Promise<void> {
		await this.ensureRuntime(signal, onProgress);
		await this.host.ensureStarted();
		if (signal?.aborted) throw new Error("IPython startup cancelled");
		onProgress("Starting IPython kernel...");

		this.stderr = "";
		this.stopping = false;
		this.ready = false;
		const child = spawn(PYTHON_PATH, ["-I", BRIDGE_PATH], {
			cwd,
			detached: process.platform !== "win32",
			env: {
				...process.env,
				...this.host.environment,
				NO_COLOR: "1",
				PYTHONUNBUFFERED: "1",
				RLM_KERNEL_CWD: cwd,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;

		const lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => this.handleLine(child, line));
		child.stderr.on("data", (chunk: Buffer | string) => {
			this.stderr = `${this.stderr}${chunk.toString()}`.slice(-16_384);
		});
		child.stdin.on("error", (error) => this.handleStdinError(child, error));
		child.once("error", (error) => this.handleExit(child, `bridge spawn failed: ${error.message}`));
		child.once("close", (code, terminatedBy) => {
			const reason = `bridge exited${code === null ? "" : ` with code ${code}`}${terminatedBy ? ` (${terminatedBy})` : ""}`;
			this.handleExit(child, reason);
		});

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				signal?.removeEventListener("abort", abort);
				this.readyWaiter = undefined;
				callback();
			};
			const abort = () => finish(() => reject(new Error("IPython startup cancelled")));
			const timeout = setTimeout(
				() => finish(() => reject(new Error(`IPython kernel did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s`))),
				STARTUP_TIMEOUT_MS,
			);
			this.readyWaiter = {
				resolve: () => finish(resolve),
				reject: (error) => finish(() => reject(error)),
			};
			signal?.addEventListener("abort", abort, { once: true });
		}).catch(async (error) => {
			await this.terminate();
			throw error;
		});
	}

	private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
		if (this.child !== child) return;
		let message: any;
		try {
			message = JSON.parse(line);
		} catch {
			this.stderr = `${this.stderr}\nNon-protocol bridge output: ${line}`.slice(-16_384);
			return;
		}

		if (message.type === "kernel_started") {
			if (!Number.isSafeInteger(message.kernel_pgid) || message.kernel_pgid <= 1) {
				this.readyWaiter?.reject(new Error("IPython bridge reported an invalid kernel process group"));
				this.kill();
				return;
			}
			this.kernelPgid = message.kernel_pgid;
			return;
		}
		if (message.type === "ready") {
			if (!Number.isSafeInteger(message.kernel_pgid) || message.kernel_pgid <= 1) {
				this.readyWaiter?.reject(new Error("IPython bridge reported an invalid kernel process group"));
				this.kill();
				return;
			}
			if (this.kernelPgid !== undefined && this.kernelPgid !== message.kernel_pgid) {
				this.readyWaiter?.reject(new Error("IPython bridge changed kernel process groups during startup"));
				this.kill();
				return;
			}
			this.kernelPgid = message.kernel_pgid;
			this.ready = true;
			this.readyWaiter?.resolve();
			return;
		}
		if (message.type === "fatal") {
			const diagnostics = [message.error, message.traceback, this.stderr].filter(Boolean).join("\n");
			this.readyWaiter?.reject(new Error(`IPython bridge failed:\n${diagnostics}`));
			this.failActive(`IPython bridge failed and kernel state was lost:\n${diagnostics}`);
			this.pendingResetNotice ||= this.ready;
			this.kill();
			return;
		}

		const active = this.active;
		if (!active || message.request_id !== active.requestId) return;
		if (message.type === "clear") {
			active.output = "";
			active.onOutput?.(active.output);
			return;
		}
		if (message.type === "output" && typeof message.text === "string") {
			const kind = String(message.kind ?? "stdout");
			if (kind === "stdout" || kind === "stderr") {
				active.output += message.text;
			} else {
				if (!message.continuation && active.output && !active.output.endsWith("\n")) active.output += "\n";
				active.output += message.text;
				if (message.final && !active.output.endsWith("\n")) active.output += "\n";
			}
			if (Buffer.byteLength(active.output, "utf8") > OUTPUT_CAPTURE_LIMIT_BYTES) {
				let captureNotice: string;
				try {
					const directory = mkdtempSync(join(tmpdir(), "pi-ipython-overflow-"));
					const capturedPath = join(directory, "output.txt");
					writeFileSync(capturedPath, stripAnsi(active.output), "utf8");
					captureNotice = `Captured output saved to: ${capturedPath}`;
				} catch (error) {
					captureNotice = `Could not save captured output: ${errorText(error)}`;
				}
				this.active = undefined;
				this.pendingResetNotice = true;
				active.reject(
					new Error(
						`IPython output exceeded ${formatSize(OUTPUT_CAPTURE_LIMIT_BYTES)}. The runaway cell was stopped and kernel state was lost. ${captureNotice}\n\n${partialText(active.output)}`,
					),
				);
				this.kill();
				return;
			}
			active.onOutput?.(active.output);
			return;
		}
		if (message.type === "bridge_error") {
			const diagnostics = [message.error, message.traceback].filter(Boolean).join("\n");
			this.active = undefined;
			this.pendingResetNotice = true;
			active.reject(new Error(`IPython bridge error; kernel state was lost:\n${diagnostics}`));
			this.kill();
			return;
		}
		if (message.type === "result") {
			this.active = undefined;
			active.resolve({
				status: String(message.status ?? "error"),
				executionCount: typeof message.execution_count === "number" ? message.execution_count : undefined,
				error: message.error,
				output: active.output,
			});
		}
	}

	private handleStdinError(child: ChildProcessWithoutNullStreams | undefined, error: unknown): void {
		if (!child || this.child !== child) return;
		this.stderr = `${this.stderr}\nBridge stdin failed: ${errorText(error)}`.slice(-16_384);
		this.pendingResetNotice ||= this.ready;
		this.failActive(`Failed to communicate with IPython. The kernel state was lost: ${errorText(error)}`);
		this.kill();
	}

	private failActive(message: string): void {
		const active = this.active;
		if (!active) return;
		this.active = undefined;
		active.reject(new Error(message));
	}

	private handleExit(child: ChildProcessWithoutNullStreams, reason: string): void {
		if (this.child !== child) return;
		const hadState = this.ready;
		const expected = this.stopping;
		const kernelPgid = this.kernelPgid;
		this.child = undefined;
		this.kernelPgid = undefined;
		this.ready = false;
		this.stopping = false;
		const diagnostics = this.stderr.trim();
		const suffix = diagnostics ? `\n${diagnostics}` : "";
		this.readyWaiter?.reject(new Error(`IPython ${reason}${suffix}`));
		if (!expected) {
			if (kernelPgid) this.terminateProcessGroup(kernelPgid);
			void this.host.resetGeneration();
			this.pendingResetNotice ||= hadState;
			this.failActive(`IPython ${reason}. The kernel stopped and all in-memory state was lost.${suffix}`);
		}
	}

	private kill(): void {
		void this.terminate();
	}

	private terminate(): Promise<void> {
		if (this.stoppingPromise) return this.stoppingPromise;
		const child = this.child;
		if (!child) return Promise.resolve();
		const kernelPgid = this.kernelPgid;
		this.stopping = true;
		this.ready = false;

		const processStopping = new Promise<void>((resolve) => {
			let settled = false;
			let bridgeClosed = child.exitCode !== null;
			let forceTimer: ReturnType<typeof setTimeout> | undefined;
			let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
			const finish = () => {
				if (settled) return;
				settled = true;
				if (forceTimer) clearTimeout(forceTimer);
				if (giveUpTimer) clearTimeout(giveUpTimer);
				resolve();
			};
			child.once("close", () => {
				bridgeClosed = true;
				if (!this.isProcessGroupAlive(kernelPgid)) finish();
			});
			forceTimer = setTimeout(() => {
				this.signalProcessGroup(kernelPgid, "SIGKILL");
				try {
					if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
					else child.kill("SIGKILL");
				} catch {}
				if (bridgeClosed) finish();
			}, 1_000);
			giveUpTimer = setTimeout(finish, 2_000);
			this.signalProcessGroup(kernelPgid, "SIGTERM");
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
				else child.kill("SIGTERM");
			} catch {
				try {
					child.kill("SIGTERM");
				} catch {}
			}
		});
		const stopping = Promise.all([processStopping, this.host.resetGeneration()]).then(() => this.reapProcessGroup(kernelPgid));
		const tracked = stopping.finally(() => {
			if (this.kernelPgid === kernelPgid) this.kernelPgid = undefined;
			if (this.stoppingPromise === tracked) this.stoppingPromise = undefined;
		});
		this.stoppingPromise = tracked;
		return tracked;
	}

	private signalProcessGroup(pgid: number | undefined, signal: NodeJS.Signals): void {
		if (process.platform === "win32" || !pgid) return;
		try {
			process.kill(-pgid, signal);
		} catch {}
	}

	private isProcessGroupAlive(pgid: number | undefined): boolean {
		if (process.platform === "win32" || !pgid) return false;
		try {
			process.kill(-pgid, 0);
			return true;
		} catch {
			return false;
		}
	}

	private terminateProcessGroup(pgid: number): void {
		this.signalProcessGroup(pgid, "SIGTERM");
		setTimeout(() => this.signalProcessGroup(pgid, "SIGKILL"), 1_000);
	}

	private async reapProcessGroup(pgid: number | undefined): Promise<void> {
		if (!this.isProcessGroupAlive(pgid)) return;
		this.signalProcessGroup(pgid, "SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 250));
		if (!this.isProcessGroupAlive(pgid)) return;
		this.signalProcessGroup(pgid, "SIGKILL");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	async shutdown(): Promise<void> {
		if (this.disposed) {
			await this.stoppingPromise?.catch(() => {});
			return;
		}
		this.disposed = true;
		this.lifecycle.abort();
		await this.starting?.catch(() => {});
		await this.stoppingPromise?.catch(() => {});

		const child = this.child;
		const kernelPgid = this.kernelPgid;
		if (child) {
			this.stopping = true;
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					resolve();
				};
				const timeout = setTimeout(() => {
					void this.terminate().finally(finish);
				}, 1_500);
				child.once("close", finish);
				try {
					child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`, (error) => {
						if (error) void this.terminate();
					});
				} catch {
					void this.terminate();
				}
			});
		}
		await this.reapProcessGroup(kernelPgid);
		await this.host.shutdown();
	}
}

export default function rlmExtension(pi: ExtensionAPI) {
	const runtime = new KernelRuntime(pi);

	pi.registerTool({
		name: "ipython",
		label: "IPython",
		description: `Execute code in a persistent IPython kernel. Supports top-level await, native IPython magics, and the Python APIs rlm.spawn(task, context=...), rlm.gather(handles), and rlm.final(value). Child calls are limited to ${MAX_CHILDREN_RUNNING} concurrent/${MAX_LIVE_HANDLES} live handles, ${formatSize(MAX_CHILD_REQUEST_BYTES)} input, ${formatSize(MAX_CHILD_TEXT_BYTES)} returned text, and a 5-minute deadline. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full truncated output is saved to a temporary file. Runaway cells exceeding ${formatSize(OUTPUT_CAPTURE_LIMIT_BYTES)} of output are stopped and reset the kernel.`,
		promptSnippet: "Persistent IPython scratchpad with focused recursive child calls",
		promptGuidelines: [
			"Use rlm.spawn, rlm.gather, and rlm.final inside ipython when focused child-model fan-out can process context without placing it in the root prompt.",
		],
		parameters,
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			let latestOutput = "";
			const progress = (message: string) => {
				const status = message.startsWith("Starting") || message.startsWith("Provisioning") ? "starting" : "running";
				const text = latestOutput ? `${partialText(latestOutput)}\n\n${message}` : message;
				onUpdate?.({
					content: [{ type: "text", text }],
					details: { status } satisfies IpythonDetails,
				});
			};
			let lastUpdate = 0;
			let updateTimer: ReturnType<typeof setTimeout> | undefined;
			const emitOutput = () => {
				updateTimer = undefined;
				lastUpdate = Date.now();
				onUpdate?.({
					content: [{ type: "text", text: partialText(latestOutput) }],
					details: { status: "running" } satisfies IpythonDetails,
				});
			};
			const output = (text: string) => {
				latestOutput = text;
				const delay = Math.max(0, 100 - (Date.now() - lastUpdate));
				if (delay === 0) emitOutput();
				else if (!updateTimer) updateTimer = setTimeout(emitOutput, delay);
			};

			// ModelRegistry is the public extension facade over the session's canonical
			// ModelRuntime. Reuse that exact runtime so children inherit runtime OAuth,
			// provider registrations, and host-owned credential state.
			const modelRuntime = (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime;
			if (!modelRuntime) throw new Error("Could not access the active model runtime for RLM children");
			let execution: Awaited<ReturnType<KernelRuntime["execute"]>>;
			try {
				execution = await runtime.execute(
					toolCallId,
					params.code,
					{
						cwd: ctx.cwd,
						model: ctx.model,
						thinkingLevel: ctx.thinkingLevel ?? "off",
						modelRuntime,
					},
					signal,
					progress,
					output,
				);
			} finally {
				if (updateTimer) clearTimeout(updateTimer);
			}
			const { result, kernelReset, host } = execution;
			const formatted = await finalText(result.output);
			let visible = formatted.text;
			if (kernelReset) {
				visible = formatted.text === "[no output]" ? RESET_NOTICE : `${RESET_NOTICE}\n\n${formatted.text}`;
			}
			if (host.hasFinal) {
				const finalValue = `[RLM final — terminating]\n${renderFinal(host.finalValue)}`;
				visible = visible === "[no output]" ? finalValue : `${visible}\n\n${finalValue}`;
			}
			const details: IpythonDetails = {
				status: result.status === "ok" ? "ok" : "error",
				executionCount: result.executionCount,
				kernelReset,
				truncated: formatted.truncated,
				fullOutputPath: formatted.fullOutputPath,
				final: host.hasFinal ? host.finalValue : undefined,
				nestedUsage: hasUsage(host.usage) ? host.usage : undefined,
				children: { spawned: host.spawned, gathered: host.gathered },
			};

			if (result.status !== "ok") {
				const fallback = [result.error?.ename, result.error?.evalue].filter(Boolean).join(": ");
				throw new Error(visible === "[no output]" && fallback ? fallback : visible);
			}
			return {
				content: [{ type: "text", text: visible }],
				details,
				usage: hasUsage(host.usage) ? host.usage : undefined,
				terminate: host.hasFinal || undefined,
			};
		},
	});

	pi.on("session_shutdown", async () => {
		await runtime.shutdown();
	});
}
