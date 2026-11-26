// LLM summarizer for the compaction strategies: the configured summary model (else the session model) answers one
// prompt, as in Pi's custom-compaction example. Pi's serializer is injected (runtime import), so this runs under
// plain `node --test`.
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SummarizeRequest } from "./strategy.ts";

export const SUMMARY_MAX_TOKENS = 8192;

export interface SummarizerDeps {
	ctx: Pick<ExtensionContext, "model" | "modelRegistry">;
	/** `provider/modelId`; null uses the session model. */
	summaryModel: string | null;
	signal?: AbortSignal;
	/** Messages to readable text: `serializeConversation(convertToLlm(messages))`. */
	serialize(messages: unknown[]): string;
	warn?(text: string): void;
	sessionId?(): string;
}

interface Response {
	content: { type: string; text?: string }[];
	stopReason: string;
	usage?: unknown;
	errorMessage?: string;
}

function pickModel(deps: SummarizerDeps) {
	if (deps.summaryModel) {
		const at = deps.summaryModel.indexOf("/");
		const found = at > 0 ? deps.ctx.modelRegistry.find(deps.summaryModel.slice(0, at), deps.summaryModel.slice(at + 1)) : undefined;
		if (found) return found;
		deps.warn?.(`summaryModel ${deps.summaryModel} was not found; using the session model`);
	}
	if (deps.ctx.model) return deps.ctx.model;
	throw new Error("no model available to summarize (set summaryModel or select a model)");
}

export function buildPrompt(conversation: string, request: SummarizeRequest): string {
	const parts = [
		"You are summarizing a coding-agent conversation so the work can continue after the context is compacted. The summary replaces the discarded messages, so it must contain everything needed to carry on:",
		"1. Goals and the user's requests, including constraints and corrections\n2. Decisions made and why\n3. Current state: what is done, what is in progress, blockers and open questions\n4. Next steps\n5. Files and commands that matter, with exact paths and names",
		"Be concise and factual; use structured markdown with these sections. Do not invent anything.",
	];
	if (request.previousSummary) parts.push(`Previous summary, to merge with the conversation below (keep what is still true, update the rest):\n<previous-summary>\n${request.previousSummary}\n</previous-summary>`);
	if (request.instructions) parts.push(`Additional guidance:\n${request.instructions}`);
	parts.push(`<conversation>\n${conversation}\n</conversation>`);
	return parts.join("\n\n");
}

export function createSummarizer(deps: SummarizerDeps) {
	return async (request: SummarizeRequest): Promise<{ text: string; usage?: unknown }> => {
		const model = pickModel(deps);
		const prompt = buildPrompt(deps.serialize(request.messages), request);
		const response = (await deps.ctx.modelRegistry.complete(
			model,
			{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
			{ maxTokens: SUMMARY_MAX_TOKENS, signal: deps.signal, cacheRetention: "none", sessionId: deps.sessionId?.() ?? randomUUID() },
		)) as unknown as Response;
		if (response.stopReason === "length" || response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(`summary ${response.stopReason}${response.errorMessage ? `: ${response.errorMessage}` : ""}`);
		}
		const text = response.content
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text)
			.join("\n")
			.trim();
		return { text, usage: response.usage };
	};
}
