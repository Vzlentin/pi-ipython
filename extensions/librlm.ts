import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// Never resolve relative to the extension: Git installs live in Pi's cache,
// not next to the independent librlm checkout.
export function resolveLibrlmRoot(env = process.env, home = homedir()): string {
	const configured = env.RLM_LIBRLM_ROOT ?? join(home, "Dev", "librlm");
	const path = configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
	if (!isAbsolute(path)) throw new Error("RLM_LIBRLM_ROOT must be an absolute checkout path");
	return resolve(path);
}

export const LIBRLM_ROOT = resolveLibrlmRoot();

interface IpythonPrompt {
	schema: string;
	api: string;
	guidance: string;
	promptSnippet: string;
}

export function loadIpythonPrompt(): IpythonPrompt {
	if (!existsSync(join(LIBRLM_ROOT, "rlm/bridge.py"))) {
		throw new Error(`Standalone librlm missing at ${LIBRLM_ROOT}; set RLM_LIBRLM_ROOT to its checkout`);
	}
	const path = resolve(LIBRLM_ROOT, "rlm/prompts/ipython.json");
	let value: IpythonPrompt;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Cannot load shared RLM instructions at ${path}. Set RLM_LIBRLM_ROOT to the standalone librlm checkout.`, { cause: error });
	}
	if (value.schema !== "librlm.ipython-prompt.v1" ||
		![value.api, value.guidance, value.promptSnippet].every((part) => typeof part === "string" && part.length > 0)) {
		throw new Error(`Invalid shared RLM instructions at ${path}`);
	}
	return value;
}
