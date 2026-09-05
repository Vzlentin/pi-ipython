import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shellQuote } from "./kernel-runtime.ts";

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

export class CellsView {
	private readonly pi: ExtensionAPI;
	private directory?: string;
	private paneId?: string;
	private connectionFile?: string;
	private toggling?: Promise<void>;
	private disposed = false;
	private readonly lifecycle = new AbortController();
	private failure?: string;
	private bytes = 0;
	private full = false;
	private count = 0;
	private started = 0;
	private latestOutput = "";

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	private file(): string {
		if (!this.directory) {
			this.directory = mkdtempSync(join(tmpdir(), "pi-ipython-cells-"));
			writeFileSync(join(this.directory, "cells.txt"),
				"IPython cells recorded before this console opened. New cells appear live below the prompt.\n",
				{ mode: 0o600 });
		}
		return join(this.directory, "cells.txt");
	}

	private append(value: string): void {
		if (this.disposed || this.failure || this.full) return;
		try {
			const text = stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
			this.bytes += Buffer.byteLength(text);
			// ponytail: cap each session at 16 MiB; rotate transcripts if longer history is needed.
			if (this.bytes > MAX_TRANSCRIPT_BYTES) {
				appendFileSync(this.file(), "\n[History limit reached (16 MiB). Recording stopped until /reload.]\n");
				this.full = true;
			} else {
				appendFileSync(this.file(), text);
			}
		} catch (error) {
			// A display failure must not change cell execution or its result.
			this.failure = String(error);
		}
	}

	begin(code: string): void {
		this.count++;
		this.started = Date.now();
		this.latestOutput = "";
		this.append(`\n=== Cell ${this.count} | running ===\n>>> ${code.replaceAll("\n", "\n... ")}\n\n`);
	}

	output(text: string): void {
		if (!text.startsWith(this.latestOutput)) this.note("output cleared/replaced");
		this.append(text.startsWith(this.latestOutput) ? text.slice(this.latestOutput.length) : text);
		this.latestOutput = text;
	}

	note(message: string): void {
		this.append(`\n[${message}]\n`);
	}

	finish(status: string): void {
		this.note(`Cell ${this.count} | ${status} | ${((Date.now() - this.started) / 1000).toFixed(1)}s`);
		this.latestOutput = "";
	}

	private async herdr(args: string[], timeout = 5_000, signal?: AbortSignal): Promise<any> {
		const result = await this.pi.exec("herdr", args, { timeout, signal });
		if (result.code !== 0) {
			let missing = false;
			try { missing = JSON.parse(result.stderr).error?.code === `${args[0]}_not_found`; } catch {}
			if (missing && (args[1] === "get" || args[1] === "close")) return undefined;
			throw new Error(result.stderr || "Herdr command failed");
		}
		if (args[1] === "wait-output") return;
		return result.stdout.trim() ? JSON.parse(result.stdout).result : undefined;
	}

	private async closePane(): Promise<void> {
		if (!this.paneId) return;
		await this.herdr(["pane", "close", this.paneId]);
		this.paneId = undefined;
		this.connectionFile = undefined;
		if (this.directory) rmSync(join(this.directory, "kernel.json"), { force: true });
	}

	toggle(cwd: string, connectionFile: string): Promise<void> {
		if (this.toggling) return this.toggling;
		this.toggling = this.togglePane(cwd, connectionFile).finally(() => { this.toggling = undefined; });
		return this.toggling;
	}

	private async togglePane(cwd: string, connectionFile: string): Promise<void> {
		if (this.disposed) return;
		if (process.env.HERDR_ENV !== "1") throw new Error("/cells requires a Herdr pane.");
		if (this.failure) throw new Error(`Cell history unavailable: ${this.failure}`);
		if (this.paneId) {
			const existing = await this.herdr(["pane", "get", this.paneId]);
			const sameConnection = connectionFile === this.connectionFile;
			await this.closePane();
			if (existing && sameConnection) return;
		}
		const file = this.file();
		// Keep a private copy: if the kernel exits during launch, the console must not create a new kernel.
		const connectionCopy = join(dirname(file), "kernel.json");
		writeFileSync(connectionCopy, readFileSync(connectionFile), { mode: 0o600 });
		// History stays in terminal scrollback; Euporie renders new cells without replaying old code.
		const command = `cat ${shellQuote(file)}; exec ${[
			// Euporie needs a discoverable kernelspec even when attaching to an existing kernel.
			"env", `JUPYTER_PATH=${fileURLToPath(new URL("./.rlm-python/share/jupyter", import.meta.url))}`,
			"uv", "tool", "run", "--no-config", "--python", "3.12", "--from", "euporie==2.10.4",
			"euporie-console", "--connection-file", connectionCopy, "--kernel-name", "python3",
			"--show-remote-inputs", "--show-remote-outputs", "--no-mouse-support", "--no-lsp",
		].map(shellQuote).join(" ")}`;
		// ponytail: after a kernel reset, repeat /cells to reconnect; automate only if this becomes disruptive.
		const target = (await this.herdr(["pane", "current", "--current"]))?.pane;
		if (![target?.pane_id, target?.tab_id, target?.workspace_id].every((id) => typeof id === "string" && id)) {
			throw new Error("Herdr did not return the calling pane.");
		}
		const staging = await this.herdr([
			"tab", "create", "--workspace", target.workspace_id, "--cwd", cwd, "--label", "Starting IPython viewer", "--no-focus",
		]);
		const tabId = staging?.tab?.tab_id;
		if (typeof tabId !== "string" || !tabId) throw new Error("Herdr did not return a tab ID.");
		try {
			const paneId = staging?.root_pane?.pane_id;
			if (typeof paneId !== "string" || !paneId) throw new Error("Herdr did not return a pane ID.");
			this.paneId = paneId;
			// Replace the shell so quitting the viewer cannot leave a reusable shell that we later close.
			await this.herdr(["pane", "rename", paneId, "IPython console"]);
			await this.herdr(["pane", "run", paneId, `printf '\\033[2J\\033[3J\\033[H'; ${command}`]);
			await this.herdr([
				"pane", "wait-output", paneId, "--source", "visible", "--regex", "In \\[\\d*\\]:", "--timeout", "120000",
			], 125_000, this.lifecycle.signal);
			if (this.disposed) throw new Error("IPython viewer startup cancelled");
			const moved = await this.herdr([
				"pane", "move", paneId, "--tab", target.tab_id, "--split", "right", "--target-pane", target.pane_id, "--no-focus",
			]);
			const movedId = moved?.move_result?.pane?.pane_id;
			if (typeof movedId !== "string" || !movedId) throw new Error("Herdr did not return the moved pane ID.");
			this.paneId = movedId;
			this.connectionFile = connectionFile;
		} catch (error) {
			await this.closePane().catch(() => {});
			throw error;
		} finally {
			// Moving the only pane normally removes this tab already.
			await this.herdr(["tab", "close", tabId]);
		}
	}

	async shutdown(): Promise<void> {
		this.disposed = true;
		this.lifecycle.abort();
		await this.toggling?.catch(() => {});
		try {
			await this.closePane();
		} finally {
			if (this.directory) rmSync(this.directory, { recursive: true, force: true });
		}
	}
}
