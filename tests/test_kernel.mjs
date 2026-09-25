import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKernel, runKernel } from "./helpers.mjs";

const run = (kernel, _id, code, cwd) => runKernel(kernel, code, cwd);
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
mkdirSync(first);
mkdirSync(second);

// With no listener, the kernel runs, keeps state, applies each cell's cwd, resets and cleans up.
const plain = createKernel();
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
	assert.deepEqual(await plain.evaluate("{'answer': [41, 42]}"), { answer: [41, 42] });
	await assert.rejects(plain.evaluate("(_ for _ in ()).throw(ValueError('evaluate fixture'))"), /evaluate fixture/);
	await assert.rejects(
		plain.evaluate("(__import__('time').sleep(60), None)[1]", { timeoutMs: 50 }),
		/evaluation exceeded/,
	);
	assert.equal((await run(plain, "after-evaluate", "print(value)", first)).result.output.trim(), "41");

	const oldPgid = await pgidOf(plain, first);
	for (const code of ["import asyncio\nawait asyncio.sleep(60)", "import time\ntime.sleep(60)"]) {
		const controller = new AbortController();
		const interrupted = await plain.execute("cancel", `print('ready', flush=True)\n${code}`, first, controller.signal,
			() => {}, (text) => { if (text.includes("ready")) controller.abort(); });
		assert.equal(interrupted.result.status, "error");
		assert.match(interrupted.result.output, /interrupted, kernel state preserved/);
		assert.match(interrupted.result.output, /ready/);
		assert.equal(alive(oldPgid), true);
		assert.equal((await run(plain, "kept", "print(value)", first)).result.output.trim(), "41");
	}
	const overflow = await run(plain, "overflow", "while True: print('x' * 10000, flush=True)", first);
	assert.equal(overflow.result.status, "error");
	assert.match(overflow.result.output, /Captured output saved to:/);
	assert.match(overflow.result.output, /kernel state preserved/);
	assert.equal((await run(plain, "kept", "print(value)", first)).result.output.trim(), "41");
	plain.notify("notice queued before reset");
	const generation = plain.generation;
	const began = Date.now();
	await assert.rejects(
		plain.evaluate("(__import__('signal').signal(2, __import__('signal').SIG_IGN), __import__('time').sleep(60))[1]", { timeoutMs: 50 }),
		/did not stop within 3s/,
	);
	assert.ok(Date.now() - began >= 3000);
	assert.equal(alive(oldPgid), false);
	const reset = await run(plain, "reset", "print('value' in globals())", first);
	assert.equal(reset.kernelReset, true);
	assert.match(reset.notice, /notice queued before reset/);
	assert.match(reset.notice, /ipython_kernel_reset/);
	assert.ok(plain.generation > generation);
	assert.equal(reset.result.output.trim(), "False");
	plainPgid = await pgidOf(plain, first);
} finally {
	await plain.shutdown();
}
assert.equal(alive(plainPgid), false);

// A listener's environment and startup code reach every kernel start, after its promise settles.
let starts = 0;
const hooked = createKernel((event) => {
	starts += 1;
	event.startupCode.push(`hook_value = ${starts}`);
	event.waitFor(new Promise((resolve) => setTimeout(resolve, 50)).then(() => {
		event.env.PI_IPYTHON_HOOK = `env-${starts}`;
	}));
});
try {
	const seen = await run(hooked, "hook", "import os\nprint(hook_value, os.environ['PI_IPYTHON_HOOK'])", first);
	assert.equal(seen.result.output.trim(), "1 env-1");
	assert.equal(process.env.PI_IPYTHON_HOOK, undefined);
	await assert.rejects(run(hooked, "crash", "os._exit(1)", first), /kernel state was lost/);
	const again = await run(hooked, "again", "import os\nprint(hook_value, os.environ['PI_IPYTHON_HOOK'])", first);
	assert.equal(again.kernelReset, true);
	assert.equal(again.result.output.trim(), "2 env-2");
} finally {
	await hooked.shutdown();
}

// A failing startup snippet fails the kernel start instead of running cells without it.
const broken = createKernel((event) => event.startupCode.push("raise RuntimeError('startup fixture')"));
try {
	await assert.rejects(run(broken, "broken", "print(1)", first), /startup fixture/);
} finally {
	await broken.shutdown();
	rmSync(root, { recursive: true, force: true });
}

console.log("kernel: state, cwd, reset, cleanup, startup hook and startup failure passed");
