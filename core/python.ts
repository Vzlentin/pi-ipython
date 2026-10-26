import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// pyproject.toml and uv.lock in this directory define the Python environment; uv installs it in .python.
export const CORE_DIR = dirname(fileURLToPath(import.meta.url));
const PYTHON_DIR = join(CORE_DIR, ".python");
const SYNC_TIMEOUT_MS = 6 * 60_000;
const CHECK_TIMEOUT_MS = 15_000;
const CANCELLED = "Python environment provisioning cancelled";
const execFileAsync = promisify(execFile);

export const PYTHON_PATH = join(PYTHON_DIR, "bin", "python");

/** The Jupyter data directory of the Python environment. It holds the kernelspec that consoles find. */
export const JUPYTER_DATA_DIR = join(PYTHON_DIR, "share", "jupyter");

/** Runs uv on the environment of this directory. A failure rejects with uv's stderr in its message. */
function uv(args: string[], timeout: number, signal: AbortSignal | undefined) {
	const env = { ...process.env, UV_PROJECT_ENVIRONMENT: PYTHON_DIR };

	return execFileAsync("uv", args, { env, signal, timeout, maxBuffer: 16 * 1024 * 1024 });
}

/**
 * Syncs the Python environment with uv.lock when the offline check finds drift.
 * Packages that are not in uv.lock stay, so packages that an agent installs survive other sessions.
 */
export async function syncEnvironment(
	signal: AbortSignal | undefined,
	onProgress: (message: string) => void,
): Promise<void> {
	// uv locks the environment while it syncs, so concurrent hosts can provision at the same time.
	const sync = ["sync", "--locked", "--inexact", "--no-config", "--managed-python", "--project", CORE_DIR];

	try {
		// The check runs before every first kernel start, so it stays offline and keeps out of the uv cache.
		await uv([...sync, "--check", "--offline", "--no-cache", "--quiet"], CHECK_TIMEOUT_MS, signal);

		return;
	} catch {
		if (signal?.aborted) throw new Error(CANCELLED);
	}

	onProgress("Provisioning the extension-owned Python 3.12 environment with uv...");

	try {
		await uv(sync, SYNC_TIMEOUT_MS, signal);
	} catch (error) {
		if (signal?.aborted) throw new Error(CANCELLED);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to provision the Python environment with uv:\n${message}`);
	}
}
