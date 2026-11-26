// Compaction preparation from Pi's boundary projection (`event.context.contextEntries`). Pi does not export its own
// `prepareCompaction`, so this mirrors it for compactions the cycle writes as a boundary draft: entries after the
// latest compaction, a cut that keeps about `keepRecentTokens` of recent context, split turns, and file operations.
// The cut never lands on a tool result, so a kept tool result always has its call.
import type { Preparation } from "./strategy.ts";

interface Projected {
	sourceEntry: { type: string; id: string; summary?: unknown };
	messages: unknown[];
}
type Msg = { role?: string; content?: unknown; nestedCalls?: { calls?: { name?: unknown; arguments?: unknown }[] } };

/** Pi's default `compaction.keepRecentTokens`. */
export const KEEP_RECENT_TOKENS = 20_000;

const CUT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);
const TURN_START_ROLES = new Set(["user", "bashExecution", "custom", "branchSummary", "compactionSummary"]);
const role = (m: unknown) => (m as Msg).role ?? "";

/** chars/4 over the JSON text; Pi's `estimateTokens` is injected at runtime. */
export const roughEstimate = (m: unknown) => Math.ceil(JSON.stringify(m ?? "").length / 4);

export function prepareFromProjection(entries: readonly Projected[], keepRecentTokens: number, estimate: (message: unknown) => number = roughEstimate): Preparation | undefined {
	if (entries.length === 0 || entries.at(-1)!.sourceEntry.type === "compaction") return undefined;
	let prev = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].sourceEntry.type === "compaction" && entries[i].messages.length > 0) {
			prev = i;
			break;
		}
	}
	const start = prev + 1;
	const size = (e: Projected) => e.messages.reduce<number>((n, m) => n + estimate(m), 0);
	const tokensBefore = entries.reduce((n, e) => n + size(e), 0);

	let from = -1;
	let acc = 0;
	for (let i = entries.length - 1; i >= start; i--) {
		acc += size(entries[i]);
		if (acc >= keepRecentTokens) {
			from = i;
			break;
		}
	}
	if (from < 0) return undefined;
	let cut = -1;
	for (let i = from; i < entries.length; i++) {
		if (entries[i].sourceEntry.type !== "compaction" && entries[i].messages.some((m) => CUT_ROLES.has(role(m)))) {
			cut = i;
			break;
		}
	}
	if (cut <= start) return undefined;
	let turnStart = cut;
	while (turnStart > start && !entries[turnStart].messages.some((m) => TURN_START_ROLES.has(role(m)))) turnStart--;
	const messagesOf = (slice: readonly Projected[]) => slice.flatMap((e) => (e.sourceEntry.type === "compaction" ? [] : e.messages.filter((m) => role(m) !== "system")));
	const messagesToSummarize = messagesOf(entries.slice(start, turnStart));
	const turnPrefixMessages = turnStart < cut ? messagesOf(entries.slice(turnStart, cut)) : [];
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

	const fileOps = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
	for (const m of [...messagesToSummarize, ...turnPrefixMessages]) addFileOps(m as Msg, fileOps);
	const previous = prev >= 0 ? entries[prev].sourceEntry.summary : undefined;
	return {
		firstKeptEntryId: entries[cut].sourceEntry.id,
		messagesToSummarize,
		turnPrefixMessages,
		tokensBefore,
		previousSummary: typeof previous === "string" ? previous : undefined,
		fileOps,
	};
}

function addFileOps(m: Msg, ops: NonNullable<Preparation["fileOps"]>) {
	const add = (name: unknown, args: unknown) => {
		const path = (args as { path?: unknown } | undefined)?.path;
		if (typeof path !== "string" || !path) return;
		if (name === "read") ops.read.add(path);
		else if (name === "write") ops.written.add(path);
		else if (name === "edit") ops.edited.add(path);
	};
	if (m.role === "toolResult") {
		for (const call of m.nestedCalls?.calls ?? []) add(call.name, call.arguments);
		return;
	}
	if (m.role !== "assistant" || !Array.isArray(m.content)) return;
	for (const block of m.content as { type?: string; name?: unknown; arguments?: unknown }[]) {
		if (block?.type === "toolCall") add(block.name, block.arguments);
	}
}
