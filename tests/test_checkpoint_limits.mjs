import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createExtensionHarness, createKernel, preserveEnvironment, runKernel,
} from "./helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-ipython-limits-"));
const restoreEnvironment = preserveEnvironment("XDG_CACHE_HOME", "PI_IPYTHON_PERSISTENCE");
process.env.XDG_CACHE_HOME = join(root, "cache");
delete process.env.PI_IPYTHON_PERSISTENCE;

try {
	const base = join(root, "state");
	mkdirSync(base, { mode: 0o700 });
	const kernel = createKernel();
	try {
		await kernel.start(root, undefined, () => {});
		await kernel.evaluate(`__import__('pi_ipython_state').initialize(get_ipython(), ${JSON.stringify(base)})`);
		const setup = await runKernel(kernel, `
import asyncio, functools, pickle, math
value = 10
def f(): return value
functions = {f}
keys = {f: 'function key'}
partial = functools.partial(f)
def make(x):
    def inner(): return x + value
    return inner
closure = make(2)
class Slotted:
    __slots__ = ('fn',)
slotted = Slotted()
slotted.fn = f
class Stateful:
    def __getstate__(self): return {}
    def __setstate__(self, state): self.n = math.sqrt(value * value)
stateful = Stateful()
class Buffer:
    def __reduce_ex__(self, protocol):
        return bytes, (pickle.PickleBuffer(bytes(1100000)),)
buffer = Buffer()
class Estimated:
    nbytes = 65 * 1024 * 1024
    def __reduce__(self): raise AssertionError('must not pickle estimate')
estimated = Estimated()
wrapped = [bytes(65 * 1024 * 1024)]
file = open(${JSON.stringify(join(root, "resource"))}, 'w+')
task = asyncio.create_task(asyncio.sleep(60))
a1 = a2 = a3 = a4 = a5 = bytes(63 * 1024 * 1024)
`, root);
		assert.equal(setup.result.status, "ok", setup.result.output);
		const id = randomUUID();
		await kernel.evaluate(`__import__('pi_ipython_state').save(${JSON.stringify(id)})`);
		const checkpointRoot = join(base, "pi-ipython", "checkpoints");
		const manifest = JSON.parse(readFileSync(join(checkpointRoot, "manifests", `${id}.json`), "utf8"));
		assert.match(manifest.skipped.estimated, /64 MB.*size estimate/);
		assert.match(manifest.skipped.wrapped, /64 MB/);
		assert.match(manifest.skipped.file, /live file resource/);
		assert.match(manifest.skipped.task, /live Task/);
		assert.match(manifest.skipped.a5, /checkpoint full/);
		assert.ok(manifest.bytes <= 256 * 1024 * 1024);
		assert.ok(manifest.saved.some((entry) => entry.name === "buffer"));
		const arrays = manifest.saved.filter((entry) => /^a[1-4]$/.test(entry.name));
		assert.equal(new Set(arrays.map((entry) => entry.blob)).size, 1);
		const diskBytes = readdirSync(join(checkpointRoot, "blobs"))
			.reduce((total, name) => total + statSync(join(checkpointRoot, "blobs", name)).size, 0);
		assert.ok(diskBytes < 70 * 1024 * 1024, `expected deduplicated disk use, saw ${diskBytes}`);

		await runKernel(kernel, "%reset -f", root);
		const summary = await kernel.evaluate(`__import__('pi_ipython_state').restore([${JSON.stringify(id)}])`);
		assert.equal(summary.id, id);
		const loaded = await runKernel(
			kernel,
			"value = 25\nprint(next(iter(functions))(), next(iter(keys))(), partial(), closure(), slotted.fn(), stateful.n, len(buffer), len(a4))",
			root,
		);
		assert.equal(loaded.result.output.trim(), `25 25 25 27 25 10.0 1100000 ${63 * 1024 * 1024}`);
		await runKernel(kernel, "task.cancel() if 'task' in globals() else None\nfile.close() if 'file' in globals() else None", root);
	} finally {
		await kernel.shutdown();
	}

	// A hung unpickler is interrupted after the restore deadline; the same kernel remains usable.
	const hangRoot = join(root, "hang");
	mkdirSync(hangRoot);
	process.env.XDG_CACHE_HOME = join(hangRoot, "cache");
	const manager = SessionManager.inMemory(hangRoot);
	let extension = createExtensionHarness({ root: hangRoot, sessionManager: manager });
	await extension.cell("class Hang:\n    def __setstate__(self, state): __import__('time').sleep(60)\nhang = Hang()\nhang.v = 1\nkept = 5");
	await extension.cell("print(kept)"); // waits for the checkpoint containing Hang
	await extension.shutdown("reload");
	extension = createExtensionHarness({ root: hangRoot, sessionManager: manager });
	try {
		const hung = await extension.cell("print('kept' in globals())");
		assert.match(hung.text, /False/);
		assert.match(hung.text, /checkpoint restore failed/i);
		assert.equal(hung.details.kernelReset, false);
		assert.equal((await extension.cell("print(1 + 1)")).text.trim(), "2");
	} finally {
		await extension.shutdown();
	}
} finally {
	rmSync(root, { recursive: true, force: true });
	restoreEnvironment();
}

console.log("checkpoint limits: buffers, rebound functions, live resources, per-value/total caps, dedup and hung restore passed");
