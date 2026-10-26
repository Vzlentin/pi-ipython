import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { formatSize, partialText, stripAnsi } from "./output.ts";
import { CORE_DIR, PYTHON_PATH, syncEnvironment } from "./python.ts";

const BRIDGE_PATH = join(CORE_DIR, "bridge.py");

// The modules that the kernel imports at startup, such as `headstart`.
const KERNEL_MODULES_DIR = join(CORE_DIR, "kernel");

const STARTUP_TIMEOUT_MS = 45_000;
const EVALUATE_TIMEOUT_MS = 60_000;
export const OUTPUT_CAPTURE_LIMIT_BYTES = 1024 * 1024;
export const INTERRUPT_GRACE_MS = 3_000;
export const BRIDGE_PROTOCOL_VERSION = 2;
export const KERNEL_STARTING_EVENT = "ipython:kernel-starting";

/**
 * Emitted on the host's event bus (`pi.events` in Pi) before every kernel start. Listeners must write to it
 * before their first `await`: add environment variables for the bridge and
 * kernel, snippets to run hidden once the kernel is ready, and promises to await
 * before spawning.
 */
export interface KernelStartingEvent {
	env: Record<string, string>;
	startupCode: string[];
	waitFor(promise: Promise<unknown>): void;
}

/** The host's event bus, which receives `ipython:kernel-starting`: `pi.events` in Pi, the host's own bus elsewhere. */
export interface KernelHost {
	readonly events: { emit(name: typeof KERNEL_STARTING_EVENT, data: KernelStartingEvent): void };
}

export interface BridgeError {
	ename?: string;
	evalue?: string;
}

export interface BridgeResult {
	status: string;
	executionCount?: number;
	error?: BridgeError;
	output: string;
}

/** A JSON-decoded value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface ProtocolResult extends BridgeResult {
	value?: JsonValue;
}

type BridgeRequest =
	| { type: "execute"; request_id: string; code: string; cwd: string }
	| { type: "evaluate"; request_id: string; expression: string };

/** A line the bridge writes to stdout; see the `send` calls in bridge.py. */
type BridgeMessage =
	| { type: "kernel_started"; kernel_pgid: number }
	| { type: "ready"; protocol: number; kernel_pgid: number; connection_file: string }
	| { type: "fatal"; error: string; traceback: string }
	| { type: "bridge_error"; request_id: string | null; error: string; traceback: string }
	| { type: "clear"; request_id: string }
	| { type: "output"; request_id: string; kind: string; text: string; continuation: boolean; final: boolean }
	| {
			type: "result";
			request_id: string;
			status: string;
			execution_count?: number | null;
			value?: JsonValue;
			error?: { ename: string; evalue: string } | null;
	  };

/** Checks the fields that `handleLine` reads. Semantic checks, such as the process group range, stay there. */
function isBridgeMessage(value: JsonValue): value is BridgeMessage {
	if (!(value instanceof Object) || Array.isArray(value)) return false;

	switch (value.type) {
		case "kernel_started":
			return typeof value.kernel_pgid === "number";
		case "ready":
			return (
				typeof value.protocol === "number" &&
				typeof value.kernel_pgid === "number" &&
				typeof value.connection_file === "string"
			);
		case "fatal":
			return typeof value.error === "string" && typeof value.traceback === "string";
		case "bridge_error":
			return (
				(value.request_id === null || typeof value.request_id === "string") &&
				typeof value.error === "string" &&
				typeof value.traceback === "string"
			);
		case "clear":
			return typeof value.request_id === "string";
		case "output":
			return (
				typeof value.request_id === "string" &&
				typeof value.kind === "string" &&
				typeof value.text === "string" &&
				typeof value.continuation === "boolean" &&
				typeof value.final === "boolean"
			);
		case "result":
			return (
				typeof value.request_id === "string" &&
				typeof value.status === "string" &&
				(value.execution_count === undefined ||
					value.execution_count === null ||
					typeof value.execution_count === "number") &&
				(value.error === undefined || value.error === null || isBridgeErrorValue(value.error))
			);
		default:
			return false;
	}
}

/** Says why a line with a known message type failed `isBridgeMessage`, or returns undefined for other lines. */
function invalidMessageReason(value: JsonValue): string | undefined {
	if (!(value instanceof Object) || Array.isArray(value)) return undefined;

	switch (value.type) {
		case "kernel_started":
			return "IPython bridge reported an invalid kernel process group";
		case "ready":
			if (value.protocol !== BRIDGE_PROTOCOL_VERSION) return "IPython bridge reported an unsupported protocol version";

			if (!Number.isSafeInteger(value.kernel_pgid)) return "IPython bridge reported an invalid kernel process group";

			return "IPython bridge reported an invalid kernel connection file";
		case "fatal":
		case "bridge_error":
		case "clear":
		case "output":
		case "result":
			return `IPython bridge sent an invalid ${value.type} message`;
		default:
			return undefined;
	}
}

function isBridgeErrorValue(value: JsonValue): value is { ename: string; evalue: string } {
	return (
		value instanceof Object &&
		!Array.isArray(value) &&
		typeof value.ename === "string" &&
		typeof value.evalue === "string"
	);
}

interface RequestOptions {
	cancelReason: string;
	onOutput?: (output: string) => void;
	timeout?: { ms: number; reason: string };
}

interface ActiveExecution {
	requestId: string;
	output: string;
	onOutput?: (output: string) => void;
	resolve: (result: ProtocolResult) => void;
	reject: (error: Error) => void;
	interrupt?: { reason: string; timer: ReturnType<typeof setTimeout>; overflow: boolean };
}

interface ReadyWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
}

export class KernelLostError extends Error {}

export function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function describeError(error: BridgeError | undefined): string {
	return [error?.ename, error?.evalue].filter(Boolean).join(": ");
}

export class KernelRuntime {
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
	private kernelConnectionFile?: string;
	private pendingResetNotice = false;
	private disposed = false;
	private evaluateIndex = 0;
	private outputDirectory?: string;
	private outputIndex = 0;
	private _generation = 0;
	private shutdownPromise?: Promise<void>;
	private readonly lifecycle = new AbortController();
	private readonly host: KernelHost;
	private readonly startupCode: readonly string[];
	private readonly bridgeCommand: readonly [string, ...string[]];

	/**
	 * `startupCode` runs hidden after every listener's snippets and the `hs` import on each kernel start.
	 * `bridgeCommand` is the program and arguments that start the bridge.
	 */
	constructor(
		host: KernelHost,
		startupCode: readonly string[] = [],
		bridgeCommand: readonly [string, ...string[]] = [PYTHON_PATH, "-I", BRIDGE_PATH],
	) {
		this.host = host;
		this.startupCode = startupCode;
		this.bridgeCommand = bridgeCommand;
	}

	/** Increments each time a kernel becomes ready. */
	get generation(): number {
		return this._generation;
	}

	/** Writes `text` to a new file that survives kernel restarts and is deleted by `shutdown`. */
	saveOutput(text: string): string {
		if (this.disposed) throw new Error("IPython runtime is shutting down");
		this.outputDirectory ??= mkdtempSync(join(tmpdir(), "pi-ipython-output-"));
		const path = join(this.outputDirectory, `output-${++this.outputIndex}.txt`);
		writeFileSync(path, text, "utf8");

		return path;
	}

	async execute(
		requestId: string,
		code: string,
		cwd: string,
		signal: AbortSignal | undefined,
		onProgress: (message: string) => void,
		onOutput: (output: string) => void,
	): Promise<{ result: BridgeResult; kernelReset: boolean }> {
		const operationSignal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;

		if (operationSignal.aborted) throw new Error("IPython execution cancelled before it started");
		await this.start(cwd, operationSignal, onProgress);
		const kernelReset = this.pendingResetNotice;
		this.pendingResetNotice = false;

		const result = await this.request({ type: "execute", request_id: requestId, code, cwd }, operationSignal, {
			onOutput,
			cancelReason: "IPython execution cancelled",
		});

		return { result, kernelReset };
	}

	/** Evaluates a Python expression in the running kernel and returns its JSON-decoded value. */
	async evaluate(
		expression: string,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<JsonValue | undefined> {
		const signal = options.signal ? AbortSignal.any([options.signal, this.lifecycle.signal]) : this.lifecycle.signal;
		const timeoutMs = options.timeoutMs ?? EVALUATE_TIMEOUT_MS;

		const result = await this.request(
			{ type: "evaluate", request_id: `evaluate-${++this.evaluateIndex}`, expression },
			signal,
			{
				cancelReason: "IPython evaluation cancelled",
				timeout: { ms: timeoutMs, reason: `IPython evaluation exceeded ${timeoutMs / 1000}s` },
			},
		);

		if (result.status !== "ok") throw new Error(describeError(result.error) || "IPython evaluation failed");

		return result.value;
	}

	private request(message: BridgeRequest, signal: AbortSignal, options: RequestOptions): Promise<ProtocolResult> {
		if (!this.child || !this.ready) return Promise.reject(new Error("IPython kernel is unavailable"));

		if (this.active) return Promise.reject(new Error("IPython kernel is already executing a request"));

		if (signal.aborted) return Promise.reject(new Error(options.cancelReason));

		return new Promise<ProtocolResult>((resolve, reject) => {
			const active: ActiveExecution = {
				requestId: message.request_id,
				output: "",
				onOutput: options.onOutput,
				resolve,
				reject,
			};

			this.active = active;

			const abort = () => {
				if (this.active === active) this.interrupt(active, options.cancelReason);
			};

			signal.addEventListener("abort", abort, { once: true });
			const limit = options.timeout;

			const timeout =
				limit &&
				setTimeout(() => {
					if (this.active === active) this.interrupt(active, limit.reason);
				}, limit.ms);

			const settle = (callback: () => void) => {
				signal.removeEventListener("abort", abort);
				clearTimeout(timeout);
				clearTimeout(active.interrupt?.timer);
				callback();
			};

			active.resolve = (value) => settle(() => resolve(value));
			active.reject = (error) => settle(() => reject(new KernelLostError(error.message, { cause: error })));

			try {
				this.child!.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
					if (error) this.handleStdinError(this.child, errorText(error));
				});
			} catch (error) {
				this.handleStdinError(this.child, errorText(error));
			}
		});
	}

	async getConnectionFile(
		cwd: string,
		signal: AbortSignal | undefined,
		onProgress: (message: string) => void,
	): Promise<string> {
		const operationSignal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
		await this.start(cwd, operationSignal, onProgress);

		if (operationSignal.aborted || !this.ready || !this.kernelConnectionFile) {
			throw new Error("IPython kernel is not ready for a viewer");
		}

		return this.kernelConnectionFile;
	}

	async start(cwd: string, signal: AbortSignal | undefined, onProgress: (message: string) => void): Promise<void> {
		if (this.disposed) throw new Error("IPython runtime is shutting down");

		if (this.stoppingPromise) await this.stoppingPromise;

		if (this.child && this.ready) return;

		if (!this.starting) {
			const startup = this.startKernel(cwd, signal, onProgress);

			const tracked = startup.finally(() => {
				if (this.starting === tracked) this.starting = undefined;
			});

			this.starting = tracked;
		}

		await this.starting;
	}

	private async ensureRuntime(signal: AbortSignal | undefined, onProgress: (message: string) => void): Promise<void> {
		if (!this.provisioning) {
			const provision = syncEnvironment(signal, onProgress);

			const tracked = provision.catch((error) => {
				if (this.provisioning === tracked) this.provisioning = undefined;
				throw error;
			});

			this.provisioning = tracked;
		}

		await this.provisioning;
	}

	private async startKernel(
		cwd: string,
		signal: AbortSignal | undefined,
		onProgress: (message: string) => void,
	): Promise<void> {
		await this.ensureRuntime(signal, onProgress);
		const waits: Promise<unknown>[] = [];

		const starting: KernelStartingEvent = {
			env: {},
			startupCode: [],
			waitFor: (promise) => void waits.push(promise),
		};

		this.host.events.emit(KERNEL_STARTING_EVENT, starting);
		await Promise.all(waits);
		starting.startupCode.push(
			`__import__('sys').path.insert(0, ${JSON.stringify(KERNEL_MODULES_DIR)})`,
			"__import__('pi_ipython_interrupt').install(get_ipython().kernel)",
			"import headstart as hs",
			"hs.install(get_ipython())",
			...this.startupCode,
		);

		if (signal?.aborted) throw new Error("IPython startup cancelled");
		onProgress("Starting IPython kernel...");

		this.stderr = "";
		this.stopping = false;
		this.ready = false;

		const [command, ...args] = this.bridgeCommand;

		const child = spawn(command, args, {
			cwd,
			detached: process.platform !== "win32",
			env: {
				...process.env,
				...starting.env,
				NO_COLOR: "1",
				PYTHONUNBUFFERED: "1",
				IPYTHON_KERNEL_CWD: cwd,
				PI_IPYTHON_OWNER_PID: String(process.pid),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.child = child;

		const lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => this.handleLine(child, line));
		child.stderr.on("data", (chunk: Buffer | string) => {
			this.stderr = `${this.stderr}${chunk.toString()}`.slice(-16_384);
		});
		child.stdin.on("error", (error) => this.handleStdinError(child, error.message));
		child.stdin.write(`${JSON.stringify({ type: "startup", code: starting.startupCode })}\n`);
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
				() =>
					finish(() => reject(new Error(`IPython kernel did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s`))),
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
		let message: JsonValue | undefined;

		try {
			message = JSON.parse(line);
		} catch {}

		if (message === undefined || !isBridgeMessage(message)) {
			const reason = message === undefined ? undefined : invalidMessageReason(message);

			if (reason === undefined) {
				this.stderr = `${this.stderr}\nNon-protocol bridge output: ${line}`.slice(-16_384);

				return;
			}

			this.readyWaiter?.reject(new Error(reason));
			this.failActive(`${reason}. The kernel was stopped and all in-memory state was lost.`);
			this.pendingResetNotice ||= this.ready;
			this.kill();

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
			if (message.protocol !== BRIDGE_PROTOCOL_VERSION) {
				this.readyWaiter?.reject(new Error("IPython bridge reported an unsupported protocol version"));
				this.kill();

				return;
			}

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

			if (!isAbsolute(message.connection_file)) {
				this.readyWaiter?.reject(new Error("IPython bridge reported an invalid kernel connection file"));
				this.kill();

				return;
			}

			this.kernelPgid = message.kernel_pgid;
			this.kernelConnectionFile = message.connection_file;
			this.ready = true;
			this._generation += 1;
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

		if (message.type === "output") {
			if (active.interrupt?.overflow) return;
			const { kind } = message;

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
					captureNotice = `Captured output saved to: ${this.saveOutput(stripAnsi(active.output))}`;
				} catch (error) {
					captureNotice = `Could not save captured output: ${errorText(error)}`;
				}

				this.interrupt(
					active,
					`IPython output exceeded ${formatSize(OUTPUT_CAPTURE_LIMIT_BYTES)}. ${captureNotice}`,
					true,
				);

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

			const result: ProtocolResult = {
				status: message.status,
				executionCount: message.execution_count ?? undefined,
				value: message.value,
				error: message.error ?? undefined,
				output: active.output,
			};

			const reason = active.interrupt?.reason;

			if (reason === undefined) {
				active.resolve(result);

				return;
			}

			active.resolve({
				...result,
				status: "error",
				error: { ename: "Interrupted", evalue: reason },
				output: `${reason}; interrupted, kernel state preserved.\n\n${active.output}`,
			});
		}
	}

	private interrupt(active: ActiveExecution, reason: string, overflow = false): void {
		if (active.interrupt) return;

		const timer = setTimeout(() => {
			if (this.active !== active) return;
			this.active = undefined;
			this.pendingResetNotice = true;
			void this.terminate().finally(() =>
				active.reject(
					new Error(
						`${reason}. The cell did not stop within ${INTERRUPT_GRACE_MS / 1000}s; the kernel was killed and in-memory state was lost.\n\n${partialText(active.output)}`,
					),
				),
			);
		}, INTERRUPT_GRACE_MS);

		active.interrupt = { reason, timer, overflow };
		this.signalProcessGroup(this.kernelPgid, "SIGINT");
	}

	private handleStdinError(child: ChildProcessWithoutNullStreams | undefined, reason: string): void {
		if (!child || this.child !== child) return;
		this.stderr = `${this.stderr}\nBridge stdin failed: ${reason}`.slice(-16_384);
		this.pendingResetNotice ||= this.ready;
		this.failActive(`Failed to communicate with IPython. The kernel state was lost: ${reason}`);
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
		this.kernelConnectionFile = undefined;
		this.ready = false;
		this.stopping = false;
		const diagnostics = this.stderr.trim();
		const suffix = diagnostics ? `\n${diagnostics}` : "";
		this.readyWaiter?.reject(new Error(`IPython ${reason}${suffix}`));

		if (!expected) {
			if (kernelPgid) this.terminateProcessGroup(kernelPgid);
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

		const stopping = processStopping.then(() => this.reapProcessGroup(kernelPgid));

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

	shutdown(): Promise<void> {
		return (this.shutdownPromise ??= this.shutdownRuntime());
	}

	private async shutdownRuntime(): Promise<void> {
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

		if (this.outputDirectory) rmSync(this.outputDirectory, { recursive: true, force: true });
	}
}
