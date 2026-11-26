// Compaction preparation from Pi's boundary projection (`event.context.contextEntries`). Pi does not export its own
// `prepareCompaction`, so this mirrors it for compactions the cycle writes as a boundary draft: entries after the
// latest compaction, a cut that keeps about `keepRecentTokens` of recent context, split turns, and file operations.
// The cut never lands on a tool result, so a kept tool result always has its call.
import type { Preparation } from "./strategy.ts";

interface Projected {
	sourceEntry: { type: string; id: string; summary?: unknown; details?: unknown; fromHook?: boolean; targetId?: unknown; replacement?: unknown; message?: { role?: string } };
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
	// Pi projects the newest compaction first; older ones in its retained range contribute no messages.
	const prev = entries.findIndex((e) => e.sourceEntry.type === "compaction" && e.messages.length > 0);
	const start = prev + 1;
	const size = (e: Projected) => e.messages.reduce<number>((n, m) => n + estimate(m), 0);
	const tokensBefore = entries.reduce((n, e) => n + size(e), 0);

	const { cut, turnStart, isSplit } = findCut(entries, start, keepRecentTokens, size);
	const firstKept = entries[cut]?.sourceEntry.id;
	if (!firstKept) return undefined;
	const messagesOf = (slice: readonly Projected[]) => slice.flatMap((e) => (e.sourceEntry.type === "compaction" ? [] : e.messages.filter((m) => role(m) !== "system")));
	const messagesToSummarize = messagesOf(entries.slice(start, isSplit ? turnStart : cut));
	const turnPrefixMessages = isSplit ? messagesOf(entries.slice(turnStart, cut)) : [];
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

	const fileOps = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
	// Pi seeds from the previous compaction's own details unless an extension wrote it (cumulative `details.compactor`
	// lists of this package's compactions are merged later by `collectFiles`).
	const prevEntry = prev >= 0 ? entries[prev].sourceEntry : undefined;
	if (prevEntry && !prevEntry.fromHook && prevEntry.details) {
		const d = prevEntry.details as { readFiles?: unknown; modifiedFiles?: unknown };
		if (Array.isArray(d.readFiles)) for (const f of d.readFiles) fileOps.read.add(f);
		if (Array.isArray(d.modifiedFiles)) for (const f of d.modifiedFiles) fileOps.edited.add(f);
	}
	for (const m of [...messagesToSummarize, ...turnPrefixMessages]) addFileOps(m as Msg, fileOps);
	const previous = prevEntry?.summary;
	return {
		firstKeptEntryId: firstKept,
		messagesToSummarize,
		turnPrefixMessages,
		tokensBefore,
		previousSummary: typeof previous === "string" ? previous : undefined,
		fileOps,
	};
}

const isTurnStart = (e: Projected) => e.sourceEntry.type !== "compaction" && e.messages.some((m) => TURN_START_ROLES.has(role(m)));
/** What Pi's `sessionEntryToContextMessages` would project for the raw entry, ignoring context edits. */
const intrinsicallyVisible = (s: Projected["sourceEntry"]) => ["message", "custom_message", "compaction"].includes(s.type) || (s.type === "branch_summary" && !!s.summary);

/** Mirror of Pi 1.6.1 `findProjectedCutPoint` over the projection. */
function findCut(entries: readonly Projected[], start: number, keep: number, size: (e: Projected) => number) {
	const end = entries.length;
	const cutPoints: number[] = [];
	for (let i = start; i < end; i++) {
		if (entries[i].sourceEntry.type !== "compaction" && entries[i].messages.some((m) => CUT_ROLES.has(role(m)))) cutPoints.push(i);
	}
	if (cutPoints.length === 0) return { cut: start, turnStart: -1, isSplit: false };

	let acc = 0;
	let exceeded = false;
	let cut = cutPoints[0];
	for (let i = end - 1; i >= start; i--) {
		const tokens = size(entries[i]);
		if (tokens === 0) continue;
		acc += tokens;
		if (acc >= keep) {
			exceeded = true;
			cut = cutPoints.find((c) => c >= i) ?? cutPoints[cutPoints.length - 1];
			break;
		}
	}

	// A closed suffix holding an omitted assistant attempt (recovery) and its omission edits is invisible after the last
	// visible input: advance past it. Arbitrary metadata must not move the cut past unsent input.
	const suffix = entries.slice(cut + 1, end);
	const visible = (e: Projected) => e.sourceEntry.type !== "context_edit" && intrinsicallyVisible(e.sourceEntry);
	const omitted = (e: Projected) => visible(e) && e.messages.length === 0;
	const omittedIds = new Set(suffix.filter(omitted).map((e) => e.sourceEntry.id));
	const externalReplacement = suffix.some((e) => e.sourceEntry.type === "context_edit" && e.sourceEntry.replacement !== null && !omittedIds.has(e.sourceEntry.targetId as string));
	const recovery =
		exceeded &&
		!externalReplacement &&
		suffix.some((e) => e.sourceEntry.type === "message" && e.sourceEntry.message?.role === "assistant" && omitted(e)) &&
		suffix.every((e) => e.sourceEntry.type !== "compaction" && (!visible(e) || omitted(e)));
	if (recovery) cut++;
	while (cut > start) {
		const before = entries[cut - 1];
		if (before.sourceEntry.type === "compaction" || before.messages.length > 0) break;
		cut--;
	}

	if (isTurnStart(entries[cut])) return { cut, turnStart: -1, isSplit: false };
	let turnStart = -1;
	for (let i = cut; i >= start; i--) {
		if (isTurnStart(entries[i])) {
			turnStart = i;
			break;
		}
	}
	return { cut, turnStart, isSplit: turnStart !== -1 };
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
