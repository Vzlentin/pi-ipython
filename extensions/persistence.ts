import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { errorText, KernelRuntime } from "./kernel-runtime.ts";

const RESTORE_TIMEOUT_MS = 10_000;
const SAVE_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 10_000;
// A value whose unpickling kills the kernel is deleted by the next attempt, so each
// attempt after the first gets past one more such value.
const RESTORE_ATTEMPTS = 3;

/** Returned by `pi_ipython_state.restore`; `null` means the namespace already matches the branch. */
type RestoreSummary =
	| { status: "unavailable"; error: string }
	| { status: "empty"; fellBack: boolean }
	| {
		status: "restored";
		id: string;
		cell: number;
		restored: string[];
		skipped: Record<string, string>;
		fellBack: boolean;
	};

function persistenceEnabled(cwd: string): boolean {
	if (process.env.PI_IPYTHON_PERSISTENCE === "0") return false;
	for (let path = resolve(cwd); ; path = dirname(path)) {
		const configPath = join(path, ".pi", "pi-ipython.json");
		let text: string | undefined;
		try {
			text = readFileSync(configPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (text !== undefined) {
			let config: unknown;
			try {
				config = JSON.parse(text);
			} catch (error) {
				throw new Error(`Invalid IPython configuration ${configPath}: ${errorText(error)}`);
			}
			if ((config as { persistence?: unknown } | null)?.persistence === false) return false;
		}
		try {
			lstatSync(join(path, ".git"));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (dirname(path) === path) break;
	}
	return true;
}

/** Creates and resolves the cache base once; the kernel refuses symlinks below it. */
function checkpointBase(): string {
	const base = resolve(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"));
	mkdirSync(base, { recursive: true });
	return realpathSync(base);
}

/** Creates the kernel and its checkpoints, enabled unless `cwd` opts out. */
export function createRuntime(pi: ExtensionAPI, cwd: string): { kernel: KernelRuntime; checkpoints: Checkpoints } {
	if (!persistenceEnabled(cwd)) {
		const kernel = new KernelRuntime(pi);
		return { kernel, checkpoints: new Checkpoints(kernel, false) };
	}
	// Runs after all other startup code, so names supplied by extensions are never checkpointed.
	const initialize = `__import__('pi_ipython_state').initialize(get_ipython(), ${JSON.stringify(checkpointBase())})`;
	const kernel = new KernelRuntime(pi, [initialize]);
	return { kernel, checkpoints: new Checkpoints(kernel, true) };
}

function checkpointIds(branch: SessionEntry[]): string[] {
	const ids: string[] = [];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		if (entry.message.toolName !== "ipython") continue;
		const checkpoint = (entry.message.details as { checkpoint?: unknown } | undefined)?.checkpoint;
		if (typeof checkpoint === "string") ids.push(checkpoint);
	}
	return ids;
}

function restoreNotice(summary: RestoreSummary): string {
	if (summary.status === "unavailable") return `IPython checkpoint storage unavailable: ${summary.error}`;
	if (summary.status === "empty") {
		return [
			"<ipython_state_restored>",
			summary.fellBack
				? "No checkpoint on this branch is available; namespace reset to startup state."
				: "No IPython cell on this branch yet; namespace reset to startup state.",
			"</ipython_state_restored>",
		].join("\n");
	}
	const restored = summary.restored.join(", ") || "none";
	const skipped = Object.entries(summary.skipped)
		.map(([name, reason]) => `${name} (${reason})`).join("; ") || "none";
	return [
		"<ipython_state_restored>",
		`Kernel state now matches this branch as of In [${summary.cell}]: ${restored}. Not restored: ${skipped}. Variables created on the branch you left are gone.`,
		summary.fellBack ? "The newest checkpoint on this branch was unavailable; used an older one." : undefined,
		"</ipython_state_restored>",
	].filter(Boolean).join("\n");
}

/**
 * Saves the namespace after each cell and restores the current branch's nearest checkpoint
 * before the next. Which checkpoint the namespace holds is tracked inside the kernel.
 */
export class Checkpoints {
	private pending: Promise<void> = Promise.resolve();
	private saveFailure?: string;
	private readonly kernel: KernelRuntime;
	private readonly enabled: boolean;

	/** With `enabled` false, sync and save do nothing. */
	constructor(kernel: KernelRuntime, enabled: boolean) {
		this.kernel = kernel;
		this.enabled = enabled;
	}

	/** Starts the kernel and restores the branch's state. Returns notices for the next result. */
	sync(
		branch: SessionEntry[],
		cwd: string,
		signal: AbortSignal | undefined,
		onProgress: (message: string) => void,
	): Promise<string[]> {
		if (!this.enabled) return Promise.resolve([]);
		// Serialized with saves and other syncs; the kernel refuses overlapping requests as busy.
		const run = this.pending.then(() => this.restoreBranch(checkpointIds(branch), cwd, signal, onProgress));
		this.pending = run.then(() => {}, () => {});
		return run;
	}

	private async restoreBranch(
		candidates: string[],
		cwd: string,
		signal: AbortSignal | undefined,
		onProgress: (message: string) => void,
	): Promise<string[]> {
		await this.kernel.start(cwd, signal, onProgress);
		let notice: string | undefined;
		for (let attempt = 1; ; attempt += 1) {
			const generation = this.kernel.generation;
			notice = await this.restore(candidates, signal);
			await this.kernel.start(cwd, signal, onProgress);
			if (this.kernel.generation === generation) break;
			if (attempt === RESTORE_ATTEMPTS) {
				notice = `IPython checkpoint restore killed the kernel ${RESTORE_ATTEMPTS} times; continuing on a fresh kernel. The next call retries without the values that killed it.`;
				break;
			}
		}
		const notices = [this.saveFailure, notice].filter((text): text is string => text !== undefined);
		this.saveFailure = undefined;
		return notices;
	}

	private async restore(candidates: string[], signal: AbortSignal | undefined): Promise<string | undefined> {
		try {
			const summary = await this.call("restore", [candidates], { timeoutMs: RESTORE_TIMEOUT_MS, signal });
			return summary === null ? undefined : restoreNotice(summary as RestoreSummary);
		} catch (error) {
			// A cancelled restore leaves the namespace marked partial, so the next sync restores again.
			if (signal?.aborted) throw error;
			// A restore that failed or timed out is not retried. The kernel may be dead, in which case
			// its successor starts with nothing loaded and the retry loop restores again.
			await this.call("accept", [candidates[0] ?? null]).catch(() => {});
			return `IPython checkpoint restore failed; continuing with the current namespace: ${errorText(error)}`;
		}
	}

	/** Queues a save of the namespace after a cell and returns its checkpoint ID. */
	save(): string | undefined {
		if (!this.enabled) return undefined;
		const id = randomUUID();
		this.pending = this.pending
			.then(() => new Promise<void>((resolve) => setImmediate(resolve)))
			.then(() => this.call("save", [id], { timeoutMs: SAVE_TIMEOUT_MS }))
			.then(() => {}, (error) => {
				this.saveFailure = `IPython checkpoint for the previous cell was not saved: ${errorText(error)}`;
			});
		return id;
	}

	async close(): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			this.pending,
			new Promise<void>((resolve) => { timer = setTimeout(resolve, CLOSE_TIMEOUT_MS); }),
		]);
		clearTimeout(timer);
	}

	private call(name: string, args: unknown[], options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
		const payload = JSON.stringify(JSON.stringify(args));
		return this.kernel.evaluate(
			`__import__('pi_ipython_state').${name}(*__import__('json').loads(${payload}))`,
			options,
		);
	}
}
