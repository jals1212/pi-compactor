import assert from "node:assert/strict";
import { test } from "node:test";
import { registerCompactor } from "../src/wire.ts";
import { statusText } from "../src/status.ts";
import { bigSession, fakePi, pick } from "./helpers.ts";

const turnEnd = (toolResults = 0, outcome = "completed") => ({ outcome, toolResults: Array.from({ length: toolResults }, () => ({})), entries: [], continue: false });
const settle = (outcome = "completed", context?: unknown) => ({ outcome, entries: [], continue: false, context });

async function setup(options: Parameters<typeof fakePi>[0] = {}) {
	const f = fakePi(options);
	const api = registerCompactor(f.pi, { agentDir: f.agentDir, stderr: (t) => void f.stderr.push(t) });
	await f.fire("session_start", { reason: "startup" });
	return { f, api };
}

const last = (f: ReturnType<typeof fakePi>) => f.statuses.at(-1);

test("idle shows the distance to our soft threshold, set when the session starts", async () => {
	const { f } = await setup();
	// usage 10% of 100k; softThreshold 70% -> 60k tokens left
	assert.deepEqual(f.statuses, [["compactor", "🗜️ 60k to compact"]]);
});

test("idle distance follows usage at every boundary and is set only when the text changes", async () => {
	const { f } = await setup();
	f.setPercent(50);
	await f.fire("turn_end", turnEnd());
	await f.fire("agent_before_settle", settle());
	assert.deepEqual(last(f), ["compactor", "🗜️ 20k to compact"]);
	f.setPercent(69.5);
	await f.fire("turn_end", turnEnd());
	assert.deepEqual(last(f), ["compactor", "🗜️ 500 to compact"]);
	await f.fire("agent_before_settle", settle());
	assert.deepEqual(
		f.statuses.map(([, t]) => t),
		["🗜️ 60k to compact", "🗜️ 20k to compact", "🗜️ 500 to compact"],
	);
});

test("distance formatting: plain below 1000, rounded thousands, millions with one decimal", () => {
	const contextWindow = 4_000_000;
	const idle = (distance: number) => statusText({ phase: "idle", enabled: true, softThreshold: 50, usage: { tokens: contextWindow / 2 - distance, percent: 0, contextWindow } });
	assert.equal(idle(999), "🗜️ 999 to compact");
	assert.equal(idle(1000), "🗜️ 1k to compact");
	assert.equal(idle(620_400), "🗜️ 620k to compact");
	assert.equal(idle(620_600), "🗜️ 621k to compact");
	assert.equal(idle(999_600), "🗜️ 1M to compact");
	assert.equal(idle(1_200_000), "🗜️ 1.2M to compact");
});

test("at or past the threshold while idle the status shows the usage as due", async () => {
	const { f } = await setup();
	f.setPercent(80);
	await f.fire("session_start", { reason: "resume" });
	assert.deepEqual(last(f), ["compactor", "🗜️ due 80%"]);
});

test("unknown usage shows the bare name, with no stale numbers", async () => {
	const { f } = await setup();
	assert.equal(last(f)![1], "🗜️ 60k to compact");
	f.setPercent(null);
	await f.fire("session_compact", { reason: "manual" });
	assert.deepEqual(last(f), ["compactor", "🗜️"]);
	f.setPercent(30);
	await f.fire("turn_end", turnEnd());
	assert.deepEqual(last(f), ["compactor", "🗜️ 40k to compact"]);
});

test("disabled automatic compaction shows off, including /compactor off and on", async () => {
	const { f } = await setup();
	await f.command("off");
	assert.deepEqual(last(f), ["compactor", "🗜️ off"]);
	f.setPercent(90);
	await f.fire("turn_end", turnEnd());
	assert.deepEqual(last(f), ["compactor", "🗜️ off"]);
	await f.command("on");
	assert.deepEqual(last(f), ["compactor", "🗜️ due 90%"]);
});

test("a disabled config on disk shows off from the session start", async () => {
	const f = fakePi();
	const api = registerCompactor(f.pi, { agentDir: f.agentDir, stderr: (t) => void f.stderr.push(t) });
	api.settings.store().update("global", "enabled", false);
	await f.fire("session_start", { reason: "startup" });
	assert.deepEqual(f.statuses, [["compactor", "🗜️ off"]]);
});

test("a model change recomputes the distance with that model's effective threshold", async () => {
	const { f, api } = await setup();
	api.settings.store().update("global", "softThreshold", 50, "openai/gpt");
	await f.fire("model_select", { model: { provider: "openai", id: "gpt" } });
	assert.deepEqual(last(f), ["compactor", "🗜️ 40k to compact"]);
	await f.fire("model_select", { model: { provider: "anthropic", id: "opus" } });
	assert.deepEqual(last(f), ["compactor", "🗜️ 60k to compact"]);
});

test("changing a setting in /compactor settings updates the distance", async () => {
	const { f } = await setup();
	f.answers(pick("project"), pick("softThreshold"), pick("Edit"), "60", undefined);
	await f.command("settings");
	assert.deepEqual(last(f), ["compactor", "🗜️ 50k to compact"]);
});

test("the status follows the phase with the usage percent, and returns to the idle text after compaction", async () => {
	const { f, api } = await setup();
	api.settings.store().update("global", "strategy", "handoff-only");
	f.setPercent(75);
	await f.fire("turn_end", turnEnd(2));
	assert.deepEqual(f.statuses.at(-1), ["compactor", "🗜️ pending 75%"]);
	await f.fire("agent_before_settle", settle());
	assert.deepEqual(f.statuses.at(-1), ["compactor", "🗜️ preflight 75%"]);
	await f.tool("compaction_ready", { handoff: "Goal: x" });
	assert.deepEqual(f.statuses.at(-1), ["compactor", "🗜️ compacting 75%"]);
	f.setPercent(null); // Pi reports no usage right after a compaction
	await f.fire("agent_before_settle", settle("completed", bigSession()));
	assert.deepEqual(f.statuses.at(-1), ["compactor", "🗜️"]);
	assert.deepEqual(
		f.statuses.map(([, t]) => t),
		["🗜️ 60k to compact", "🗜️ pending 75%", "🗜️ preflight 75%", "🗜️ compacting 75%", "🗜️"],
		"each change is reported once",
	);
});

test("a failed compaction shows the cooldown", async () => {
	const { f } = await setup();
	f.setPercent(75);
	await f.fire("agent_before_settle", settle());
	await f.tool("compaction_ready", { handoff: "Goal: x" });
	await f.fire("agent_before_settle", settle("completed", { contextEntries: [] }));
	assert.deepEqual(f.statuses.at(-1), ["compactor", "🗜️ cooldown 75%"]);
});

test("an aborted turn drops the pending cycle and returns to the idle text", async () => {
	const { f } = await setup();
	f.setPercent(75);
	await f.fire("turn_end", turnEnd(2));
	assert.equal(f.statuses.at(-1)![1], "🗜️ pending 75%");
	await f.fire("turn_end", turnEnd(0, "aborted"));
	assert.deepEqual(f.statuses.at(-1), ["compactor", "🗜️ due 75%"]);
});

test("/compactor now shows the phase it starts", async () => {
	const { f } = await setup();
	f.setPercent(75);
	await f.command("now");
	assert.deepEqual(f.statuses.at(-1), ["compactor", "🗜️ preflight 75%"]);
});

test("without a UI the status is never set", async () => {
	const { f } = await setup({ hasUI: false });
	f.setPercent(75);
	await f.fire("agent_before_settle", settle());
	assert.deepEqual(f.statuses, []);
});

test("the brand is the 🗜 emoji with emoji presentation (U+FE0F), two cells wide like 🪐", async () => {
	const { BRAND } = await import("../src/status.ts");
	assert.deepEqual([...BRAND].map((c) => c.codePointAt(0)!.toString(16)), ["1f5dc", "fe0f"]);
});
