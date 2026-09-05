import assert from "node:assert/strict";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { createChildCompleter } from "../extensions/child-completion.ts";

function model(api, id, overrides = {}) {
	return {
		id,
		name: id,
		api,
		provider: "test-provider",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 32_768,
		...overrides,
	};
}

const context = {
	systemPrompt: "child system prompt",
	messages: [
		{
			role: "user",
			content: [{ type: "text", text: "focused task" }],
			timestamp: Date.now(),
		},
	],
	tools: [],
};

const calls = [];
const modelRegistry = {
	async complete(activeModel, activeContext, options) {
		calls.push({ model: activeModel, context: activeContext, options });
		return {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: activeModel.api,
			provider: activeModel.provider,
			model: activeModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	},
};
const completeChild = createChildCompleter(modelRegistry);

async function optionsFor(activeModel, thinkingLevel = "off", signal = new AbortController().signal) {
	const before = calls.length;
	await completeChild({ model: activeModel, context, thinkingLevel, signal });
	assert.equal(calls.length, before + 1);
	const call = calls.at(-1);
	assert.equal(call.model, activeModel);
	assert.equal(call.context, context);
	return call.options;
}

const signal = new AbortController().signal;
const openaiOptions = await optionsFor(
	model("openai-responses", "reasoning-model", {
		contextWindow: 5_000,
		maxTokens: 4_096,
	}),
	"high",
	signal,
);
assert.equal(openaiOptions.signal, signal);
assert.equal(openaiOptions.maxRetries, 0);
assert.equal(openaiOptions.cacheRetention, "none");
assert.equal(openaiOptions.reasoningEffort, "high");
assert.ok(openaiOptions.maxTokens > 0 && openaiOptions.maxTokens < 4_096);

const olderAnthropic = await optionsFor(model("anthropic-messages", "claude-sonnet-4-5"), "high");
assert.equal(olderAnthropic.thinkingEnabled, true);
assert.equal(olderAnthropic.thinkingBudgetTokens, 16_384);
assert.equal(olderAnthropic.effort, undefined);

const adaptiveAnthropic = await optionsFor(
	model("anthropic-messages", "claude-opus-4-7", {
		compat: { forceAdaptiveThinking: true },
		thinkingLevelMap: { xhigh: "xhigh" },
	}),
	"xhigh",
);
assert.equal(adaptiveAnthropic.thinkingEnabled, true);
assert.equal(adaptiveAnthropic.effort, "xhigh");
assert.equal(adaptiveAnthropic.thinkingBudgetTokens, undefined);

const googleMinimal = await optionsFor(model("google-generative-ai", "gemini-2.5-pro"), "minimal");
assert.deepEqual(googleMinimal.thinking, { enabled: true, budgetTokens: 128 });
const googleHigh = await optionsFor(model("google-vertex", "gemini-2.5-pro"), "high");
assert.deepEqual(googleHigh.thinking, { enabled: true, budgetTokens: 32_768 });
const googleThree = await optionsFor(model("google-generative-ai", "gemini-3.1-pro"), "medium");
assert.deepEqual(googleThree.thinking, { enabled: true, level: "HIGH" });

const mistralEffort = await optionsFor(model("mistral-conversations", "mistral-small-latest"), "medium");
assert.equal(mistralEffort.reasoningEffort, "high");
assert.equal(mistralEffort.promptMode, undefined);
const mistralPrompt = await optionsFor(model("mistral-conversations", "magistral-medium-latest"), "medium");
assert.equal(mistralPrompt.promptMode, "reasoning");
assert.equal(mistralPrompt.reasoningEffort, undefined);

const olderBedrock = await optionsFor(
	model("bedrock-converse-stream", "anthropic.claude-sonnet-4-5", { name: "Claude Sonnet 4.5" }),
	"high",
);
assert.equal(olderBedrock.reasoning, "high");
assert.deepEqual(olderBedrock.thinkingBudgets, { high: 16_384 });
const adaptiveBedrock = await optionsFor(
	model("bedrock-converse-stream", "anthropic.claude-sonnet-4-6", { name: "Claude Sonnet 4.6" }),
	"high",
);
assert.equal(adaptiveBedrock.reasoning, "high");
assert.equal(adaptiveBedrock.thinkingBudgets, undefined);

const piSignal = new AbortController().signal;
const piMessages = await optionsFor(model("pi-messages", "gateway-model"), "medium", piSignal);
assert.equal(piMessages.signal, piSignal);
assert.equal(piMessages.maxRetries, 0);
assert.equal(piMessages.cacheRetention, "none");
assert.equal(piMessages.reasoning, "medium");
assert.equal(piMessages.maxTokens, undefined);

const customOptions = await optionsFor(model("custom-api", "custom-model"), "high", signal);
assert.equal(customOptions.reasoning, "high");
assert.equal(customOptions.signal, signal);

// Exercise Pi's real custom-provider dispatch and auth, not just the completion stub.
const runtime = await ModelRuntime.create({
	credentials: new InMemoryCredentialStore(),
	modelsPath: null,
	refreshOnCreate: false,
});
const registry = new ModelRegistry(runtime);
const cursorModel = model("cursor-native", "cursor-model", {
	provider: "test-cursor",
	thinkingLevelMap: { xhigh: "xhigh" },
});
const response = {
	role: "assistant",
	api: cursorModel.api,
	provider: cursorModel.provider,
	model: cursorModel.id,
	content: [{ type: "text", text: "CURSOR_OK" }],
	usage: {
		input: 11, output: 7, reasoning: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 18,
		cost: { input: 0.11, output: 0.07, cacheRead: 0, cacheWrite: 0, total: 0.18 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};
const providerCalls = [];
let providerError;
registry.registerProvider(cursorModel.provider, {
	api: cursorModel.api,
	baseUrl: cursorModel.baseUrl,
	apiKey: "test-only-key",
	headers: { "X-Test-Provider": "registered" },
	models: [cursorModel],
	streamSimple(activeModel, activeContext, options) {
		providerCalls.push({ model: activeModel, context: activeContext, options });
		if (providerError) throw providerError;
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: response });
		stream.end();
		return stream;
	},
});
const registeredChild = createChildCompleter(registry);
for (const thinkingLevel of ["xhigh", "off"]) {
	const result = await registeredChild({ model: cursorModel, context, thinkingLevel, signal });
	assert.deepEqual(result, response);
	const call = providerCalls.at(-1);
	assert.equal(call.model, cursorModel);
	assert.equal(call.context, context);
	assert.equal(call.options.reasoning, thinkingLevel === "off" ? undefined : thinkingLevel);
	assert.equal(call.options.signal, signal);
	assert.equal(call.options.apiKey, "test-only-key");
	assert.equal(call.options.headers["X-Test-Provider"], "registered");
	assert.equal(call.options.maxRetries, 0);
	assert.equal(call.options.cacheRetention, "none");
	assert.equal(call.options.sessionId, undefined);
}
assert.equal(providerCalls.length, 2);
providerError = new Error("custom provider failed");
const failed = await registeredChild({ model: cursorModel, context, thinkingLevel: "off", signal });
assert.equal(failed.stopReason, "error");
assert.match(failed.errorMessage, /custom provider failed/);
registry.unregisterProvider(cursorModel.provider);
const missing = await registeredChild({ model: cursorModel, context, thinkingLevel: "off", signal });
assert.equal(missing.stopReason, "error");
assert.match(missing.errorMessage, /Unknown provider: test-cursor/);
assert.equal(providerCalls.length, 3);
