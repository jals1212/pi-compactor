// Builds the compaction entry for each strategy. Pure apart from the injected summarizer, so tests need no LLM.
//   summary       LLM summary of the discarded part; recent entries kept.
//   hybrid        handoff + contributions + LLM summary; recent entries kept. Default.
//   handoff-only  handoff + contributions only, nothing kept (firstKeptEntryId null). Without a handoff: hybrid.
// Every strategy appends pins (verbatim) and the cumulative read/modified file lists, which Pi drops for extension
// summaries, and records them in details.compactor for the next compaction.
import type { CompactorConfig, Strategy } from "./config.ts";
import type { Contribution } from "./protocol.ts";

interface Msg {
	role?: string;
	content?: unknown;
}
interface Entry {
	type: string;
	id: string;
	message?: Msg;
	details?: unknown;
}

export interface Preparation {
	firstKeptEntryId: string;
	messagesToSummarize: unknown[];
	turnPrefixMessages: unknown[];
	tokensBefore: number;
	previousSummary?: string;
	fileOps?: { read: Set<string>; written: Set<string>; edited: Set<string> };
}

export interface SummarizeRequest {
	messages: unknown[];
	previousSummary?: string;
	/** Extra guidance for the summarizer (the handoff, so the summary does not repeat it). */
	instructions?: string;
}

export interface BuildInput {
	strategy: Strategy;
	preparation: Preparation;
	branchEntries: unknown[];
	handoff?: string;
	contributions: Contribution[];
	pins: CompactorConfig["pins"];
	manualPins: string[];
	summarize(request: SummarizeRequest): Promise<{ text: string; usage?: unknown }>;
}

export interface CompactorDetails {
	strategy: Strategy;
	fallback?: string;
	handoff: boolean;
	pins: number;
	readFiles: string[];
	modifiedFiles: string[];
}

export interface Built {
	compaction: {
		summary: string;
		firstKeptEntryId: string | null;
		tokensBefore: number;
		usage?: unknown;
		details: { compactor: CompactorDetails };
	};
}

const tokens = (text: string) => Math.ceil(text.length / 4);

function textOf(message: Msg | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((c): c is { type: "text"; text: string } => typeof c === "object" && c !== null && (c as { type?: string }).type === "text")
		.map((c) => c.text)
		.join("\n");
}

/** Verbatim user text worth keeping: the original request, later user messages that are being discarded, manual pins. */
export function collectPins(branchEntries: unknown[], firstKeptEntryId: string | null, config: CompactorConfig["pins"], manualPins: string[]): string[] {
	const entries = branchEntries as Entry[];
	const keptFrom = firstKeptEntryId === null ? -1 : entries.findIndex((e) => e.id === firstKeptEntryId);
	const users = entries
		.map((e, i) => ({ e, i }))
		.filter(({ e }) => e.type === "message" && e.message?.role === "user" && textOf(e.message).trim() !== "");
	const out: string[] = [];
	let budget = config.maxTokens;
	const first = users[0];
	if (config.originalRequest && first && (keptFrom < 0 || first.i < keptFrom)) {
		const pin = `Original request: ${textOf(first.e.message).trim()}`;
		out.push(pin);
		budget -= tokens(pin);
	}
	const manual = manualPins.map((p) => `Pinned: ${p}`);
	budget -= manual.reduce((n, p) => n + tokens(p), 0);
	const corrections: string[] = [];
	if (config.userCorrections) {
		const discarded = users.slice(1).filter(({ i }) => keptFrom < 0 || i < keptFrom);
		// Newest first so the budget keeps the latest corrections.
		for (const { e } of discarded.reverse()) {
			const pin = `User: ${textOf(e.message).trim()}`;
			if (tokens(pin) > budget) break;
			corrections.unshift(pin);
			budget -= tokens(pin);
		}
	}
	return [...out, ...corrections, ...manual];
}

export function collectFiles(branchEntries: unknown[], fileOps: Preparation["fileOps"]): { readFiles: string[]; modifiedFiles: string[] } {
	const read = new Set<string>();
	const modified = new Set<string>();
	for (const e of branchEntries as Entry[]) {
		const d = (e.type === "compaction" ? (e.details as { compactor?: CompactorDetails } | undefined)?.compactor : undefined) ?? undefined;
		for (const f of d?.readFiles ?? []) read.add(f);
		for (const f of d?.modifiedFiles ?? []) modified.add(f);
	}
	for (const f of fileOps?.read ?? []) read.add(f);
	for (const f of fileOps?.written ?? []) modified.add(f);
	for (const f of fileOps?.edited ?? []) modified.add(f);
	for (const f of modified) read.delete(f);
	return { readFiles: [...read].sort(), modifiedFiles: [...modified].sort() };
}

function tail(pins: string[], files: { readFiles: string[]; modifiedFiles: string[] }): string {
	const parts: string[] = [];
	if (pins.length > 0) parts.push(`## Pinned\n${pins.map((p) => `- ${p}`).join("\n")}`);
	if (files.readFiles.length > 0) parts.push(`<read-files>\n${files.readFiles.join("\n")}\n</read-files>`);
	if (files.modifiedFiles.length > 0) parts.push(`<modified-files>\n${files.modifiedFiles.join("\n")}\n</modified-files>`);
	return parts.join("\n\n");
}

function handoffSections(handoff: string | undefined, contributions: Contribution[]): string[] {
	const parts: string[] = [];
	if (handoff) parts.push(`## Handoff\n${handoff}`);
	for (const c of contributions) if (c.handoff) parts.push(`## From ${c.source}\n${c.handoff}`);
	return parts;
}

export async function buildCompaction(input: BuildInput): Promise<Built> {
	const handoff = input.handoff?.trim() || undefined;
	let strategy = input.strategy;
	let fallback: string | undefined;
	if (strategy === "handoff-only" && !handoff) {
		strategy = "hybrid";
		fallback = "handoff-only without a handoff";
	}
	const firstKeptEntryId = strategy === "handoff-only" ? null : input.preparation.firstKeptEntryId;
	const pins = collectPins(input.branchEntries, firstKeptEntryId, input.pins, input.manualPins);
	const files = collectFiles(input.branchEntries, input.preparation.fileOps);

	const parts: string[] = [];
	let usage: unknown;
	if (strategy !== "summary") parts.push(...handoffSections(handoff, input.contributions));
	if (strategy !== "handoff-only") {
		const result = await input.summarize({
			messages: [...input.preparation.messagesToSummarize, ...input.preparation.turnPrefixMessages],
			previousSummary: input.preparation.previousSummary,
			instructions: strategy === "hybrid" && handoff ? `The agent's own handoff is kept separately; do not repeat it:\n${handoff}` : undefined,
		});
		if (!result.text.trim()) throw new Error("empty summary");
		usage = result.usage;
		parts.push(strategy === "summary" ? result.text.trim() : `## Summary\n${result.text.trim()}`);
	}
	const end = tail(pins, files);
	if (end) parts.push(end);

	const details: CompactorDetails = { strategy, handoff: handoff !== undefined, pins: pins.length, ...files };
	if (fallback) details.fallback = fallback;
	const compaction: Built["compaction"] = { summary: parts.join("\n\n"), firstKeptEntryId, tokensBefore: input.preparation.tokensBefore, details: { compactor: details } };
	if (usage !== undefined) compaction.usage = usage;
	return { compaction };
}
