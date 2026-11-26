import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareFromProjection } from "../src/prepare.ts";

// Each message carries its own size so the cut is predictable; Pi's estimateTokens is injected the same way.
const estimate = (m: unknown) => (m as { tokens: number }).tokens;
const entry = (id: string, role: string, tokens: number, extra: Record<string, unknown> = {}) => {
	const message = { role, tokens, content: [], ...extra };
	return { sourceEntry: { type: "message", id, message }, messages: [message] };
};
const read = (path: string) => ({ content: [{ type: "toolCall", id: "c", name: "read", arguments: { path } }] });

test("a session smaller than keepRecentTokens has nothing to compact", () => {
	const es = [entry("u1", "user", 100), entry("a1", "assistant", 100)];
	assert.equal(prepareFromProjection(es, 1000, estimate), undefined);
	assert.equal(prepareFromProjection([], 1000, estimate), undefined);
});

test("cuts at the turn that holds keepRecentTokens and summarizes every whole turn before it", () => {
	const es = [
		entry("u1", "user", 100),
		entry("a1", "assistant", 100, read("a.ts")),
		entry("t1", "toolResult", 5000),
		entry("u2", "user", 100),
		entry("a2", "assistant", 900),
	];
	const p = prepareFromProjection(es, 1000, estimate)!;
	assert.equal(p.firstKeptEntryId, "u2");
	assert.deepEqual(p.messagesToSummarize, es.slice(0, 3).map((e) => e.messages[0]));
	assert.deepEqual(p.turnPrefixMessages, []);
	assert.equal(p.tokensBefore, 6200);
	assert.equal(p.previousSummary, undefined);
	assert.deepEqual([...p.fileOps!.read], ["a.ts"]);
});

test("one long turn is split: its prefix is summarized and the cut lands on an assistant message, never a tool result", () => {
	const es = [
		entry("u1", "user", 100),
		entry("a1", "assistant", 100),
		entry("t1", "toolResult", 5000),
		entry("a2", "assistant", 100),
		entry("t2", "toolResult", 5000),
		entry("a3", "assistant", 100),
	];
	const p = prepareFromProjection(es, 5000, estimate)!;
	assert.equal(p.firstKeptEntryId, "a3", "t2 alone reaches 5000 but a tool result is never a cut point");
	assert.deepEqual(p.messagesToSummarize, []);
	assert.deepEqual(p.turnPrefixMessages, es.slice(0, 5).map((e) => e.messages[0]));
});

test("only entries after the latest compaction count, and its summary becomes previousSummary", () => {
	const summaryMsg = { role: "compactionSummary", tokens: 50, summary: "OLD" };
	const es = [
		{ sourceEntry: { type: "compaction", id: "c1", summary: "OLD" }, messages: [summaryMsg] },
		entry("a1", "assistant", 100, read("old.ts")),
		entry("u2", "user", 2000),
	];
	const p = prepareFromProjection(es, 1000, estimate)!;
	assert.equal(p.previousSummary, "OLD");
	assert.equal(p.firstKeptEntryId, "u2");
	assert.deepEqual(p.messagesToSummarize, [es[1].messages[0]]);
	assert.deepEqual([...p.fileOps!.read], ["old.ts"]);
});

test("nothing to compact right after a compaction", () => {
	const es = [entry("u1", "user", 5000), { sourceEntry: { type: "compaction", id: "c1", summary: "S" }, messages: [{ role: "compactionSummary", tokens: 10 }] }];
	assert.equal(prepareFromProjection(es, 10, estimate), undefined);
});

test("file operations come from tool calls and nested calls: read, write and edit", () => {
	const es = [
		entry("u1", "user", 10),
		entry("a1", "assistant", 10, {
			content: [
				{ type: "toolCall", id: "1", name: "write", arguments: { path: "w.ts" } },
				{ type: "toolCall", id: "2", name: "edit", arguments: { path: "e.ts" } },
				{ type: "toolCall", id: "3", name: "bash", arguments: { command: "ls" } },
			],
		}),
		entry("t1", "toolResult", 10, { nestedCalls: { calls: [{ name: "read", arguments: { path: "n.ts" } }] } }),
		entry("u2", "user", 5000),
	];
	const p = prepareFromProjection(es, 1000, estimate)!;
	assert.deepEqual([...p.fileOps!.written], ["w.ts"]);
	assert.deepEqual([...p.fileOps!.edited], ["e.ts"]);
	assert.deepEqual([...p.fileOps!.read], ["n.ts"]);
});
