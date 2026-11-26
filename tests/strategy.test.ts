import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCompaction, collectFiles, collectPins, type BuildInput } from "../src/strategy.ts";

const user = (id: string, text: string) => ({ type: "message", id, message: { role: "user", content: [{ type: "text", text }] } });
const asst = (id: string, text: string) => ({ type: "message", id, message: { role: "assistant", content: [{ type: "text", text }] } });

const entries = [user("u1", "Build the parser. Use no deps."), asst("a1", "ok"), user("u2", "No, keep the old API"), asst("a2", "done"), user("u3", "now add tests")];

function input(over: Partial<BuildInput> = {}): BuildInput {
	return {
		strategy: "hybrid",
		preparation: {
			firstKeptEntryId: "u3",
			messagesToSummarize: entries.slice(0, 4).map((e) => e.message),
			turnPrefixMessages: [],
			tokensBefore: 50_000,
			previousSummary: undefined,
			fileOps: { read: new Set(["a.ts"]), written: new Set(["b.ts"]), edited: new Set(["c.ts"]) },
		},
		branchEntries: entries,
		pins: { originalRequest: true, userCorrections: true, maxTokens: 4000 },
		manualPins: [],
		contributions: [],
		summarize: async () => ({ text: "SUMMARY" }),
		...over,
	};
}

test("pins keep the original request and later user messages from the summarized part, verbatim", () => {
	const pins = collectPins(entries, "u3", { originalRequest: true, userCorrections: true, maxTokens: 4000 }, []);
	assert.deepEqual(pins, ["Original request: Build the parser. Use no deps.", "User: No, keep the old API"]);
	assert.deepEqual(collectPins(entries, null, { originalRequest: true, userCorrections: false, maxTokens: 4000 }, ["Never push"]), [
		"Original request: Build the parser. Use no deps.",
		"Pinned: Never push",
	]);
});

test("pins drop the oldest corrections first when over budget; manual pins and the request stay", () => {
	const many = [user("u1", "first"), ...Array.from({ length: 5 }, (_, i) => user(`c${i}`, `correction ${i} ${"x".repeat(40)}`))];
	const pins = collectPins(many, null, { originalRequest: true, userCorrections: true, maxTokens: 30 }, ["keep me"]);
	assert.equal(pins[0], "Original request: first");
	assert.ok(pins.includes("Pinned: keep me"));
	assert.ok(pins.some((p) => p.includes("correction 4")));
	assert.ok(!pins.some((p) => p.includes("correction 0")));
});

test("file lists accumulate across compactions; written and edited are modified", () => {
	const previous = [{ type: "compaction", id: "k", details: { compactor: { readFiles: ["old.ts", "a.ts"], modifiedFiles: ["m.ts"] } } }];
	assert.deepEqual(collectFiles(previous as never, { read: new Set(["a.ts", "z.ts"]), written: new Set(["b.ts"]), edited: new Set(["c.ts"]) }), {
		readFiles: ["a.ts", "old.ts", "z.ts"],
		modifiedFiles: ["b.ts", "c.ts", "m.ts"],
	});
});

test("summary strategy: LLM summary plus pins and files, keeps recent entries", async () => {
	const r = await buildCompaction(input({ strategy: "summary", handoff: "H" }));
	assert.equal(r.compaction.firstKeptEntryId, "u3");
	assert.match(r.compaction.summary, /^SUMMARY/);
	assert.doesNotMatch(r.compaction.summary, /Handoff/);
	assert.match(r.compaction.summary, /## Pinned\n- Original request: Build the parser/);
	assert.match(r.compaction.summary, /<read-files>\na\.ts\n<\/read-files>/);
	assert.match(r.compaction.summary, /<modified-files>\nb\.ts\nc\.ts\n<\/modified-files>/);
	assert.equal(r.compaction.tokensBefore, 50_000);
	assert.deepEqual(r.compaction.details.compactor.strategy, "summary");
});

test("hybrid: handoff and contributions first, then the summary, keeps recent entries", async () => {
	const r = await buildCompaction(input({ handoff: "Goal: parser", contributions: [{ source: "todo", handoff: "3 open todos" }] }));
	assert.equal(r.compaction.firstKeptEntryId, "u3");
	assert.ok(r.compaction.summary.startsWith("## Handoff\nGoal: parser\n\n## From todo\n3 open todos\n\n## Summary\nSUMMARY"));
	assert.equal(r.compaction.details.compactor.handoff, true);
});

test("handoff-only: no LLM call, retains nothing but handoff, contributions, pins and files", async () => {
	let called = false;
	const r = await buildCompaction(input({ strategy: "handoff-only", handoff: "Goal: parser", summarize: async () => ((called = true), { text: "X" }) }));
	assert.equal(called, false);
	assert.equal(r.compaction.firstKeptEntryId, null);
	assert.ok(r.compaction.summary.startsWith("## Handoff\nGoal: parser"));
	assert.match(r.compaction.summary, /## Pinned/);
	assert.equal(r.compaction.details.compactor.fallback, undefined);
});

test("handoff-only without a handoff falls back to hybrid and records it", async () => {
	const r = await buildCompaction(input({ strategy: "handoff-only" }));
	assert.equal(r.compaction.firstKeptEntryId, "u3");
	assert.match(r.compaction.summary, /SUMMARY/);
	assert.equal(r.compaction.details.compactor.strategy, "hybrid");
	assert.equal(r.compaction.details.compactor.fallback, "handoff-only without a handoff");
});

test("the previous summary feeds the summarizer and the usage is kept", async () => {
	let seen: unknown;
	const r = await buildCompaction(
		input({
			preparation: { ...input().preparation, previousSummary: "PREV" },
			summarize: async (req) => ((seen = req.previousSummary), { text: "S", usage: { input: 1 } as never }),
		}),
	);
	assert.equal(seen, "PREV");
	assert.deepEqual(r.compaction.usage, { input: 1 });
});

test("an empty or failing summary throws so Pi keeps its default", async () => {
	await assert.rejects(buildCompaction(input({ summarize: async () => ({ text: "  " }) })), /empty summary/);
	await assert.rejects(
		buildCompaction(
			input({
				summarize: async () => {
					throw new Error("rate limited");
				},
			}),
		),
		/rate limited/,
	);
});
