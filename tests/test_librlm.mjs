import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "pi-librlm-discovery-"));
try {
	const home = join(root, "home");
	// Simulate Pi's managed checkout, not a sibling of librlm.
	const extension = join(root, "managed", "github.com", "owner", "pi-ipython", "extensions");
	mkdirSync(extension, { recursive: true });
	for (const file of ["librlm.ts", "ipython.py"]) {
		copyFileSync(new URL(`../extensions/${file}`, import.meta.url), join(extension, file));
	}
	const prompt = {
		schema: "librlm.ipython-prompt.v1", api: "fixture API", guidance: "fixture guidance", promptSnippet: "fixture",
	};
	function fixture(path) {
		mkdirSync(join(path, "rlm", "prompts"), { recursive: true });
		writeFileSync(join(path, "rlm", "__init__.py"), "");
		writeFileSync(join(path, "rlm", "bridge.py"), "def main(): pass\n");
		writeFileSync(join(path, "rlm", "prompts", "ipython.json"), JSON.stringify(prompt));
		return path;
	}
	const defaultRoot = fixture(join(home, "Dev", "librlm"));
	const overrideRoot = fixture(join(home, "separate checkout", "librlm"));
	const baseEnv = { ...process.env, HOME: home };
	delete baseEnv.RLM_LIBRLM_ROOT;
	const moduleUrl = pathToFileURL(join(extension, "librlm.ts")).href;
	function nodeProbe(env, code = `const m = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify([m.LIBRLM_ROOT, m.loadIpythonPrompt()]));`) {
		return spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { env, encoding: "utf8" });
	}
	const pythonCode = `import runpy, sys, types
jupyter = types.ModuleType('jupyter_client')
jupyter.KernelManager = object
sys.modules['jupyter_client'] = jupyter
ns = runpy.run_path(${JSON.stringify(join(extension, "ipython.py"))})
print(ns['LIBRLM_ROOT'])
import rlm.bridge
print(rlm.bridge.__file__)
`;
	function pythonProbe(env) {
		return spawnSync("python3", ["-I", "-c", pythonCode], { env, encoding: "utf8" });
	}
	for (const [override, expected] of [
		[undefined, defaultRoot], [overrideRoot, overrideRoot], ["~/separate checkout/librlm", overrideRoot],
	]) {
		const env = { ...baseEnv, ...(override === undefined ? {} : { RLM_LIBRLM_ROOT: override }) };
		const js = nodeProbe(env);
		assert.equal(js.status, 0, js.stderr);
		assert.deepEqual(JSON.parse(js.stdout), [expected, prompt]);
		const py = pythonProbe(env);
		assert.equal(py.status, 0, py.stderr);
		assert.deepEqual(py.stdout.trim().split("\n"), [expected, join(expected, "rlm", "bridge.py")]);
	}
	for (const override of ["", "relative/librlm"]) {
		for (const probe of [nodeProbe, pythonProbe]) {
			const result = probe({ ...baseEnv, RLM_LIBRLM_ROOT: override });
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /must be an absolute checkout path/);
		}
	}
	for (const probe of [nodeProbe, pythonProbe]) {
		const result = probe({ ...baseEnv, RLM_LIBRLM_ROOT: join(root, "missing") });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Standalone librlm missing/);
	}
	writeFileSync(join(defaultRoot, "rlm", "prompts", "ipython.json"), '{"schema":"wrong"}');
	const invalid = nodeProbe(baseEnv);
	assert.notEqual(invalid.status, 0);
	assert.match(invalid.stderr, /Invalid shared RLM instructions/);
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log("librlm discovery: relocated install, override, tilde, missing runtime and invalid config passed");
