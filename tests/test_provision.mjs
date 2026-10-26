import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKernel, execShim, preserveEnvironment, runKernel } from "./helpers.mjs";

const python = fileURLToPath(new URL("../core/.python/bin/python", import.meta.url));
const sitePackages = fileURLToPath(new URL("../core/.python/lib/python3.12/site-packages", import.meta.url));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-ipython-provision-")));
const restoreEnvironment = preserveEnvironment("PATH", "UV_OFFLINE", "UV_NO_CACHE");
const kernels = [createKernel(), createKernel(), createKernel(), createKernel(), createKernel()];

// A package that is not in uv.lock, as an agent installs it. It is written by hand, so it needs no package index.
const installExtra = () => {
	const distInfo = join(sitePackages, "pi_ipython_extra-1.0.dist-info");
	mkdirSync(distInfo, { recursive: true });
	writeFileSync(join(sitePackages, "pi_ipython_extra.py"), "");
	writeFileSync(join(distInfo, "METADATA"), "Metadata-Version: 2.1\nName: pi-ipython-extra\nVersion: 1.0\n");

	const files = [
		"pi_ipython_extra.py",
		"pi_ipython_extra-1.0.dist-info/METADATA",
		"pi_ipython_extra-1.0.dist-info/RECORD",
	];

	writeFileSync(join(distInfo, "RECORD"), files.map((file) => `${file},,\n`).join(""));
};

const start = async (kernel) => {
	const progress = [];

	const run = await runKernel(kernel, "import xlsxwriter, pi_ipython_extra; print('xlsxwriter')", cwd, {
		onProgress: (message) => progress.push(message),
	});

	return { output: run.result.output, provisioned: progress.some((message) => message.startsWith("Provisioning")) };
};

try {
	// An environment that drifted from uv.lock is synced again before the kernel starts, also by two hosts at once.
	// The sync keeps packages that are not in uv.lock.
	installExtra();
	const uninstall = await execShim("uv", ["pip", "uninstall", "--python", python, "xlsxwriter"]);
	assert.equal(uninstall.code, 0, uninstall.stderr);
	const [first, second] = await Promise.all([start(kernels[0]), start(kernels[1])]);
	assert.deepEqual([first.output, second.output], ["xlsxwriter\n", "xlsxwriter\n"]);
	assert.ok(first.provisioned || second.provisioned);

	// An environment with all the packages of uv.lock starts without provisioning.
	assert.deepEqual(await start(kernels[2]), { output: "xlsxwriter\n", provisioned: false });

	// Without uv, the start fails with the spawn error, and the same runtime recovers when uv is back.
	process.env.PATH = cwd;
	await assert.rejects(start(kernels[3]), /Failed to provision the Python environment with uv:\n.*ENOENT/);
	restoreEnvironment();
	assert.deepEqual(await start(kernels[3]), { output: "xlsxwriter\n", provisioned: false });

	// A sync that uv cannot do fails with uv's own error, and the same runtime recovers.
	const drift = await execShim("uv", ["pip", "uninstall", "--python", python, "xlsxwriter"]);
	assert.equal(drift.code, 0, drift.stderr);
	process.env.UV_OFFLINE = "1";
	process.env.UV_NO_CACHE = "1";
	await assert.rejects(start(kernels[4]), /Failed to provision the Python environment with uv:\n[^]*xlsxwriter/);
	restoreEnvironment();
	assert.deepEqual(await start(kernels[4]), { output: "xlsxwriter\n", provisioned: true });
} finally {
	restoreEnvironment();
	await Promise.all(kernels.map((kernel) => kernel.shutdown()));
	await execShim("uv", ["pip", "uninstall", "--python", python, "pi-ipython-extra"]);
	rmSync(cwd, { recursive: true, force: true });
}

console.log(
	"provision: concurrent hosts sync drift and keep extra packages, a synced environment is kept, a missing uv and a failed sync recover",
);
