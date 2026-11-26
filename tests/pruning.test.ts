import assert from "node:assert/strict";
import { test } from "node:test";
import { planPruning, PRUNED_MARKER, type ContextEntryLike } from "../src/pruning.ts";

const cfg = { enabled: true, minToolResultTokens: 100, keepRecentTurns: 1 };
const big = (tokens: number) => "x".repeat(tokens * 4);

const proj = (id: string, message: Record<string, unknown>, messages = [message]): ContextEntryLike => ({
	sourceEntry: { type: "message", id, message },
	messages,
});
const user = (id: string, text = "go") => proj(id, { role: "user", content: [{ type: "text", text }] });
const asst = (id: string, calls: { id: string; name: string; path?: string }[]) =>
	proj(id, {
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.path ? { path: c.path } : { command: "ls" } })),
	});
const result = (id: string, callId: string, toolName: string, text: string, isError = false) =>
	proj(id, { role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text }], isError });

const stub = (what: string, tokens: number) =>
	`[pruned by the compactor: ${what} output (~${tokens} tokens) removed to save context. Re-run the tool if you need it again.]`;
const edit = (targetId: string, text: string) => ({ type: "context_edit", targetId, replacement: { content: [{ type: "text", text }] } });

/** u1 + one bash call with the given output, then u2 (the only protected turn with keepRecentTurns 1). */
const single = (text: string, isError = false): ContextEntryLike[] => [
	user("u1"),
	asst("a1", [{ id: "c1", name: "bash" }]),
	result("t1", "c1", "bash", text, isError),
	user("u2"),
];

const frozen = <T>(value: T): T => structuredClone(value);

test("prunes an old large tool result with an exact stub naming the tool, tokens and re-run hint", () => {
	const entries = single(big(500));
	const before = frozen(entries);
	const plan = planPruning(entries, cfg);
	const text = stub("bash", 500);
	assert.equal(text, "[pruned by the compactor: bash output (~500 tokens) removed to save context. Re-run the tool if you need it again.]");
	assert.deepEqual(plan.edits, [edit("t1", text)]);
	assert.equal(plan.savedTokens, 500 - Math.ceil(text.length / 4));
	assert.ok(text.startsWith(PRUNED_MARKER));
	assert.deepEqual(entries, before);
});

test("only tool results are edited: user and assistant messages stay untouched however large", () => {
	const entries = [user("u1", big(1000)), asst("a1", [{ id: "c1", name: "bash" }]), proj("a2", { role: "assistant", content: [{ type: "text", text: big(1000) }] }), user("u2")];
	const before = frozen(entries);
	assert.deepEqual(planPruning(entries, cfg), { edits: [], savedTokens: 0 });
	assert.deepEqual(entries, before);
});

test("results under minToolResultTokens are kept; exactly at the threshold are pruned", () => {
	assert.deepEqual(planPruning(single(big(99)), cfg).edits, []);
	assert.deepEqual(planPruning(single(big(100)), cfg).edits, [edit("t1", stub("bash", 100))]);
});

test("never prunes inside the last keepRecentTurns turns; a turn starts at a user message", () => {
	const turns = (keep: number) =>
		planPruning(
			[
				user("u1"), asst("a1", [{ id: "c1", name: "bash" }]), result("t1", "c1", "bash", big(300)),
				user("u2"), asst("a2", [{ id: "c2", name: "bash" }]), result("t2", "c2", "bash", big(300)),
				user("u3"), asst("a3", [{ id: "c3", name: "bash" }]), result("t3", "c3", "bash", big(300)),
			],
			{ ...cfg, keepRecentTurns: keep },
		).edits.map((e) => e.targetId).sort();
	assert.deepEqual(turns(0), ["t1", "t2", "t3"]);
	assert.deepEqual(turns(1), ["t1", "t2"]);
	assert.deepEqual(turns(2), ["t1"]);
	assert.deepEqual(turns(3), []);
	assert.deepEqual(turns(10), []);
});

test("skips results already pruned, including ones whose projected content is an earlier stub", () => {
	const text = stub("bash", 500);
	const already = result("t1", "c1", "bash", big(500));
	already.messages = [{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text }], isError: false }];
	const entries = [user("u1"), asst("a1", [{ id: "c1", name: "bash" }]), already, user("u2")];
	assert.deepEqual(planPruning(entries, cfg), { edits: [], savedTokens: 0 });
	// An entry omitted by a null edit has no projected messages and is skipped too.
	const omitted = result("t1", "c1", "bash", big(500));
	omitted.messages = [];
	assert.deepEqual(planPruning([user("u1"), asst("a1", [{ id: "c1", name: "bash" }]), omitted, user("u2")], cfg).edits, []);
});

test("superseded reads (a later read of the same path) go first, then the largest outputs", () => {
	const entries = [
		user("u1"),
		asst("a1", [{ id: "c1", name: "read", path: "src/a.ts" }]),
		result("t1", "c1", "read", big(200)),
		asst("a2", [{ id: "c2", name: "bash" }]),
		result("t2", "c2", "bash", big(900)),
		asst("a3", [{ id: "c3", name: "bash" }]),
		result("t3", "c3", "bash", big(400)),
		asst("a4", [{ id: "c4", name: "read", path: "src/a.ts" }]),
		result("t4", "c4", "read", big(150)),
		asst("a5", [{ id: "c5", name: "read", path: "src/b.ts" }]),
		result("t5", "c5", "read", big(600)),
		user("u2"),
	];
	const before = frozen(entries);
	const plan = planPruning(entries, cfg);
	assert.deepEqual(
		plan.edits.map((e) => e.targetId),
		["t1", "t2", "t5", "t3", "t4"],
	);
	assert.equal(plan.edits[0].replacement.content[0].text, stub("read src/a.ts", 200));
	assert.equal(plan.edits[4].replacement.content[0].text, stub("read src/a.ts", 150));
	assert.deepEqual(entries, before);
});

test("a superseding read inside the protected turns still marks the older read superseded", () => {
	const entries = [
		user("u1"),
		asst("a1", [{ id: "c1", name: "read", path: "a.ts" }]),
		result("t1", "c1", "read", big(200)),
		asst("a2", [{ id: "c2", name: "bash" }]),
		result("t2", "c2", "bash", big(900)),
		user("u2"),
		asst("a3", [{ id: "c3", name: "read", path: "a.ts" }]),
		result("t3", "c3", "read", big(200)),
	];
	assert.deepEqual(
		planPruning(entries, cfg).edits.map((e) => e.targetId),
		["t1", "t2"],
	);
	// A failed later read does not supersede.
	entries[7] = result("t3", "c3", "read", big(200), true);
	assert.deepEqual(
		planPruning(entries, cfg).edits.map((e) => e.targetId),
		["t2", "t1"],
	);
});

test("error results are pruned only when large; short errors are left alone", () => {
	assert.deepEqual(planPruning(single("Error: ENOENT no such file", true), cfg), { edits: [], savedTokens: 0 });
	assert.deepEqual(planPruning(single("Error: ENOENT no such file", true), { ...cfg, minToolResultTokens: 1 }).edits, []);
	assert.deepEqual(planPruning(single(big(400), true), cfg).edits, [edit("t1", stub("bash", 400))]);
});

test("disabled pruning and targetTokens bound the plan", () => {
	const entries = [
		user("u1"),
		asst("a1", [{ id: "c1", name: "bash" }, { id: "c2", name: "bash" }]),
		result("t1", "c1", "bash", big(300)),
		result("t2", "c2", "bash", big(800)),
		user("u2"),
	];
	assert.deepEqual(planPruning(entries, { ...cfg, enabled: false }), { edits: [], savedTokens: 0 });
	const limited = planPruning(entries, cfg, { targetTokens: 500 });
	assert.deepEqual(limited.edits.map((e) => e.targetId), ["t2"]);
	assert.ok(limited.savedTokens >= 500);
	assert.deepEqual(planPruning(entries, cfg).edits.map((e) => e.targetId), ["t2", "t1"]);
});

test("a tool result whose call is unknown uses the recorded tool name; string content is handled", () => {
	const entries = [user("u1"), result("t1", "missing", "grep", big(300)), user("u2")];
	entries[1].messages = [{ role: "toolResult", toolCallId: "missing", toolName: "grep", content: big(300) }];
	assert.deepEqual(planPruning(entries, cfg).edits, [edit("t1", stub("grep", 300))]);
});
