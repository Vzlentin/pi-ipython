import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { copyBranch, createExtensionHarness, preserveEnvironment, waitFor } from "./helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-ipython-branches-"));
const cache = join(root, "cache");
const restoreEnvironment = preserveEnvironment("XDG_CACHE_HOME", "PI_IPYTHON_PERSISTENCE");
process.env.XDG_CACHE_HOME = cache;
delete process.env.PI_IPYTHON_PERSISTENCE;
const manager = SessionManager.inMemory(root);
const startup = (event) => event.startupCode.push("startup_only = 7");
let extension = createExtensionHarness({ root, sessionManager: manager, startup });
const manifestPath = (id) => join(cache, "pi-ipython", "checkpoints", "manifests", `${id}.json`);
// Longer than the tool's line limit, so the result keeps only the tail and saves the full output.
const longOutput = (label) => Array.from({ length: 3000 }, (_, index) => `${label} ${index}\n`).join("");
const printLong = (label) => `print(''.join(f'${label} {index}\\n' for index in range(3000)), end='')`;
const alive = (pgid) => {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
};

try {
	// Editing a prompt returns to the state after the shared cells, not abandoned work.
	const userA = extension.user("load and clean the data");
	await extension.cell("x = [1, 2, 3]");
	const cleaned = await extension.cell("df = [value * 2 for value in x]");
	extension.user("first attempt at plotting");
	await extension.cell("abandoned = 'old branch'");
	manager.branch(cleaned.entryId);
	const edited = await extension.cell("print(df, 'abandoned' in globals())");
	assert.match(edited.text, /\[2, 4, 6\] False/);
	assert.match(edited.text, /ipython_state_restored/);

	// A branch before every IPython cell retains startup names and clears user names.
	const later = await extension.cell("later_leaf = 99");
	manager.branch(userA);
	const baseline = await extension.cell("print(startup_only, 'x' in globals(), 'df' in globals())");
	assert.match(baseline.text, /7 False False/);
	assert.match(baseline.text, /namespace reset to startup state/);

	// Returning to a later leaf restores that leaf's namespace.
	manager.branch(later.entryId);
	const returned = await extension.cell("print(df, later_leaf, 'abandoned' in globals())");
	assert.match(returned.text, /\[2, 4, 6\] 99 False/);

	// A cancelled restore is retried on the next call instead of leaving the other branch's names.
	manager.branch(cleaned.entryId);
	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(extension.cell("print('never')", { signal: cancelled.signal }), /cancelled/);
	const retried = await extension.cell("print(df, 'later_leaf' in globals())");
	assert.match(retried.text, /\[2, 4, 6\] False/);
	assert.match(retried.text, /ipython_state_restored/);
	manager.branch(later.entryId);

	// Truncated output is saved in full for the rest of the session.
	const mainLong = await extension.cell(printLong("main"));
	const mainSaved = mainLong.details.fullOutputPath;
	assert.equal(mainLong.details.truncated, true);
	assert.ok(mainLong.text.includes(`Full output saved to: ${mainSaved}`));
	assert.equal(readFileSync(mainSaved, "utf8"), longOutput("main"));

	// A forked SessionManager carries checkpoint details and restores the parent's branch.
	// Its session saves output separately, and its shutdown leaves the parent's output alone.
	const forkManager = SessionManager.inMemory(root);
	copyBranch(manager, forkManager);
	const fork = createExtensionHarness({ root, sessionManager: forkManager, startup });
	let forkSaved;
	try {
		const copied = await fork.cell("print(df, later_leaf)");
		assert.match(copied.text, /\[2, 4, 6\] 99/);
		assert.match(copied.text, /ipython_state_restored/);
		forkSaved = (await fork.cell(printLong("fork"))).details.fullOutputPath;
		assert.equal(readFileSync(forkSaved, "utf8"), longOutput("fork"));
		assert.equal(readFileSync(mainSaved, "utf8"), longOutput("main"));
	} finally {
		await fork.shutdown("quit");
	}
	assert.equal(existsSync(dirname(forkSaved)), false);
	assert.equal(readFileSync(mainSaved, "utf8"), longOutput("main"));

	// If the nearest manifest was evicted, restore the next committed ancestor.
	const older = await extension.cell("older_only = 1");
	const newest = await extension.cell("newest_only = 2");
	await waitFor(() => existsSync(manifestPath(newest.details.checkpoint)));
	rmSync(manifestPath(newest.details.checkpoint));
	manager.branch(older.entryId);
	assert.match((await extension.cell("print(older_only, 'newest_only' in globals())")).text, /1 False/);
	manager.branch(newest.entryId);
	const fallback = await extension.cell("print(older_only, 'newest_only' in globals())");
	assert.match(fallback.text, /1 False/);
	assert.match(fallback.text, /newest checkpoint.*unavailable; used an older one/i);

	// A crash produces no result checkpoint; the next call restores the latest committed cell.
	await extension.cell("stable = 123");
	await assert.rejects(extension.cell("import os; os._exit(17)"), /kernel state was lost/);
	const recovered = await extension.cell("print(stable)");
	assert.match(recovered.text, /123/);
	assert.match(recovered.text, /ipython_kernel_reset/);
	assert.match(recovered.text, /ipython_state_restored/);

	// A failed save leaves live state alone while reporting that the result is uncommitted.
	const manifests = join(cache, "pi-ipython", "checkpoints", "manifests");
	chmodSync(manifests, 0o500);
	const unsaved = await extension.cell("unsaved_live = 77");
	const stillLive = await extension.cell("print(unsaved_live)"); // runs after the failed save
	chmodSync(manifests, 0o700);
	assert.equal(existsSync(manifestPath(unsaved.details.checkpoint)), false);
	assert.match(stillLive.text, /77/);
	assert.match(stillLive.text, /checkpoint for the previous cell was not saved/i);

	// Consecutive calls on one branch do not restore and preserve unpicklable identity.
	await extension.cell(`live_file = open(${JSON.stringify(join(root, "live-resource"))}, 'w+')\nlive_identity = id(live_file)`);
	const consecutive = await extension.cell("print(id(live_file) == live_identity)");
	assert.match(consecutive.text, /True/);
	assert.doesNotMatch(consecutive.text, /ipython_state_restored/);
	await extension.cell("live_file.close()");

	// Cells that a codemode script runs share state with each other and with later direct cells.
	const beforeScripts = extension.user("run a script");
	const script = await extension.codemode(async (ipython) => {
		await ipython("nested = 5");
		return ipython("print(nested * 2)");
	});
	assert.equal(script.value.status, "ok");
	assert.equal(script.value.output, "10\n");
	assert.deepEqual(script.value.notices, []);
	assert.doesNotMatch(script.text, /ipython_state_restored/);
	const afterScript = await extension.cell("print(nested)");
	assert.match(afterScript.text, /5/);
	assert.doesNotMatch(afterScript.text, /ipython_state_restored/);

	// A Python exception reaches the script as data, and the next cell runs on the same kernel.
	const raised = await extension.codemode(async (ipython) => [
		await ipython("before_error = 1\nraise ValueError('as data')"),
		await ipython("before_error + 1"),
	]);
	assert.equal(raised.value[0].status, "error");
	assert.deepEqual(raised.value[0].error, { ename: "ValueError", evalue: "as data" });
	assert.match(raised.value[0].output, /ValueError: as data/);
	assert.equal(raised.value[1].output, "2\n");
	assert.equal(raised.isError, false);
	for (const result of raised.value) assert.deepEqual(result.notices, []);
	assert.doesNotMatch(raised.text, /ipython_kernel_reset/);

	// Cancelling a running cell interrupts it and keeps the kernel state.
	const interrupted = await extension.codemode(async (ipython) => {
		const controller = new AbortController();
		const stopped = await ipython("print('cell running', flush=True)\nimport time\ntime.sleep(30)", {
			signal: controller.signal,
			onUpdate: (update) => { if (update.content[0].text.includes("cell running")) controller.abort(); },
		});
		return [stopped, await ipython("before_error")];
	});
	assert.equal(interrupted.value[0].status, "error");
	assert.equal(interrupted.value[0].error.ename, "Interrupted");
	assert.equal(interrupted.value[1].output, "1\n");
	for (const result of interrupted.value) assert.deepEqual(result.notices, []);
	assert.equal(interrupted.isError, false);
	assert.doesNotMatch(interrupted.text, /ipython_kernel_reset/);

	// The script reports kernel loss even if it catches the rejection or ends without another cell.
	for (const caught of [true, false]) {
		const processes = await extension.cell([
			"import os, subprocess, sys",
			"_child_code = \"import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('ready', flush=True); time.sleep(60)\"",
			"_crash_child = subprocess.Popen([sys.executable, '-c', _child_code], stdout=subprocess.PIPE, text=True)",
			"assert _crash_child.stdout.readline() == 'ready\\n'",
			"print(os.getpgid(0), os.getpgid(_crash_child.pid))",
		].join("\n"));
		const [pgid, childPgid] = processes.structuredContent.output.trim().split(/\s+/).map(Number);
		assert.ok(Number.isSafeInteger(pgid) && pgid > 1);
		assert.equal(childPgid, pgid);
		assert.equal(alive(pgid), true);
		const stoppedScript = await extension.codemode(async (ipython) => {
			const crash = ipython("import os; os._exit(17)");
			if (caught) {
				await assert.rejects(crash, /kernel state was lost/);
				return { unrelated: 42 };
			}
			return crash;
		});
		assert.equal(stoppedScript.isError, !caught);
		if (caught) assert.deepEqual(stoppedScript.value, { unrelated: 42 });
		else assert.match(stoppedScript.text, /Script failed[\s\S]*kernel state was lost/);
		// Cleanup must finish before another cell or shutdown can hide a leaked child.
		await waitFor(() => !alive(pgid));
		assert.equal(alive(pgid), false);
		assert.match(stoppedScript.text, /<ipython_kernel_reset>[\s\S]*in-memory[\s\S]*lost[\s\S]*<\/ipython_kernel_reset>/);
		assert.doesNotMatch(stoppedScript.text, /was restarted/);
		const unrelated = await extension.codemode(() => "no cells");
		assert.equal(unrelated.value, "no cells");
		assert.equal(unrelated.isError, false);
		assert.doesNotMatch(unrelated.text, /ipython_kernel_reset/);
		const restored = await extension.cell("print(before_error)");
		assert.equal(restored.structuredContent.output, "1\n");
		assert.equal(restored.details.kernelReset, true);
		assert.match(restored.text, /ipython_kernel_reset[\s\S]*ipython_state_restored/);
	}

	// A lost kernel rejects the call. The next cell reports the reset to the script, and the model sees it too.
	const crashed = await extension.codemode(async (ipython) => {
		await assert.rejects(ipython("import os; os._exit(17)"), /kernel state was lost/);
		return ipython("print(before_error)");
	});
	assert.equal(crashed.value.output, "1\n");
	assert.match(crashed.value.notices.join("\n"), /ipython_kernel_reset[\s\S]*ipython_state_restored/);
	assert.match(crashed.text, /ipython_kernel_reset[\s\S]*ipython_state_restored/);

	// Saved output outlives later cells, crashes and cancellation. A script's cell saves to a new file.
	assert.equal(readFileSync(mainSaved, "utf8"), longOutput("main"));
	const scriptLong = await extension.codemode((ipython) => ipython(printLong("script")));
	const scriptSaved = scriptLong.value.fullOutputPath;
	assert.notEqual(scriptSaved, mainSaved);
	assert.equal(readFileSync(scriptSaved, "utf8"), longOutput("script"));
	assert.equal(readFileSync(mainSaved, "utf8"), longOutput("main"));

	// A failed script keeps the state of its earlier cells, and a reload restores it.
	// The reload removes the session's saved output.
	const failedScript = await extension.codemode(async (ipython) => {
		await ipython("partial_work = 'kept'");
		throw new Error("script fixture");
	});
	assert.equal(failedScript.isError, true);
	await extension.shutdown("reload");
	for (const saved of [mainSaved, scriptSaved]) assert.equal(existsSync(dirname(saved)), false);
	extension = createExtensionHarness({ root, sessionManager: manager, startup });
	const reloaded = await extension.cell("print(nested, partial_work)");
	assert.match(reloaded.text, /5 kept/);
	assert.match(reloaded.text, /ipython_state_restored/);

	// A branch before the scripts drops their names.
	manager.branch(beforeScripts);
	const beforeState = await extension.cell("print('nested' in globals(), 'partial_work' in globals())");
	assert.match(beforeState.text, /False False/);

	// The other shutdown reasons also remove saved output, after a crash leaves no kernel. A repeated shutdown is harmless.
	for (const reason of ["new", "resume", "fork"]) {
		const session = createExtensionHarness({ root, sessionManager: SessionManager.inMemory(root), startup });
		let saved;
		try {
			saved = (await session.cell(printLong(reason))).details.fullOutputPath;
			assert.equal(readFileSync(saved, "utf8"), longOutput(reason));
			await assert.rejects(session.cell("import os; os._exit(17)"), /kernel state was lost/);
		} finally {
			await session.shutdown(reason);
		}
		await session.shutdown(reason);
		assert.equal(existsSync(dirname(saved)), false);
	}
} finally {
	try { chmodSync(join(cache, "pi-ipython", "checkpoints", "manifests"), 0o700); } catch {}
	await extension.shutdown("quit");
	rmSync(root, { recursive: true, force: true });
	restoreEnvironment();
}

console.log("branches: edit, empty branch, later leaf, fork, fallback, crash, failed save, no-op sync, codemode cells and saved output passed");
