import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { KERNEL_STARTING_EVENT, KernelRuntime } from "../extensions/kernel-runtime.ts";

const exec = promisify(execFile);
const bus = new EventEmitter();
const pi = {
	events: { emit: (channel, data) => bus.emit(channel, data), on: (channel, handler) => bus.on(channel, handler) },
	async exec(command, args, options) {
		try {
			return { ...await exec(command, args, options), code: 0 };
		} catch (error) {
			return { code: error.code ?? 1, stderr: error.stderr ?? error.message, stdout: error.stdout ?? "" };
		}
	},
};

const run = (kernel, id, code, cwd) => kernel.execute(id, code, cwd, undefined, () => {}, () => {});
const alive = (pgid) => {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
};
const pgidOf = async (kernel, cwd) =>
	Number((await run(kernel, "pgid", "import os; print(os.getpgid(0))", cwd)).result.output.trim());

const root = mkdtempSync(join(tmpdir(), "pi-ipython-kernel-"));
const first = join(root, "first");
const second = join(root, "second");
await exec("mkdir", [first, second]);

// With no listener, the kernel runs, keeps state, applies each cell's cwd, resets and cleans up.
const plain = new KernelRuntime(pi);
let plainPgid;
try {
	const one = await run(plain, "one", "import os\nvalue = 41\nprint(os.getcwd())", first);
	assert.equal(one.result.status, "ok");
	assert.equal(one.result.output.trim(), first);
	const two = await run(plain, "two", "print(value + 1, os.getcwd())", second);
	assert.equal(two.result.output.trim(), `42 ${second}`);
	const failed = await run(plain, "fail", "raise ValueError('fixture')", second);
	assert.equal(failed.result.status, "error");
	assert.deepEqual(failed.result.error, { ename: "ValueError", evalue: "fixture" });
	assert.equal((await run(plain, "kept", "print(value)", second)).result.output.trim(), "41");
	const hidden = await run(plain, "rlm", "print('rlm' in globals())", second);
	assert.equal(hidden.result.output.trim(), "False");

	const oldPgid = await pgidOf(plain, first);
	const abort = new AbortController();
	await assert.rejects(
		plain.execute("cancel", "import asyncio\nprint('ready', flush=True)\nawait asyncio.sleep(60)", first, abort.signal,
			() => {}, (text) => { if (text.includes("ready")) abort.abort(); }),
		/cancelled/,
	);
	assert.equal(alive(oldPgid), false);
	const reset = await run(plain, "reset", "print('value' in globals())", first);
	assert.equal(reset.kernelReset, true);
	assert.equal(reset.result.output.trim(), "False");
	plainPgid = await pgidOf(plain, first);
} finally {
	await plain.shutdown();
}
assert.equal(alive(plainPgid), false);

// A listener's environment and startup code reach every kernel start, after its promise settles.
let starts = 0;
bus.on(KERNEL_STARTING_EVENT, (event) => {
	starts += 1;
	event.startupCode.push(`hook_value = ${starts}`);
	event.waitFor(new Promise((resolve) => setTimeout(resolve, 50)).then(() => {
		event.env.PI_IPYTHON_HOOK = `env-${starts}`;
	}));
});
const hooked = new KernelRuntime(pi);
try {
	const seen = await run(hooked, "hook", "import os\nprint(hook_value, os.environ['PI_IPYTHON_HOOK'])", first);
	assert.equal(seen.result.output.trim(), "1 env-1");
	assert.equal(process.env.PI_IPYTHON_HOOK, undefined);
	const abort = new AbortController();
	await assert.rejects(
		hooked.execute("cancel", "import asyncio\nprint('ready', flush=True)\nawait asyncio.sleep(60)", first, abort.signal,
			() => {}, (text) => { if (text.includes("ready")) abort.abort(); }),
		/cancelled/,
	);
	const again = await run(hooked, "again", "import os\nprint(hook_value, os.environ['PI_IPYTHON_HOOK'])", first);
	assert.equal(again.kernelReset, true);
	assert.equal(again.result.output.trim(), "2 env-2");
} finally {
	await hooked.shutdown();
}

// A failing startup snippet fails the kernel start instead of running cells without it.
bus.removeAllListeners(KERNEL_STARTING_EVENT);
bus.on(KERNEL_STARTING_EVENT, (event) => event.startupCode.push("raise RuntimeError('startup fixture')"));
const broken = new KernelRuntime(pi);
try {
	await assert.rejects(run(broken, "broken", "print(1)", first), /startup fixture/);
} finally {
	await broken.shutdown();
	rmSync(root, { recursive: true, force: true });
}

console.log("kernel: state, cwd, reset, cleanup, startup hook and startup failure passed");
