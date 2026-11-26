import assert from "node:assert/strict";
import { test } from "node:test";
import { registerCompactor } from "../src/wire.ts";
import { bigSession, fakePi } from "./helpers.ts";

const turnEnd = (toolResults = 0, outcome = "completed") => ({ outcome, toolResults: Array.from({ length: toolResults }, () => ({})), entries: [], continue: false });
const settle = (outcome = "completed", context?: unknown) => ({ outcome, entries: [], continue: false, context });

async function setup(options: Parameters<typeof fakePi>[0] = {}) {
	const f = fakePi(options);
	const api = registerCompactor(f.pi, { agentDir: f.agentDir, stderr: (t) => void f.stderr.push(t) });
	await f.fire("session_start", { reason: "startup" });
	return { f, api };
}

test("nothing is shown while the cycle is idle", async () => {
	const { f } = await setup();
	f.setPercent(50);
	await f.fire("turn_end", turnEnd());
	await f.fire("agent_before_settle", settle());
	assert.deepEqual(f.statuses, []);
});

test("the status follows the phase with the usage percent, and clears when idle again", async () => {
	const { f, api } = await setup();
	api.settings.store().update("global", "strategy", "handoff-only");
	f.setPercent(75);
	await f.fire("turn_end", turnEnd(2));
	assert.deepEqual(f.statuses.at(-1), ["compactor", "compactor: pending 75%"]);
	await f.fire("agent_before_settle", settle());
	assert.deepEqual(f.statuses.at(-1), ["compactor", "compactor: preflight 75%"]);
	await f.tool("compaction_ready", { handoff: "Goal: x" });
	assert.deepEqual(f.statuses.at(-1), ["compactor", "compactor: compacting 75%"]);
	await f.fire("agent_before_settle", settle("completed", bigSession()));
	assert.deepEqual(f.statuses.at(-1), ["compactor", undefined]);
	assert.deepEqual(
		f.statuses.map(([, t]) => t),
		["compactor: pending 75%", "compactor: preflight 75%", "compactor: compacting 75%", undefined],
		"each change is reported once",
	);
});

test("a failed compaction shows the cooldown", async () => {
	const { f } = await setup();
	f.setPercent(75);
	await f.fire("agent_before_settle", settle());
	await f.tool("compaction_ready", { handoff: "Goal: x" });
	await f.fire("agent_before_settle", settle("completed", { contextEntries: [] }));
	assert.deepEqual(f.statuses.at(-1), ["compactor", "compactor: cooldown 75%"]);
});

test("an aborted turn drops the pending cycle and clears the status", async () => {
	const { f } = await setup();
	f.setPercent(75);
	await f.fire("turn_end", turnEnd(2));
	assert.equal(f.statuses.at(-1)![1], "compactor: pending 75%");
	await f.fire("turn_end", turnEnd(0, "aborted"));
	assert.deepEqual(f.statuses.at(-1), ["compactor", undefined]);
});

test("/compactor now shows the phase it starts", async () => {
	const { f } = await setup();
	f.setPercent(75);
	await f.command("now");
	assert.deepEqual(f.statuses.at(-1), ["compactor", "compactor: preflight 75%"]);
});

test("without a UI the status is never set", async () => {
	const { f } = await setup({ hasUI: false });
	f.setPercent(75);
	await f.fire("agent_before_settle", settle());
	assert.deepEqual(f.statuses, []);
});
