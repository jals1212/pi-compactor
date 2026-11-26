import assert from "node:assert/strict";
import { test } from "node:test";
import { registerCompactor } from "../src/wire.ts";
import { fakePi } from "./helpers.ts";

const turnEnd = (toolResults = 0, outcome = "completed") => ({ outcome, toolResults: Array.from({ length: toolResults }, () => ({})), entries: [], continue: false });
const settle = (outcome = "completed") => ({ outcome, entries: [], continue: false });

async function setup(options: Parameters<typeof fakePi>[0] = {}) {
	const f = fakePi(options);
	const api = registerCompactor(f.pi, { agentDir: f.agentDir, stderr: (t) => void f.stderr.push(t) });
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

test("full cycle at settle: preflight, handoff, compact when idle, no resume", async () => {
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
	assert.deepEqual(await f.fire("agent_before_settle", settle()), [undefined]);
	assert.equal(f.compacts.length, 0, "never compacts before the agent is idle");
	await f.fire("agent_settled", { aborted: false });
	assert.equal(f.compacts.length, 1);
	f.compacts[0].options.onComplete!({});
	assert.equal(api.cycle.state().phase, "idle");
	assert.deepEqual(f.sent, []);
	assert.equal(f.emitted.filter(([c]) => c === "compactor:done").length, 1);
});

test("preflight started between turns resumes the work after compaction", async () => {
	const { f, api } = await setup();
	api.settings.store().update("global", "safePoint", "turn");
	f.setPercent(75);
	const [r] = (await f.fire("turn_end", turnEnd(0))) as any[];
	assert.equal(r.continue, true);
	await f.tool("compaction_ready", { handoff: "Goal: X" });
	await f.fire("agent_settled", { aborted: false });
	f.compacts[0].options.onComplete!({});
	assert.equal(f.sent.length, 1);
	assert.equal(f.sent[0][0].customType, "compactor-resume");
	assert.equal(f.sent[0][0].display, false);
	assert.deepEqual(f.sent[0][1], { triggerTurn: true, deliverAs: "followUp" });
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
	await f.fire("turn_end", turnEnd(1));
	await f.fire("turn_end", turnEnd(1));
	assert.equal(f.compacts.length, 0);
	await f.fire("turn_end", turnEnd(1));
	assert.equal(f.compacts.length, 1);
	f.compacts[0].options.onComplete!({});
	assert.equal(f.sent[0][0].customType, "compactor-resume");
});

test("a failed compaction notifies and cools down instead of looping", async () => {
	const { f, api } = await setup();
	f.setPercent(75);
	await f.fire("agent_before_settle", settle());
	await f.tool("compaction_ready", { handoff: "h" });
	await f.fire("agent_settled", { aborted: false });
	f.compacts[0].options.onError!(new Error("Nothing to compact"));
	assert.equal(api.cycle.state().phase, "cooldown");
	assert.deepEqual(f.notes.at(-1), ["compaction failed: Nothing to compact", "error"]);
	assert.deepEqual(await f.fire("agent_before_settle", settle()), [undefined]);
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
	assert.deepEqual(await f.fire("session_before_compact", { reason: "overflow", preparation: {}, branchEntries: [] }), [undefined]);
	f.setPercent(97);
	assert.deepEqual(await f.fire("session_before_compact", { reason: "threshold", preparation: {}, branchEntries: [] }), [undefined]);
});

test("unknown usage (right after compaction) never arms", async () => {
	const { f, api } = await setup();
	f.setPercent(null);
	await f.fire("agent_before_settle", settle());
	assert.equal(api.cycle.state().phase, "idle");
});
