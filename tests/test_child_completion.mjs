import assert from "node:assert/strict";

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

const unknownBefore = calls.length;
await assert.rejects(
	() =>
		completeChild({
			model: model("custom-api", "custom-model"),
			context,
			thinkingLevel: "high",
			signal: new AbortController().signal,
		}),
	/Unsupported child completion API: custom-api/,
);
assert.equal(calls.length, unknownBefore);
