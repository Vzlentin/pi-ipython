import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	type ChildConfig,
	type CompleteChild,
	type ExecutionSummary,
	HOST_PROTOCOL_VERSION,
	parseExecutionSummary,
	RlmHostBridge,
} from "./rlm-host.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = join(EXTENSION_DIR, "ipython.py");
const RUNTIME_DIR = join(EXTENSION_DIR, ".rlm-python");
const PYTHON_PATH = join(RUNTIME_DIR, "bin", "python");
const PROVISION_LOCK = join(EXTENSION_DIR, ".rlm-python.lock");
const STARTUP_TIMEOUT_MS = 45_000;
const PROVISION_TIMEOUT_MS = 6 * 60_000;
export const OUTPUT_CAPTURE_LIMIT_BYTES = 1024 * 1024;
export const BRIDGE_PROTOCOL_VERSION = 6;

export interface BridgeResult {
	status: string;
	executionCount?: number;
	error?: { ename?: string; evalue?: string };
	output: string;
	host: ExecutionSummary;
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

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|[@-_][0-?]*[ -/]*[@-~])/g, "");
}

function partialOutput(output: string): string {
	const truncated = truncateTail(stripAnsi(output), {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncated.truncated) return truncated.content || "[no output yet]";
	return `[Live output truncated; showing the tail]\n${truncated.content}`;
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
	private readonly lifecycle = new AbortController();
	private readonly pi: ExtensionAPI;
	private readonly host: RlmHostBridge;

	constructor(pi: ExtensionAPI, completeChild: CompleteChild) {
		this.pi = pi;
		this.host = new RlmHostBridge(completeChild);
	}

	async execute(
		requestId: string,
		code: string,
		config: ChildConfig,
		signal: AbortSignal | undefined,
		onProgress: (message: string) => void,
		onOutput: (output: string) => void,
	): Promise<{ result: BridgeResult; kernelReset: boolean }> {
		if (this.disposed) throw new Error("IPython runtime is shutting down");
		const operationSignal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
		await this.ensureStarted(config.cwd, operationSignal, onProgress);
		if (!this.child || !this.ready) throw new Error("IPython kernel did not start");
		if (this.active) throw new Error("IPython kernel is already executing a cell");
		if (operationSignal.aborted) throw new Error("IPython execution cancelled before it started");

		const kernelReset = this.pendingResetNotice;
		this.pendingResetNotice = false;
		this.host.beginExecution(requestId, config);
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
						`${JSON.stringify({ type: "execute", request_id: requestId, code, cwd: config.cwd })}\n`,
						(error) => {
							if (error) this.handleStdinError(this.child, error);
						},
					);
				} catch (error) {
					this.handleStdinError(this.child, error);
				}
			});
			await this.host.endExecution(requestId, result.status === "ok");
			return { result, kernelReset };
		} catch (error) {
			await this.host.endExecution(requestId, false);
			throw error;
		}
	}

	async getConnectionFile(
		cwd: string,
		signal: AbortSignal | undefined,
		onProgress: (message: string) => void,
	): Promise<string> {
		const operationSignal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
		await this.ensureStarted(cwd, operationSignal, onProgress);
		if (operationSignal.aborted || !this.ready || !this.kernelConnectionFile) {
			throw new Error("IPython kernel is not ready for a viewer");
		}
		return this.kernelConnectionFile;
	}

	private async ensureStarted(
		cwd: string,
		signal: AbortSignal | undefined,
		onProgress: (message: string) => void,
	): Promise<void> {
		if (this.disposed) throw new Error("IPython runtime is shutting down");
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
		const check = await this.pi.exec(PYTHON_PATH, ["-I", "-c", validation], { signal, timeout: 15_000 });
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
		const lockCommand = process.platform === "darwin" ? "lockf" : "flock";
		const lockArgs =
			process.platform === "darwin"
				? ["-k", "-t", "300", PROVISION_LOCK, "bash", "-c", script]
				: ["-w", "300", PROVISION_LOCK, "bash", "-c", script];
		const result = await this.pi.exec(lockCommand, lockArgs, {
			signal,
			timeout: PROVISION_TIMEOUT_MS,
			cwd: EXTENSION_DIR,
		});
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
			if (message.protocol !== BRIDGE_PROTOCOL_VERSION || message.host_protocol !== HOST_PROTOCOL_VERSION) {
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
			if (typeof message.connection_file !== "string" || !isAbsolute(message.connection_file)) {
				this.readyWaiter?.reject(new Error("IPython bridge reported an invalid kernel connection file"));
				this.kill();
				return;
			}
			this.kernelPgid = message.kernel_pgid;
			this.kernelConnectionFile = message.connection_file;
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

		if (message.type === "release" && typeof message.execution_id === "string") {
			this.host.releaseExecution(message.execution_id);
			return;
		}
		if (message.type === "activity" && typeof message.request_id === "string" && typeof message.message === "string") {
			const current = this.active;
			if (current && current.requestId === message.request_id) current.onProgress(message.message);
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
						`IPython output exceeded ${formatSize(OUTPUT_CAPTURE_LIMIT_BYTES)}. The runaway cell was stopped and kernel state was lost. ${captureNotice}\n\n${partialOutput(active.output)}`,
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
			let host: ExecutionSummary;
			try {
				host = parseExecutionSummary(message.host);
			} catch (error) {
				this.active = undefined;
				this.pendingResetNotice = true;
				active.reject(new Error(`IPython bridge returned an invalid execution summary: ${errorText(error)}`));
				this.kill();
				return;
			}
			this.active = undefined;
			active.resolve({
				status: String(message.status ?? "error"),
				executionCount: typeof message.execution_count === "number" ? message.execution_count : undefined,
				error: message.error,
				output: active.output,
				host,
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
		this.kernelConnectionFile = undefined;
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
