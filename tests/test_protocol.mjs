import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelLostError, KernelRuntime } from "../core/kernel-runtime.ts";
import { runKernel, waitFor } from "./helpers.mjs";

// A bridge that speaks the stdio protocol without a kernel. PI_IPYTHON_FAKE_BRIDGE names the message to break, and
// each bridge appends its pid to PI_IPYTHON_FAKE_BRIDGE_PIDS.
const fakeBridge = `
require("node:fs").appendFileSync(process.env.PI_IPYTHON_FAKE_BRIDGE_PIDS, process.pid + "\\n");
const lines = require("node:readline").createInterface({ input: process.stdin });
const broken = process.env.PI_IPYTHON_FAKE_BRIDGE;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "startup") {
		send({ type: "kernel_started", kernel_pgid: process.pid });
		send({ type: "ready", protocol: broken === "ready" ? "3" : 3, kernel_pgid: process.pid, connection_file: "/fake.json" });
	} else if (request.type === "execute") {
		send({ type: "output", request_id: request.request_id, kind: "stdout", text: "fake\\n", continuation: false, final: true });
		send({ type: "image", request_id: request.request_id, data: "A".repeat(9 * 1024 * 1024) });
		for (let index = 0; index < 5; index += 1) send({ type: "image", request_id: request.request_id, data: "iVBORw0KGgo" + index });
		send({ type: "result", request_id: request.request_id, status: "ok", execution_count: broken === "result" ? "1" : 1 });
	} else if (request.type === "shutdown") {
		process.exit(0);
	}
});
`;

const cwd = realpathSync(tmpdir());
const directory = mkdtempSync(join(tmpdir(), "pi-ipython-protocol-"));
const pidFile = join(directory, "pids");
const bridges = () => readFileSync(pidFile, "utf8").trim().split("\n").map(Number);

const exited = (pid) => {
	try {
		process.kill(pid, 0);

		return false;
	} catch {
		return true;
	}
};

let broken = "ready";

const bus = new EventEmitter();

bus.on("ipython:kernel-starting", (event) => {
	event.env.PI_IPYTHON_FAKE_BRIDGE = broken;
	event.env.PI_IPYTHON_FAKE_BRIDGE_PIDS = pidFile;
});

const kernel = new KernelRuntime(
	{ events: { emit: (name, data) => bus.emit(name, data) } },
	[],
	[process.execPath, "-e", fakeBridge],
);

try {
	// An invalid ready fails startup at once, not after the startup timeout, and stops the bridge.
	const started = Date.now();
	await assert.rejects(runKernel(kernel, "1", cwd), /unsupported protocol version/);
	assert.ok(Date.now() - started < 10_000);
	await waitFor(() => exited(bridges()[0]));

	// An invalid result fails the running cell, stops the bridge, and the next cell reports the reset.
	broken = "result";
	await assert.rejects(runKernel(kernel, "1", cwd), (error) => {
		assert.ok(error instanceof KernelLostError);
		assert.match(error.message, /invalid result message/);

		return true;
	});
	await waitFor(() => exited(bridges()[1]));

	broken = "none";
	const recovered = await runKernel(kernel, "1", cwd);
	assert.equal(recovered.kernelReset, true);
	assert.equal(recovered.result.status, "ok");
	assert.equal(recovered.result.executionCount, 1);
	assert.equal(recovered.result.output, "fake\n");
	// The image over the byte limit and the image past the count limit are dropped and counted, and the cell succeeds.
	assert.deepEqual(recovered.result.images, ["iVBORw0KGgo0", "iVBORw0KGgo1", "iVBORw0KGgo2", "iVBORw0KGgo3"]);
	assert.equal(recovered.result.imagesDropped, 2);
	assert.equal((await runKernel(kernel, "1", cwd)).kernelReset, false);
	assert.equal(bridges().length, 3);
} finally {
	await kernel.shutdown();
}

assert.ok(bridges().every(exited));

rmSync(directory, { recursive: true, force: true });

console.log(
	"protocol: invalid ready and result messages fail at once, the next start recovers, and images are bounded",
);
