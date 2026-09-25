import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { KernelRuntime } from "./kernel-runtime.ts";

export interface RestoreSummary {
	id: string | null;
	cell?: number | null;
	restored?: string[];
	skipped?: Record<string, string>;
	fellBack?: boolean;
}

export function persistenceEnabled(cwd: string): boolean {
	if (process.env.PI_IPYTHON_PERSISTENCE === "0") return false;
	for (let path = resolve(cwd); ; path = dirname(path)) {
		try {
			const config = JSON.parse(readFileSync(join(path, ".pi", "pi-ipython.json"), "utf8"));
			if (config.persistence === false) return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try { lstatSync(join(path, ".git")); break; } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (dirname(path) === path) break;
	}
	return true;
}

export const cacheBase = () => resolve(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"));

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

export function restoreNotice(summary: RestoreSummary): string {
	if (summary.id === null) {
		return [
			"<ipython_state_restored>",
			"No IPython cell on this branch yet; namespace reset to startup state.",
			"</ipython_state_restored>",
		].join("\n");
	}
	const restored = summary.restored?.join(", ") || "none";
	const skipped = Object.entries(summary.skipped ?? {})
		.map(([name, reason]) => `${name} (${reason})`).join("; ") || "none";
	return [
		"<ipython_state_restored>",
		`Kernel state now matches this branch as of In [${summary.cell ?? "?"}]: ${restored}. Not restored: ${skipped}. Variables created on the branch you left are gone.`,
		summary.fellBack ? "The newest checkpoint on this branch was unavailable; used an older one." : undefined,
		"</ipython_state_restored>",
	].filter(Boolean).join("\n");
}

export class Checkpoints {
	private pending: Promise<void> = Promise.resolve();
	private held?: { generation: number; id?: string };
	private storage?: { generation: number; available: boolean };
	private previousSaveMs?: number;
	private readonly kernel: KernelRuntime;
	private readonly directory: string;

	constructor(kernel: KernelRuntime, directory: string) {
		this.kernel = kernel;
		this.directory = directory;
	}

	async sync(branch: SessionEntry[], signal?: AbortSignal): Promise<void> {
		await this.pending;
		const generation = this.kernel.generation;
		const freshKernel = this.storage?.generation !== generation;
		if (freshKernel) {
			try {
				await this.kernel.evaluate(
					`__import__('pi_ipython_state').initialize(get_ipython(), ${JSON.stringify(this.directory)})`,
					{ signal },
				);
				this.storage = { generation, available: true };
			} catch (error) {
				this.storage = { generation, available: false };
				this.kernel.notify(`IPython checkpoint storage unavailable: ${errorText(error)}`);
			}
		}

		const candidates = checkpointIds(branch);
		if (!this.storage?.available) {
			this.held = { generation, id: candidates[0] };
			return;
		}
		const nearest = candidates[0];
		if (this.held?.generation === generation && this.held.id === nearest) return;
		try {
			const summary = await this.kernel.evaluate<RestoreSummary>(
				`__import__('pi_ipython_state').restore(${JSON.stringify(candidates)})`,
				{ timeoutMs: 10_000, signal },
			);
			this.held = { generation: this.kernel.generation, id: nearest };
			if (!(freshKernel && summary.id === null && candidates.length === 0)) {
				this.kernel.notify(restoreNotice(summary));
			}
		} catch (error) {
			this.held = { generation: this.kernel.generation, id: nearest };
			this.kernel.notify(`IPython checkpoint restore failed; continuing with the current namespace: ${errorText(error)}`);
		}
	}

	save(): { id: string; previousSaveMs?: number } {
		const id = randomUUID();
		const result = { id, previousSaveMs: this.previousSaveMs };
		const generation = this.kernel.generation;
		this.held = { generation, id };
		if (this.storage?.generation !== generation || !this.storage.available) return result;
		this.pending = this.pending
			.then(() => new Promise<void>((resolve) => setImmediate(resolve)))
			.then(async () => {
				try {
					const summary = await this.kernel.evaluate<{ duration?: number }>(
						`__import__('pi_ipython_state').save(${JSON.stringify(id)})`,
						{ timeoutMs: 60_000 },
					);
					this.previousSaveMs = typeof summary.duration === "number" ? summary.duration * 1000 : undefined;
				} catch (error) {
					this.previousSaveMs = undefined;
					this.kernel.notify(`IPython checkpoint for this cell was not saved: ${errorText(error)}`);
				}
			});
		return result;
	}

	async close(): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			this.pending,
			new Promise<void>((resolve) => { timer = setTimeout(resolve, 10_000); }),
		]);
		clearTimeout(timer);
	}
}
