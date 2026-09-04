import {
	clampThinkingLevel,
	hasApi,
	type Context,
	type Model,
	type ModelsApiStreamOptions,
	type StreamOptions,
	type ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
	adjustMaxTokensForThinking,
	buildBaseOptions,
	clampMaxTokensToContext,
	clampReasoning,
} from "@earendil-works/pi-ai/api/simple-options";
import { resolveGoogleThinkingLevel } from "@earendil-works/pi-ai/api/google-shared";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildCompletionRequest, CompleteChild } from "./rlm-host.ts";

type ModelRegistry = ExtensionContext["modelRegistry"];
type ActiveModel = ChildCompletionRequest["model"];
type ActiveReasoning = ThinkingLevel | undefined;
type GoogleApi = "google-generative-ai" | "google-vertex";

function activeReasoning(model: ActiveModel, thinkingLevel: ChildCompletionRequest["thinkingLevel"]): ActiveReasoning {
	if (!model.reasoning) return undefined;
	const clamped = clampThinkingLevel(model, thinkingLevel);
	return clamped === "off" ? undefined : clamped;
}

function baseOptions(
	model: ActiveModel,
	context: Context,
	reasoning: ActiveReasoning,
	signal: AbortSignal,
): StreamOptions {
	return buildBaseOptions(model, context, {
		signal,
		maxRetries: 0,
		cacheRetention: "none",
		reasoning,
	});
}

function anthropicEffort(
	model: Model<"anthropic-messages">,
	level: ThinkingLevel,
): "low" | "medium" | "high" | "xhigh" | "max" {
	const mapped = model.thinkingLevelMap?.[level];
	if (typeof mapped === "string") {
		if (mapped === "low" || mapped === "medium" || mapped === "high" || mapped === "xhigh" || mapped === "max") {
			return mapped;
		}
		throw new Error(`Unsupported Anthropic thinking level mapping: ${mapped}`);
	}
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		default:
			return "high";
	}
}

function isGemini3Pro(model: Model<GoogleApi>): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(model.id.toLowerCase());
}

function isGemini3Flash(model: Model<GoogleApi>): boolean {
	const id = model.id.toLowerCase();
	return /gemini-3(?:\.\d+)?-flash/.test(id) || id === "gemini-flash-latest" || id === "gemini-flash-lite-latest";
}

function isGemma4(model: Model<GoogleApi>): boolean {
	return /gemma-?4/.test(model.id.toLowerCase());
}

function googleThinkingLevel(
	model: Model<GoogleApi>,
	level: ReturnType<typeof resolveGoogleThinkingLevel>,
): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" {
	if (isGemini3Pro(model)) return level === "minimal" || level === "low" ? "LOW" : "HIGH";
	if (model.api === "google-generative-ai" && isGemma4(model)) {
		return level === "minimal" || level === "low" ? "MINIMAL" : "HIGH";
	}
	return level.toUpperCase() as "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
}

function googleThinkingBudget(model: Model<GoogleApi>, level: ReturnType<typeof resolveGoogleThinkingLevel>): number {
	if (model.id.includes("2.5-pro")) {
		return { minimal: 128, low: 2048, medium: 8192, high: 32768 }[level];
	}
	if (model.api === "google-generative-ai" && model.id.includes("2.5-flash-lite")) {
		return { minimal: 512, low: 2048, medium: 8192, high: 24576 }[level];
	}
	if (model.id.includes("2.5-flash")) {
		return { minimal: 128, low: 2048, medium: 8192, high: 24576 }[level];
	}
	return -1;
}

function googleThinking(
	model: Model<GoogleApi>,
	reasoning: ActiveReasoning,
): { enabled: boolean; budgetTokens?: number; level?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" } {
	if (!reasoning) return { enabled: false };
	const level = resolveGoogleThinkingLevel(model, reasoning);
	if (isGemini3Pro(model) || isGemini3Flash(model) || (model.api === "google-generative-ai" && isGemma4(model))) {
		return { enabled: true, level: googleThinkingLevel(model, level) };
	}
	return { enabled: true, budgetTokens: googleThinkingBudget(model, level) };
}

function mistralReasoningEffort(
	model: Model<"mistral-conversations">,
	level: ThinkingLevel,
): "none" | "high" {
	const mapped = model.thinkingLevelMap?.[level] ?? "high";
	if (mapped === "none" || mapped === "high") return mapped;
	throw new Error(`Unsupported Mistral reasoning effort mapping: ${mapped}`);
}

function bedrockModelNames(model: Model<"bedrock-converse-stream">): string[] {
	return [model.id, model.name].flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(/[\s_.:]+/g, "-")];
	});
}

function isBedrockClaude(model: Model<"bedrock-converse-stream">): boolean {
	const id = model.id.toLowerCase();
	const name = model.name.toLowerCase();
	return (
		id.includes("anthropic.claude") ||
		id.includes("anthropic/claude") ||
		name.includes("anthropic.claude") ||
		name.includes("anthropic/claude") ||
		name.includes("claude")
	);
}

function bedrockSupportsAdaptiveThinking(model: Model<"bedrock-converse-stream">): boolean {
	return bedrockModelNames(model).some(
		(value) =>
			value.includes("opus-4-6") ||
			value.includes("opus-4-7") ||
			value.includes("opus-4-8") ||
			value.includes("opus-5") ||
			value.includes("sonnet-4-6") ||
			value.includes("sonnet-5") ||
			value.includes("fable-5"),
	);
}

function completeKnownChild(
	modelRegistry: ModelRegistry,
	model: ActiveModel,
	context: Context,
	thinkingLevel: ChildCompletionRequest["thinkingLevel"],
	signal: AbortSignal,
) {
	const reasoning = activeReasoning(model, thinkingLevel);
	if (hasApi(model, "pi-messages")) {
		return modelRegistry.complete(model, context, {
			signal,
			maxRetries: 0,
			cacheRetention: "none",
			reasoning,
		} satisfies ModelsApiStreamOptions<"pi-messages">);
	}
	const base = baseOptions(model, context, reasoning, signal);

	if (hasApi(model, "anthropic-messages")) {
		if (!reasoning) {
			return modelRegistry.complete(model, context, {
				...base,
				thinkingEnabled: false,
			} satisfies ModelsApiStreamOptions<"anthropic-messages">);
		}
		if (model.compat?.forceAdaptiveThinking === true) {
			return modelRegistry.complete(model, context, {
				...base,
				thinkingEnabled: true,
				effort: anthropicEffort(model, reasoning),
			} satisfies ModelsApiStreamOptions<"anthropic-messages">);
		}
		const adjusted = adjustMaxTokensForThinking(base.maxTokens, model.maxTokens, reasoning);
		const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
		return modelRegistry.complete(model, context, {
			...base,
			maxTokens,
			thinkingEnabled: true,
			thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
		} satisfies ModelsApiStreamOptions<"anthropic-messages">);
	}

	if (hasApi(model, "openai-completions")) {
		return modelRegistry.complete(model, context, {
			...base,
			reasoningEffort: reasoning,
		} satisfies ModelsApiStreamOptions<"openai-completions">);
	}
	if (hasApi(model, "openai-responses")) {
		return modelRegistry.complete(model, context, {
			...base,
			reasoningEffort: reasoning,
		} satisfies ModelsApiStreamOptions<"openai-responses">);
	}
	if (hasApi(model, "openai-codex-responses")) {
		return modelRegistry.complete(model, context, {
			...base,
			reasoningEffort: reasoning,
		} satisfies ModelsApiStreamOptions<"openai-codex-responses">);
	}
	if (hasApi(model, "azure-openai-responses")) {
		return modelRegistry.complete(model, context, {
			...base,
			reasoningEffort: reasoning,
		} satisfies ModelsApiStreamOptions<"azure-openai-responses">);
	}

	if (hasApi(model, "google-generative-ai")) {
		return modelRegistry.complete(model, context, {
			...base,
			thinking: googleThinking(model, reasoning),
		} satisfies ModelsApiStreamOptions<"google-generative-ai">);
	}
	if (hasApi(model, "google-vertex")) {
		return modelRegistry.complete(model, context, {
			...base,
			thinking: googleThinking(model, reasoning),
		} satisfies ModelsApiStreamOptions<"google-vertex">);
	}

	if (hasApi(model, "mistral-conversations")) {
		const usesEffort = ["mistral-small-2603", "mistral-small-latest", "mistral-medium-3.5"].includes(model.id);
		return modelRegistry.complete(model, context, {
			...base,
			promptMode: reasoning && !usesEffort ? "reasoning" : undefined,
			reasoningEffort: reasoning && usesEffort ? mistralReasoningEffort(model, reasoning) : undefined,
		} satisfies ModelsApiStreamOptions<"mistral-conversations">);
	}

	if (hasApi(model, "bedrock-converse-stream")) {
		if (!reasoning || !isBedrockClaude(model) || bedrockSupportsAdaptiveThinking(model)) {
			return modelRegistry.complete(model, context, {
				...base,
				reasoning,
			} satisfies ModelsApiStreamOptions<"bedrock-converse-stream">);
		}
		const adjusted = adjustMaxTokensForThinking(base.maxTokens, model.maxTokens, reasoning);
		const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
		const budgetLevel = clampReasoning(reasoning);
		if (!budgetLevel) throw new Error("Bedrock reasoning budget requires an active thinking level");
		return modelRegistry.complete(model, context, {
			...base,
			maxTokens,
			reasoning,
			thinkingBudgets: {
				[budgetLevel]: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
			},
		} satisfies ModelsApiStreamOptions<"bedrock-converse-stream">);
	}

	throw new Error(`Unsupported child completion API: ${model.api}`);
}

export function createChildCompleter(modelRegistry: ModelRegistry): CompleteChild {
	return async ({ model, context, thinkingLevel, signal }) =>
		completeKnownChild(modelRegistry, model, context, thinkingLevel, signal);
}
