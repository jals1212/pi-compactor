// Pruning planner for old, large tool outputs. Pure: takes the projected context entries Pi hands to a boundary
// handler (`event.context.contextEntries`, i.e. ProjectedSessionEntry[]) and returns `context_edit` drafts that
// replace the content of selected tool results with a short stub. The caller appends the drafts to the boundary's
// `entries` (a handler's returned `entries` REPLACES the event's, so return `[...event.entries, ...edits]`).
//
// Rules: only tool results; at least `minToolResultTokens` (chars/4); never inside the last `keepRecentTurns` turns
// (a turn starts at a user message); never already pruned (stub marker); superseded reads (a later successful read
// of the same path) first, then the largest outputs. User/assistant messages are never touched.
import type { CompactorConfig } from "./config.ts";

export type PruningConfig = CompactorConfig["pruning"];

/** Shape of a `context_edit` boundary draft (Pi `ContextEditEntryDraft`) restricted to what this planner emits. */
export interface ContextEditDraft {
	type: "context_edit";
	targetId: string;
	replacement: { content: { type: "text"; text: string }[] };
}

export interface PruningPlan {
	edits: ContextEditDraft[];
	/** Estimated tokens saved: removed output minus the stub that replaces it. */
	savedTokens: number;
}

export interface PruningOptions {
	/** Stop adding edits once this many tokens are saved. Default: no limit. */
	targetTokens?: number;
}

/** Every stub starts with this text; a tool result that starts with it is already pruned. */
export const PRUNED_MARKER = "[pruned by the compactor:";

export const estimateTextTokens = (text: string): number => Math.ceil(text.length / 4);

interface Block {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}
interface Message {
	role?: string;
	content?: unknown;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
}
/** Structural subset of Pi's ProjectedSessionEntry: `sourceEntry` is raw, `messages` has edits applied. */
export interface ContextEntryLike {
	sourceEntry?: { type?: string; id?: string; message?: Message };
	messages?: Message[];
}

interface Candidate {
	index: number;
	id: string;
	toolName: string;
	target: string | null;
	tokens: number;
	superseded: boolean;
}

const blocks = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return blocks(content)
		.filter((b) => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

const pathArg = (args: Record<string, unknown> | undefined): string | null => {
	const value = args?.path ?? args?.file_path;
	return typeof value === "string" && value.trim() ? value.trim() : null;
};

export function pruneStub(toolName: string, target: string | null, tokens: number): string {
	const what = target ? `${toolName} ${target}` : toolName;
	return `${PRUNED_MARKER} ${what} output (~${tokens} tokens) removed to save context. Re-run the tool if you need it again.]`;
}

export function planPruning(
	contextEntries: readonly ContextEntryLike[],
	config: PruningConfig,
	options: PruningOptions = {},
): PruningPlan {
	const none: PruningPlan = { edits: [], savedTokens: 0 };
	if (!config.enabled) return none;

	// Tool call arguments by call id (for the read path), from the assistant messages as projected.
	const calls = new Map<string, { name?: string; arguments?: Record<string, unknown> }>();
	const userIndexes: number[] = [];
	contextEntries.forEach((entry, index) => {
		const message = entry.sourceEntry?.type === "message" ? entry.sourceEntry.message : undefined;
		if (message?.role === "user") userIndexes.push(index);
		for (const projected of entry.messages ?? []) {
			if (projected.role !== "assistant") continue;
			for (const block of blocks(projected.content)) {
				if (block?.type === "toolCall" && block.id) calls.set(block.id, { name: block.name, arguments: block.arguments });
			}
		}
	});

	// Everything from the keepRecentTurns-th user message from the end is protected; fewer turns protects all.
	const keep = Math.max(0, Math.floor(config.keepRecentTurns));
	let protectedFrom = contextEntries.length;
	if (keep > 0) protectedFrom = userIndexes.length >= keep ? userIndexes[userIndexes.length - keep] : 0;

	// Latest successful read per path, to flag earlier reads as superseded (protected or small later reads count).
	const readPaths: (string | null)[] = contextEntries.map((entry) => {
		const message = entry.sourceEntry?.type === "message" ? entry.sourceEntry.message : undefined;
		if (message?.role !== "toolResult" || message.toolName !== "read" || message.isError) return null;
		return pathArg(calls.get(message.toolCallId ?? "")?.arguments);
	});
	const lastRead = new Map<string, number>();
	readPaths.forEach((path, index) => path && lastRead.set(path, index));

	const candidates: Candidate[] = [];
	contextEntries.forEach((entry, index) => {
		if (index >= protectedFrom) return;
		const source = entry.sourceEntry;
		const original = source?.type === "message" ? source.message : undefined;
		if (!source?.id || original?.role !== "toolResult") return;
		// Current content after earlier edits; an omitted (null-edit) entry has no messages.
		const current = entry.messages?.find((m) => m.role === "toolResult");
		if (!current) return;
		const text = textOf(current.content);
		if (text.startsWith(PRUNED_MARKER)) return;
		const tokens = estimateTextTokens(text);
		if (tokens < config.minToolResultTokens) return;
		const toolName = original.toolName ?? calls.get(original.toolCallId ?? "")?.name ?? "tool";
		const path = readPaths[index];
		const target = pathArg(calls.get(original.toolCallId ?? "")?.arguments);
		candidates.push({
			index,
			id: source.id,
			toolName,
			target,
			tokens,
			superseded: path !== null && (lastRead.get(path) ?? index) > index,
		});
	});

	candidates.sort((a, b) => Number(b.superseded) - Number(a.superseded) || b.tokens - a.tokens || a.index - b.index);

	const plan: PruningPlan = { edits: [], savedTokens: 0 };
	for (const candidate of candidates) {
		if (options.targetTokens !== undefined && plan.savedTokens >= options.targetTokens) break;
		const stub = pruneStub(candidate.toolName, candidate.target, candidate.tokens);
		const saved = candidate.tokens - estimateTextTokens(stub);
		if (saved <= 0) continue;
		plan.edits.push({ type: "context_edit", targetId: candidate.id, replacement: { content: [{ type: "text", text: stub }] } });
		plan.savedTokens += saved;
	}
	return plan;
}
