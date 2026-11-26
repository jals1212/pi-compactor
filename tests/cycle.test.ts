import assert from "node:assert/strict";
import { test } from "node:test";
import { registerCompactor } from "../src/wire.ts";
import { PIN_TYPE } from "../src/cycle.ts";
import { fakePi, reply } from "./helpers.ts";

const turnEnd = (toolResults = 0, outcome = "completed", context?: unknown) => ({ outcome, toolResults: Array.from({ length: toolResults }, () => ({})), entries: [], continue: false, context });
const user = (id: string, text: string) => ({ type: "message", id, message: { role: "user", text, content: [{ type: "text", text }] } });
const assistant = (id: string, text: string) => ({ type: "message", id, message: { role: "assistant", text, content: [{ type: "text", text }] } });
const branch = [user("u1", "Build the parser"), assistant("a1", "ok"), user("u2", "keep the old API"), assistant("a2", "done"), user("u3", "add tests")];
const compactEvent = (over: Record<string, unknown> = {}) => ({
	reason: "manual",
	willRetry: false,
	signal: new AbortController().signal,
	branchEntries: branch,
	preparation: {
		firstKeptEntryId: "u3",
		messagesToSummarize: branch.slice(0, 4).map((e) => e.message),
		turnPrefixMessages: [],
		tokensBefore: 80_000,
		previousSummary: undefined,
		fileOps: { read: new Set(["a.ts"]), written: new Set(), edited: new Set(["b.ts"]) },
	},
	...over,
});
const settle = (outcome = "completed", context?: unknown) => ({ outcome, entries: [], continue: false, context });
/** Pi's boundary projection of `branch`: every message weighs 500 tokens and keepRecentTokens is 500, so the cut is u3. */
const session = () => ({ contextEntries: branch.map((e) => ({ sourceEntry: e, messages: [e.message] })) });

async function setup(options: Parameters<typeof fakePi>[0] = {}) {
	const f = fakePi(options);
	const api = registerCompactor(f.pi, {
		agentDir: f.agentDir,
		stderr: (t) => void f.stderr.push(t),
		convertToLlm: (messages: unknown[]) => messages,
		serializeConversation: (messages: unknown[]) => messages.map((m) => `[${(m as any).role}] ${(m as any).text}`).join("\n"),
		estimateTokens: () => 500,
		keepRecentTokens: () => 500,
	} as never);
	await f.fire("session_start", { reason: "startup" });
	return { f, api };
}

test("registers the compaction_ready and compaction_defer tools", async () => {
	const { f } = await setup();
	assert.deepEqual([...f.tools.keys()].sort(), ["compaction_defer", "compaction_ready"]);
	assert.equal(f.tools.get("compaction_ready").parameters.required[0], "handoff");
});

test("below the threshold every boundary is a no-op", async () => {
	const { f } = await setup();
	f.setPercent(50);
	assert.deepEqual(await f.fire("turn_end", turnEnd()), [undefined]);
	assert.deepEqual(await f.fire("agent_before_settle", settle()), [undefined]);
	await f.fire("agent_settled", { aborted: false });
	assert.equal(f.compacts.length, 0);
});

test("full cycle at settle: preflight, handoff, then the compaction is a settle draft with no resume", async () => {
	const { f, api } = await setup();
	f.setPercent(75);
	// settle policy: a turn end with tool work only waits
	assert.deepEqual(await f.fire("turn_end", turnEnd(2)), [undefined]);
	const [result] = (await f.fire("agent_before_settle", settle())) as any[];
	assert.equal(result.continue, true);
	assert.equal(result.entries.length, 1);
	assert.equal(result.entries[0].type, "custom_message");
	assert.equal(result.entries[0].customType, "compactor-preflight");
	assert.equal(result.entries[0].display, false);
	assert.match(result.entries[0].content, /Context is at 75%/);
	assert.equal(api.cycle.state().phase, "preflight");

	const out = await f.tool("compaction_ready", { handoff: "Goal: ship T2" });
	assert.match(out.content[0].text, /Handoff saved/);
	assert.equal(api.cycle.state().phase, "compacting");
	const [compacted] = (await f.fire("agent_before_settle", settle("completed", session()))) as any[];
	assert.equal(compacted.entries.length, 1);
	assert.equal(compacted.entries[0].type, "compaction");
	assert.equal(compacted.entries[0].firstKeptEntryId, "u3");
	assert.match(compacted.entries[0].summary, /## Handoff\nGoal: ship T2/);
	assert.equal(compacted.continue, undefined, "the agent had finished: nothing to resume");
	assert.equal(api.cycle.state().phase, "idle");
	await f.fire("agent_settled", { aborted: false });
	assert.equal(f.compacts.length, 0, "Pi's fire-and-forget compaction is never used for the cycle");
	assert.deepEqual(f.sent, []);
	assert.equal(f.emitted.filter(([c]) => c === "compactor:done").length, 1);
});

test("a settle compaction keeps the drafts already at the boundary first", async () => {
	const { f } = await setup();
	await toCompacting(f);
	const draft = { type: "custom", customType: "other-ext", data: 1 };
	const [r] = (await f.fire("agent_before_settle", { ...settle("completed", session()), entries: [draft] })) as any[];
	assert.equal(r.entries[0], draft);
	assert.equal(r.entries[1].type, "compaction");
});

test("handoff-only at settle keeps nothing (firstKeptEntryId null) and never calls the LLM", async () => {
	const { f, api } = await setup();
	api.settings.store().update("global", "strategy", "handoff-only");
	await toCompacting(f, "Goal: ship T8");
	const [r] = (await f.fire("agent_before_settle", settle("completed", session()))) as any[];
	assert.equal(r.entries[0].firstKeptEntryId, null);
	assert.equal(f.completions.length, 0);
	assert.match(r.entries[0].summary, /## Handoff\nGoal: ship T8/);
	assert.equal(r.entries[0].details.compactor.strategy, "handoff-only");
	assert.equal(r.entries[0].details.compactor.reason, "threshold");
	assert.equal(r.entries[0].details.compactor.why, "handoff ready");
});

test("hybrid at settle summarizes the part before the cut and records the usage", async () => {
	const { f } = await setup();
	await toCompacting(f, "Goal: ship T8");
	const [r] = (await f.fire("agent_before_settle", settle("completed", session()))) as any[];
	const c = r.entries[0];
	assert.equal(c.firstKeptEntryId, "u3");
	assert.match(c.summary, /## Summary\nSUMMARY/);
	assert.deepEqual(c.usage, { input: 10, output: 5 });
	assert.equal(c.details.compactor.tokensBefore, 75_000, "Pi's own context measure, the one it stores in the entry");
	assert.equal((f.emitted.find(([ch]) => ch === "compactor:done")![1] as any).tokensBefore, 75_000);
});

test("tokensBefore falls back to the preparation estimate when Pi cannot measure the context", async () => {
	const { f } = await setup();
	await toCompacting(f);
	f.setPercent(null);
	const [r] = (await f.fire("agent_before_settle", settle("completed", session()))) as any[];
	assert.equal(r.entries[0].details.compactor.tokensBefore, 2500);
	assert.equal((f.emitted.find(([ch]) => ch === "compactor:done")![1] as any).tokensBefore, 2500);
	const prompt = f.completions[0].context.messages[0].content[0].text;
	assert.match(prompt, /\[user\] Build the parser/);
	assert.doesNotMatch(prompt, /add tests/, "the kept part is not summarized");
});

test("a session too small to cut fails the cycle with a notice and cools down", async () => {
	const { f, api } = await setup();
	await toCompacting(f);
	assert.deepEqual(await f.fire("agent_before_settle", settle("completed", { contextEntries: [] })), [undefined]);
	assert.deepEqual(f.notes.at(-1), ["compaction failed: Nothing to compact (session too small)", "error"]);
	assert.equal(api.cycle.state().phase, "cooldown");
	assert.equal(f.emitted.filter(([c]) => c === "compactor:done").length, 0);
});

test("a failing summary at settle fails the cycle instead of writing a compaction", async () => {
	const { f, api } = await setup();
	await toCompacting(f);
	f.setReply(new Error("boom"));
	assert.deepEqual(await f.fire("agent_before_settle", settle("completed", session())), [undefined]);
	assert.match(f.notes.at(-1)![0], /^compaction failed: /);
	assert.equal(api.cycle.state().phase, "cooldown");
});

test("an abort while the settle compaction is built writes nothing and drops the cycle", async () => {
	const { f, api } = await setup();
	await toCompacting(f);
	const abort = new AbortController();
	(f.ctx as any).signal = abort.signal;
	f.setReply(() => {
		abort.abort();
		return reply("SUMMARY");
	});
	assert.deepEqual(await f.fire("agent_before_settle", settle("completed", session())), [undefined]);
	assert.equal(api.cycle.state().phase, "idle");
	assert.equal(f.emitted.filter(([c]) => c === "compactor:done").length, 0);
});

test("preflight started between turns resumes the work after compaction", async () => {
	const { f, api } = await setup();
	api.settings.store().update("global", "safePoint", "turn");
	f.setPercent(75);
	const [r] = (await f.fire("turn_end", turnEnd(0))) as any[];
	assert.equal(r.continue, true);
	await f.tool("compaction_ready", { handoff: "Goal: X" });
	const [c] = (await f.fire("agent_before_settle", settle("completed", session()))) as any[];
	assert.deepEqual(c.entries.map((e: any) => e.type), ["compaction", "custom_message"]);
	assert.equal(c.entries[1].customType, "compactor-resume");
	assert.equal(c.entries[1].display, false);
	assert.equal(c.continue, true, "the run continues inside the same prompt");
	assert.deepEqual(f.sent, []);
	assert.equal(f.compacts.length, 0);
});

test("compaction_ready outside a preflight says so and changes nothing", async () => {
	const { f, api } = await setup();
	const out = await f.tool("compaction_ready", { handoff: "x" });
	assert.match(out.content[0].text, /No compaction is pending/);
	assert.equal(api.cycle.state().phase, "idle");
});

test("compaction_ready rejects an empty handoff", async () => {
	const { f, api } = await setup();
	f.setPercent(75);
	await f.fire("agent_before_settle", settle());
	const out = await f.tool("compaction_ready", { handoff: "   " });
	assert.match(out.content[0].text, /handoff must not be empty/);
	assert.equal(api.cycle.state().phase, "preflight");
});

test("a critical section from the agent or another extension defers, then the hard limit forces", async () => {
	const { f, api } = await setup();
	f.setPercent(75);
	await f.tool("compaction_defer", { active: true, reason: "migrating" });
	assert.deepEqual(await f.fire("agent_before_settle", settle()), [undefined]);
	await f.tool("compaction_defer", { active: false });
	f.emit("compactor:defer", { source: "other-ext", active: true });
	assert.deepEqual(await f.fire("agent_before_settle", settle()), [undefined]);
	assert.equal(api.cycle.state().phase, "pending");
	f.setPercent(91);
	const [r] = (await f.fire("turn_end", turnEnd(1))) as any[];
	assert.equal(r.continue, true);
	assert.equal(api.cycle.state().phase, "preflight");
});

test("preflight that runs out of turns compacts now, with resume", async () => {
	const { f } = await setup();
	f.setPercent(75);
	await f.fire("agent_before_settle", settle());
	assert.deepEqual(await f.fire("turn_end", turnEnd(1, "completed", session())), [undefined]);
	assert.deepEqual(await f.fire("turn_end", turnEnd(1, "completed", session())), [undefined]);
	const [c] = (await f.fire("turn_end", turnEnd(1, "completed", session()))) as any[];
	assert.deepEqual(c.entries.map((e: any) => e.customType ?? e.type), ["compaction", "compactor-resume"]);
	assert.equal(c.continue, true);
	assert.equal(f.compacts.length, 0);
});

test("a failed compaction notifies and cools down instead of looping", async () => {
	const { f, api } = await setup();
	await toCompacting(f);
	await f.fire("agent_before_settle", settle());
	assert.equal(api.cycle.state().phase, "cooldown");
	assert.deepEqual(f.notes.at(-1), ["compaction failed: Nothing to compact (session too small)", "error"]);
	assert.deepEqual(await f.fire("agent_before_settle", settle("completed", session())), [undefined]);
	assert.equal(f.compacts.length, 0);
});

test("/compactor now while idle still uses Pi's compaction; its failure cools down", async () => {
	const { f, api } = await setup();
	f.setPercent(75);
	api.settings.store().update("global", "preflight.enabled", false);
	api.cycle.request(f.ctx as never);
	assert.equal(f.compacts.length, 1);
	f.compacts[0].options.onError!(new Error("Nothing to compact"));
	assert.equal(api.cycle.state().phase, "cooldown");
	assert.deepEqual(f.notes.at(-1), ["compaction failed: Nothing to compact", "error"]);
});

test("an aborted run drops the preflight", async () => {
	const { f, api } = await setup();
	f.setPercent(75);
	await f.fire("agent_before_settle", settle());
	await f.fire("agent_settled", { aborted: true });
	assert.equal(api.cycle.state().phase, "idle");
	assert.equal(f.compacts.length, 0);
});

test("native threshold compaction is cancelled while we have headroom; overflow never is", async () => {
	const { f } = await setup();
	f.setPercent(85);
	assert.deepEqual(await f.fire("session_before_compact", { reason: "threshold", preparation: {}, branchEntries: [] }), [{ cancel: true }]);
	const [overflow] = (await f.fire("session_before_compact", compactEvent({ reason: "overflow" }))) as any[];
	assert.equal(overflow.cancel, undefined);
	assert.ok(overflow.compaction);
	f.setPercent(97);
	const [result] = (await f.fire("session_before_compact", compactEvent({ reason: "threshold" }))) as any[];
	assert.equal(result.cancel, undefined);
	assert.ok(result.compaction, "past the hard limit Pi's own threshold compaction is replaced by ours");
});

test("unknown usage (right after compaction) never arms", async () => {
	const { f, api } = await setup();
	f.setPercent(null);
	await f.fire("agent_before_settle", settle());
	assert.equal(api.cycle.state().phase, "idle");
});

/** Runs the cycle to the point where it asks Pi to compact, with the agent's handoff captured. */
async function toCompacting(f: ReturnType<typeof fakePi>, handoff = "Goal: ship T3") {
	f.setPercent(75);
	await f.fire("agent_before_settle", settle());
	await f.tool("compaction_ready", { handoff });
	assert.equal(f.compacts.length, 0);
}

test("hybrid is the default: summary of the old part, recent entries kept, files and pins appended", async () => {
	const { f } = await setup();
	const event = compactEvent();
	const [result] = (await f.fire("session_before_compact", event)) as any[];
	const c = result.compaction;
	assert.equal(c.firstKeptEntryId, "u3");
	assert.equal(c.tokensBefore, 80_000);
	assert.match(c.summary, /## Summary\nSUMMARY/);
	assert.match(c.summary, /Original request: Build the parser/);
	assert.match(c.summary, /<read-files>\na\.ts\n<\/read-files>/);
	assert.match(c.summary, /<modified-files>\nb\.ts\n<\/modified-files>/);
	assert.doesNotMatch(c.summary, /## Handoff/);
	assert.deepEqual(c.usage, { input: 10, output: 5 });
	assert.deepEqual(c.details.compactor, {
		strategy: "hybrid",
		handoff: false,
		pins: 2,
		readFiles: ["a.ts"],
		modifiedFiles: ["b.ts"],
		reason: "manual",
		tokensBefore: 80_000,
	});
	assert.equal(f.completions.length, 1);
	assert.equal(f.completions[0].options.signal, event.signal);
	const prompt = f.completions[0].context.messages[0].content[0].text;
	assert.match(prompt, /\[user\] Build the parser/);
	assert.match(prompt, /\[assistant\] done/);
	assert.doesNotMatch(prompt, /add tests/, "the kept part is not summarized");
});

test("the strategy follows the config", async () => {
	const { f, api } = await setup();
	api.settings.store().update("global", "strategy", "summary");
	const [result] = (await f.fire("session_before_compact", compactEvent())) as any[];
	assert.match(result.compaction.summary, /^SUMMARY/);
	assert.doesNotMatch(result.compaction.summary, /## Summary/);
	assert.equal(result.compaction.details.compactor.strategy, "summary");
	assert.equal(result.compaction.firstKeptEntryId, "u3");
});

test("a compaction the cycle asked for carries the handoff and records why", async () => {
	const { f } = await setup();
	await toCompacting(f, "Goal: ship T3");
	const [result] = (await f.fire("session_before_compact", compactEvent({ customInstructions: "Goal: ship T3" }))) as any[];
	const c = result.compaction;
	assert.match(c.summary, /## Handoff\nGoal: ship T3/);
	assert.match(c.summary, /## Summary\nSUMMARY/);
	assert.equal(c.details.compactor.handoff, true);
	assert.equal(c.details.compactor.reason, "threshold");
	assert.match(f.completions[0].context.messages[0].content[0].text, /do not repeat it:\nGoal: ship T3/);
});

test("handoff-only keeps nothing and never calls the LLM when the cycle has a handoff", async () => {
	const { f, api } = await setup();
	api.settings.store().update("global", "strategy", "handoff-only");
	await toCompacting(f, "Goal: ship T3");
	const [result] = (await f.fire("session_before_compact", compactEvent())) as any[];
	const c = result.compaction;
	assert.equal(c.firstKeptEntryId, null);
	assert.equal(f.completions.length, 0);
	assert.match(c.summary, /## Handoff\nGoal: ship T3/);
	assert.match(c.summary, /Original request: Build the parser/);
	assert.match(c.summary, /User: keep the old API/);
	assert.match(c.summary, /User: add tests/, "nothing is kept, so every user message is pinned");
	assert.equal(c.details.compactor.strategy, "handoff-only");
	assert.equal(c.details.compactor.fallback, undefined);
});

test("handoff-only contributions from other extensions are included", async () => {
	const { f, api } = await setup();
	api.settings.store().update("global", "strategy", "handoff-only");
	f.pi.events.on("compactor:collect", (payload: any) => payload.contribute({ source: "ext-a", handoff: "A state" }));
	f.setPercent(75);
	await f.fire("agent_before_settle", settle());
	await f.tool("compaction_ready", { handoff: "Goal" });
	await f.fire("agent_settled", { aborted: false });
	const [result] = (await f.fire("session_before_compact", compactEvent())) as any[];
	assert.match(result.compaction.summary, /## From ext-a\nA state/);
});

test("a compaction Pi started on its own gets no handoff: handoff-only falls back to hybrid and records it", async () => {
	const { f, api } = await setup();
	api.settings.store().update("global", "strategy", "handoff-only");
	const [result] = (await f.fire("session_before_compact", compactEvent({ reason: "manual" }))) as any[];
	const c = result.compaction;
	assert.equal(c.details.compactor.strategy, "hybrid");
	assert.equal(c.details.compactor.fallback, "handoff-only without a handoff");
	assert.equal(c.firstKeptEntryId, "u3");
	assert.equal(f.completions.length, 1);
});

test("a handoff is not used for a compaction that is not the cycle's own (overflow while compacting)", async () => {
	const { f, api } = await setup();
	api.settings.store().update("global", "strategy", "handoff-only");
	await toCompacting(f, "Goal: ship T3");
	const [result] = (await f.fire("session_before_compact", compactEvent({ reason: "overflow" }))) as any[];
	assert.doesNotMatch(result.compaction.summary, /Goal: ship T3/);
	assert.equal(result.compaction.details.compactor.fallback, "handoff-only without a handoff");
	assert.equal(result.compaction.details.compactor.reason, "overflow");
});

test("overflow is never cancelled, whatever the usage", async () => {
	const { f } = await setup();
	f.setPercent(50);
	const [r] = (await f.fire("session_before_compact", compactEvent({ reason: "overflow" }))) as any[];
	assert.equal(r.cancel, undefined);
	assert.ok(r.compaction);
});

test("manual pins from the session's custom entries are kept verbatim", async () => {
	const { f } = await setup();
	const entries = [
		...branch,
		{ type: "custom", id: "p1", customType: PIN_TYPE, data: { text: "Never push to main" } },
		{ type: "custom", id: "p2", customType: "other", data: { text: "ignored" } },
		{ type: "custom", id: "p3", customType: PIN_TYPE, data: { text: 42 } },
		{ type: "custom", id: "p4", customType: PIN_TYPE },
	];
	const [result] = (await f.fire("session_before_compact", compactEvent({ branchEntries: entries }))) as any[];
	assert.match(result.compaction.summary, /Pinned: Never push to main/);
	assert.doesNotMatch(result.compaction.summary, /ignored/);
	assert.equal(result.compaction.details.compactor.pins, 3);
	assert.equal(PIN_TYPE, "compactor-pin");
});

test("with the compactor disabled Pi compacts as usual", async () => {
	const { f, api } = await setup();
	api.settings.store().update("global", "enabled", false);
	assert.deepEqual(await f.fire("session_before_compact", compactEvent()), [undefined]);
	assert.equal(f.completions.length, 0);
});

test("a failing summary warns and falls back to Pi's default compaction", async () => {
	const { f } = await setup();
	f.setReply(new Error("network down"));
	assert.deepEqual(await f.fire("session_before_compact", compactEvent()), [undefined]);
	assert.deepEqual(f.notes.at(-1), ["compaction failed, using Pi's default: network down", "warning"]);
});

test("a summary cut by length falls back to Pi's default compaction", async () => {
	const { f } = await setup();
	f.setReply(reply("partial", { stopReason: "length" }));
	assert.deepEqual(await f.fire("session_before_compact", compactEvent()), [undefined]);
	assert.match(f.notes.at(-1)![0], /summary length/);
});

test("without a UI the fallback notice goes to stderr", async () => {
	const { f } = await setup({ hasUI: false });
	f.setReply(new Error("boom"));
	assert.deepEqual(await f.fire("session_before_compact", compactEvent()), [undefined]);
	assert.deepEqual(f.stderr, ["[compactor] compaction failed, using Pi's default: boom\n"]);
});

test("summary strategy without any model falls back to Pi's default compaction", async () => {
	const { f } = await setup({ model: undefined });
	assert.deepEqual(await f.fire("session_before_compact", compactEvent()), [undefined]);
	assert.match(f.notes.at(-1)![0], /no model/i);
});

test("handoff-only with a handoff needs no model at all", async () => {
	const { f, api } = await setup({ model: undefined });
	api.settings.store().update("global", "strategy", "handoff-only");
	await toCompacting(f, "Goal");
	const [result] = (await f.fire("session_before_compact", compactEvent())) as any[];
	assert.equal(result.compaction.firstKeptEntryId, null);
});

test("summaryModel selects the model through the registry", async () => {
	const { f, api } = await setup();
	const flash = { provider: "google", id: "flash" };
	f.registry.set("google/flash", flash);
	api.settings.store().update("global", "summaryModel", "google/flash");
	await f.fire("session_before_compact", compactEvent());
	assert.equal(f.completions[0].model, flash);
});

test("an unknown summaryModel warns and uses the session model", async () => {
	const { f, api } = await setup();
	api.settings.store().update("global", "summaryModel", "google/missing");
	const [result] = (await f.fire("session_before_compact", compactEvent())) as any[];
	assert.ok(result.compaction);
	assert.equal(f.completions[0].model, f.ctx.model);
	assert.match(f.notes.at(-1)![0], /google\/missing/);
});

test("the done event carries the compactor details of the compaction", async () => {
	const { f } = await setup();
	await toCompacting(f, "Goal: ship T3");
	const [result] = (await f.fire("agent_before_settle", settle("completed", session()))) as any[];
	const done = f.emitted.filter(([c]) => c === "compactor:done");
	assert.equal(done.length, 1);
	const payload = done[0][1] as any;
	assert.deepEqual(payload.compactor, result.entries[0].details.compactor);
	assert.equal(payload.handoff, true);
	assert.equal(payload.strategy, "hybrid");
});

test("the preflight is appended to the drafts already at the boundary, never replacing them", async () => {
	const { f } = await setup();
	f.setPercent(75);
	const draft = { type: "custom", customType: "other-ext", data: { n: 1 } };
	const [settled] = (await f.fire("agent_before_settle", { ...settle(), entries: [draft] })) as any[];
	assert.equal(settled.entries.length, 2);
	assert.equal(settled.entries[0], draft);
	assert.equal(settled.entries[1].customType, "compactor-preflight");
	assert.equal(settled.continue, true);

	const turn = await setup();
	turn.api.settings.store().update("global", "safePoint", "turn");
	turn.f.setPercent(75);
	const [r] = (await turn.f.fire("turn_end", { ...turnEnd(0), entries: [draft] })) as any[];
	assert.deepEqual(r.entries.map((e: any) => e.customType), ["other-ext", "compactor-preflight"]);
});

// Pruning: old large tool outputs are pruned first when the soft threshold is crossed.
const big = "x".repeat(40_000); // ~10k tokens
const projected = (entry: any) => ({ sourceEntry: entry, messages: entry.type === "message" ? [entry.message] : [] });
function prunableContext() {
	const e = [
		{ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "go" }] } },
		{ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] } },
		{ type: "message", id: "t1", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: big }] } },
		...[2, 3, 4, 5].map((n) => ({ type: "message", id: `u${n}`, message: { role: "user", content: [{ type: "text", text: `turn ${n}` }] } })),
	];
	return { contextEntries: e.map(projected) };
}

test("pruning alone brings usage under the soft threshold: edits are returned and no cycle starts", async () => {
	const { f, api } = await setup();
	f.setPercent(72); // 72k tokens; pruning saves ~10k -> 62%
	const prior = { type: "custom", customType: "other", data: 1 };
	const [r] = (await f.fire("turn_end", { ...turnEnd(1), entries: [prior], context: prunableContext() })) as any[];
	assert.equal(r.entries[0], prior);
	assert.equal(r.entries.length, 2);
	assert.equal(r.entries[1].type, "context_edit");
	assert.equal(r.entries[1].targetId, "t1");
	assert.equal(r.continue, undefined);
	assert.equal(api.cycle.state().phase, "idle");
});

test("when pruning is not enough the preflight comes with the edits", async () => {
	const { f, api } = await setup();
	f.setPercent(85);
	const [r] = (await f.fire("agent_before_settle", { ...settle(), context: prunableContext() })) as any[];
	assert.deepEqual(r.entries.map((e: any) => e.type), ["context_edit", "custom_message"]);
	assert.equal(r.continue, true);
	assert.equal(api.cycle.state().phase, "preflight");
});

test("pruning disabled or below the threshold returns no edits", async () => {
	const { f, api } = await setup();
	f.setPercent(50);
	assert.deepEqual(await f.fire("turn_end", { ...turnEnd(1), context: prunableContext() }), [undefined]);
	api.settings.store().update("global", "pruning.enabled", false);
	f.setPercent(72);
	assert.deepEqual(await f.fire("turn_end", { ...turnEnd(1), context: prunableContext() }), [undefined]);
	assert.equal(api.cycle.state().phase, "pending");
});
