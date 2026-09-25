import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CellsView } from "../extensions/cells.ts";
import { KernelRuntime } from "../extensions/kernel-runtime.ts";
import ipythonExtension from "../extensions/ipython.ts";

const originalHerdr = process.env.HERDR_ENV;
process.env.HERDR_ENV = "1";
const calls = [];
const panes = new Set();
const tabs = new Map();
const readyPanes = new Set();
let nextPane = 0;
let failRun = false;
let failGet = false;
let failWait = false;
let failMove = false;
let onWait;
const pi = {
	async exec(command, args, options) {
		assert.equal(command, "herdr");
		calls.push(args);
		const [group, action, id] = args;
		assert.equal(options.timeout, action === "wait-output" ? 125000 : 5000);
		if (action === "run") assert.match(args[3], /^printf '\\033\[2J\\033\[3J\\033\[H'; cat '[^']+'; exec /);
		let result = {};
		if (action === "current") {
			assert.ok(args.includes("--current"));
			result = { pane: { pane_id: "caller", tab_id: "caller-tab", workspace_id: "workspace" } };
		} else if (group === "tab" && action === "create") {
			assert.ok(args.includes("--no-focus"));
			assert.equal(args[args.indexOf("--cwd") + 1], process.cwd());
			assert.equal(args[args.indexOf("--workspace") + 1], "workspace");
			const pane_id = `opaque-pane-${++nextPane}`;
			const tab_id = `staging-${nextPane}`;
			panes.add(pane_id);
			tabs.set(tab_id, pane_id);
			result = { root_pane: { pane_id }, tab: { tab_id } };
		} else if ((action === "run" && failRun) || (action === "get" && failGet) || (action === "move" && failMove)) {
			return { code: 1, stderr: "Herdr unavailable", stdout: "" };
		} else if (group === "tab") {
			assert.equal(action, "close");
			if (!tabs.has(id)) return { code: 1, stderr: JSON.stringify({ error: { code: "tab_not_found" } }), stdout: "" };
			panes.delete(tabs.get(id));
			tabs.delete(id);
		} else if (!panes.has(id)) {
			return { code: 1, stderr: JSON.stringify({ error: { code: "pane_not_found" } }), stdout: "" };
		} else if (action === "wait-output") {
			assert.equal(args[args.indexOf("--source") + 1], "visible");
			assert.equal(args[args.indexOf("--timeout") + 1], "120000");
			assert.equal(args[args.indexOf("--regex") + 1], "In \\[\\d*\\]:");
			if (options.signal.aborted) throw new Error("startup cancelled");
			if (onWait) {
				onWait();
				await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("startup cancelled")), { once: true }));
			}
			if (failWait) return { code: 1, stdout: "", stderr: "viewer readiness timeout" };
			readyPanes.add(id);
			return { code: 0, stdout: "viewer prompt (not JSON)", stderr: "" };
		} else if (action === "move") {
			assert.ok(readyPanes.has(id));
			assert.ok(args.includes("--no-focus"));
			assert.equal(args[args.indexOf("--tab") + 1], "caller-tab");
			assert.equal(args[args.indexOf("--target-pane") + 1], "caller");
			assert.equal(args[args.indexOf("--split") + 1], "right");
			panes.delete(id);
			panes.add(`${id}-moved`);
			for (const [tab, pane] of tabs) if (pane === id) tabs.delete(tab);
			result = { move_result: { pane: { pane_id: `${id}-moved` } } };
		} else if (action === "close") {
			panes.delete(id);
		}
		return { code: 0, stdout: action === "rename" || action === "run" ? "" : JSON.stringify({ result }), stderr: "" };
	},
};

const connectionDirectory = mkdtempSync(join(tmpdir(), "pi-cells-test-"));
const firstConnection = join(connectionDirectory, "first.json");
const secondConnection = join(connectionDirectory, "second.json");
writeFileSync(firstConnection, JSON.stringify({ key: "test-key", iopub_port: 12345 }));
writeFileSync(secondConnection, JSON.stringify({ key: "next-test-key", iopub_port: 23456 }));
const cwd = process.cwd();

const view = new CellsView(pi);
try {
	view.begin("print('hello')\n42");
	view.output("hel");
	view.output("hello\n");
	view.output("hello\n");
	view.note("children completed: 1/2");
	view.output("");
	view.output("\x1b[31mreplacement\x1b[0m\n\x1b]52;c;clipboard\x07\x00");
	view.finish("ok");
	await Promise.all([view.toggle(cwd, firstConnection), view.toggle(cwd, firstConnection)]);
	assert.equal(panes.size, 1);
	assert.equal(nextPane, 1);
	const command = calls.find((args) => args[1] === "run")[3];
	assert.match(command, /; cat '[^']+'; exec 'env' 'JUPYTER_PATH=[^']+\/extensions\/\.python\/share\/jupyter' 'uv' 'tool' 'run' .*'--from' 'euporie==2\.10\.4' 'euporie-console' '--connection-file' /);
	assert.match(command, /'--kernel-name' 'python3' '--show-remote-inputs' '--show-remote-outputs' '--no-mouse-support' '--no-lsp'$/);
	const file = command.match(/cat '([^']+)';/)[1];
	assert.equal(statSync(file).mode & 0o777, 0o600);
	const text = readFileSync(file, "utf8");
	assert.match(text, />>> print\('hello'\)\n\.\.\. 42/);
	assert.equal(text.split("hello\n").length - 1, 1);
	assert.match(text, /children completed: 1\/2/);
	assert.match(text, /output cleared\/replaced/);
	assert.match(text, /replacement/);
	assert.doesNotMatch(text, /\x1b|clipboard|\x00/);
	assert.match(text, /Cell 1 \| ok/);

	// A transient CLI failure must not forget ownership or open a second pane.
	failGet = true;
	await assert.rejects(view.toggle(cwd, firstConnection), /Herdr unavailable/);
	assert.equal(panes.size, 1);
	failGet = false;
	await view.toggle(cwd, firstConnection);
	assert.equal(panes.size, 0);
	view.begin("second cell while hidden");
	view.finish("error: cancelled; kernel state lost");
	await view.toggle(cwd, firstConnection);
	assert.match(readFileSync(file, "utf8"), /Cell 2 \| error: cancelled; kernel state lost/);

	// Recover if the user closes the pane, then remove the file on shutdown.
	panes.clear();
	await view.toggle(cwd, firstConnection);
	assert.equal(panes.size, 1);
	await view.shutdown();
	assert.equal(panes.size, 0);
	assert.equal(existsSync(file), false);
	view.begin("must not recreate the file");
	await view.toggle(cwd, firstConnection);
	assert.equal(existsSync(file), false);
} finally {
	await view.shutdown();
}

const failed = new CellsView(pi);
try {
	failRun = true;
	await assert.rejects(failed.toggle(cwd, firstConnection), /Herdr unavailable/);
	assert.equal(panes.size, 0);
	failRun = false;
	await failed.toggle(cwd, firstConnection);
	assert.equal(panes.size, 1);
} finally {
	failRun = false;
	await failed.shutdown();
}

for (const failure of ["wait", "move"]) {
	const failed = new CellsView(pi);
	failWait = failure === "wait";
	failMove = failure === "move";
	await assert.rejects(failed.toggle(cwd, firstConnection), /timeout|Herdr unavailable/);
	assert.equal(panes.size, 0);
	assert.equal(tabs.size, 0);
	failWait = failMove = false;
	await failed.toggle(cwd, firstConnection);
	await failed.shutdown();
}

const racing = new CellsView(pi);
const waiting = new Promise((resolve) => { onWait = resolve; });
const opening = racing.toggle(cwd, firstConnection);
await waiting;
const rejected = assert.rejects(opening, /startup cancelled/);
await racing.shutdown();
await rejected;
onWait = undefined;
assert.equal(panes.size, 0);
assert.equal(tabs.size, 0);

const limited = new CellsView(pi);
try {
	await limited.toggle(cwd, firstConnection);
	const command = calls.filter((args) => args[1] === "run").at(-1)[3];
	const file = command.match(/cat '([^']+)';/)[1];
	limited.begin("output flood");
	limited.output("x".repeat(16 * 1024 * 1024));
	limited.note("must not append after the cap");
	assert.match(readFileSync(file, "utf8"), /History limit reached/);
	assert.doesNotMatch(readFileSync(file, "utf8"), /must not append/);
} finally {
	await limited.shutdown();
}

const live = new CellsView(pi);
try {
	await live.toggle(cwd, firstConnection);
	const command = calls.filter((args) => args[1] === "run").at(-1)[3];
	const copy = command.match(/'--connection-file' '([^']+)'/)[1];
	assert.notEqual(copy, firstConnection);
	assert.equal(statSync(copy).mode & 0o777, 0o600);
	assert.equal(readFileSync(copy, "utf8"), readFileSync(firstConnection, "utf8"));
	// A new kernel (after a reset) replaces the console instead of closing it.
	const previousPaneCount = nextPane;
	await live.toggle(cwd, secondConnection);
	assert.equal(nextPane, previousPaneCount + 1);
	assert.equal(panes.size, 1);
	assert.equal(readFileSync(copy, "utf8"), readFileSync(secondConnection, "utf8"));
	await live.toggle(cwd, secondConnection);
	assert.equal(panes.size, 0);
	assert.equal(existsSync(copy), false);
	assert.equal(existsSync(firstConnection), true);
} finally {
	await live.shutdown();
}

// Exercise the real tool wiring without a model or a kernel process.
let tool;
let shortcut;
const commands = new Map();
const events = new Map();
const notices = [];
const originalPersistence = process.env.PI_IPYTHON_PERSISTENCE;
process.env.PI_IPYTHON_PERSISTENCE = "0";
ipythonExtension({
	...pi,
	registerTool(value) { tool = value; },
	registerCommand(name, value) { commands.set(name, value); },
	registerShortcut(key, value) {
		assert.equal(key, "ctrl+shift+i");
		assert.equal(typeof value.handler, "function");
		shortcut = value.handler;
	},
	on(name, handler) { events.set(name, handler); },
});
const ctx = {
	mode: "tui", cwd: process.cwd(), modelRegistry: {},
	ui: { setWidget() {}, notify(...args) { notices.push(args); } },
};
const execute = KernelRuntime.prototype.execute;
const start = KernelRuntime.prototype.start;
const getConnectionFile = KernelRuntime.prototype.getConnectionFile;
let connectionRequests = 0;
let executions = 0;
try {
	KernelRuntime.prototype.start = async () => {};
	KernelRuntime.prototype.getConnectionFile = async () => { connectionRequests++; return firstConnection; };
	KernelRuntime.prototype.execute = async (_id, _code, _cwd, _signal, progress, output) => {
		executions++;
		progress("Starting IPython kernel...");
		output("streamed output\n");
		return {
			kernelReset: true,
			notice: "<ipython_kernel_reset>\nreset fixture\n</ipython_kernel_reset>",
			result: { status: "ok", executionCount: 1, output: "streamed output\n" },
		};
	};
	const result = await tool.execute("cell", { code: "answer = 42" }, undefined, () => {}, ctx);
	assert.equal(result.details.status, "ok");
	// Run with the console closed, then open it: recorded history first, attached to the kernel.
	await commands.get("cells").handler("", ctx);
	assert.equal(connectionRequests, 1);
	const command = calls.filter((args) => args[1] === "run").at(-1)[3];
	assert.match(command, /'euporie-console' '--connection-file'/);
	const file = command.match(/cat '([^']+)';/)[1];
	assert.match(readFileSync(file, "utf8"), />>> answer = 42/);
	assert.match(readFileSync(file, "utf8"), /streamed output/);
	assert.match(readFileSync(file, "utf8"), /Starting IPython kernel/);
	assert.match(readFileSync(file, "utf8"), /ipython_kernel_reset/);
	await commands.get("cells").handler("", ctx);
	assert.equal(panes.size, 0);
	await tool.execute("hidden", { code: "print('while closed')" }, undefined, () => {}, ctx);
	await shortcut(ctx);
	assert.equal(panes.size, 1);
	assert.match(readFileSync(file, "utf8"), />>> print\('while closed'\)/);
	assert.equal(executions, 2);
	assert.equal(connectionRequests, 3);
	KernelRuntime.prototype.execute = async () => { throw new Error("cancelled; kernel state lost"); };
	await assert.rejects(tool.execute("cancel", { code: "await pending" }, undefined, () => {}, ctx), /cancelled/);
	assert.match(readFileSync(file, "utf8"), /Cell 3 \| error: Error: cancelled; kernel state lost/);
	assert.deepEqual(notices, []);
	await events.get("session_shutdown")();
	assert.equal(existsSync(file), false);

	process.env.HERDR_ENV = "0";
	const outside = new CellsView(pi);
	const before = calls.length;
	await assert.rejects(outside.toggle(cwd, firstConnection), /requires a Herdr pane/);
	assert.equal(calls.length, before);
} finally {
	KernelRuntime.prototype.execute = execute;
	KernelRuntime.prototype.start = start;
	KernelRuntime.prototype.getConnectionFile = getConnectionFile;
	await events.get("session_shutdown")();
	if (originalPersistence === undefined) delete process.env.PI_IPYTHON_PERSISTENCE;
	else process.env.PI_IPYTHON_PERSISTENCE = originalPersistence;
	rmSync(connectionDirectory, { recursive: true, force: true });
	if (originalHerdr === undefined) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = originalHerdr;
}

if (process.argv.includes("--kernel")) {
	process.env.HERDR_ENV = "1";
	const exec = promisify(execFile);
	const kernel = new KernelRuntime({
		events: { emit() {} },
		async exec(command, args, options) {
			try {
				return { ...await exec(command, args, options), code: 0 };
			} catch (error) {
				return { code: error.code ?? 1, stderr: error.stderr ?? error.message, stdout: error.stdout ?? "" };
			}
		},
	});
	const view = new CellsView(pi);
	const config = { cwd: process.cwd() };
	let recoveredConnection;
	try {
		const first = await kernel.getConnectionFile(config.cwd, undefined, () => {});
		assert.equal(existsSync(first), true);
		await view.toggle(config.cwd, first);
		await assert.rejects(kernel.execute("crash", "import os; os._exit(1)",
			config.cwd, undefined, () => {}, () => {}), /kernel state was lost/);
		recoveredConnection = await kernel.getConnectionFile(config.cwd, undefined, () => {});
		assert.notEqual(recoveredConnection, first);
		assert.equal(existsSync(first), false);
		await view.toggle(config.cwd, recoveredConnection);
		assert.equal(panes.size, 1);
		const recovered = await kernel.execute("recovered", "saved = 42\nprint(saved)", config.cwd, undefined, () => {}, () => {});
		assert.equal(recovered.kernelReset, true);
		assert.equal(recovered.result.output.trim(), "42");
		await view.shutdown();
		assert.equal(existsSync(recoveredConnection), true);
		const next = await kernel.execute("after-close", "print(saved + 1)", config.cwd, undefined, () => {}, () => {});
		assert.equal(next.kernelReset, false);
		assert.equal(next.result.output.trim(), "43");
	} finally {
		await view.shutdown();
		await kernel.shutdown();
		if (originalHerdr === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = originalHerdr;
	}
	assert.equal(existsSync(recoveredConnection), false);
	await assert.rejects(kernel.getConnectionFile(config.cwd, undefined, () => {}), /shutting down/);
}
