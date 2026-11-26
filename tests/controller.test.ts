import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, type CompactorConfig } from "../src/config.ts";
import { createController } from "../src/controller.ts";

const W = 100_000;
const cfg = (over: Partial<CompactorConfig> = {}): CompactorConfig => ({ ...DEFAULTS, ...over, preflight: { ...DEFAULTS.preflight, ...(over.preflight ?? {}) } });
const usage = (percent: number) => ({ percent, tokens: (percent / 100) * W, contextWindow: W });

test("below the soft threshold nothing happens", () => {
	const c = createController();
	c.observe(usage(69), cfg());
	assert.equal(c.state().phase, "idle");
	assert.deepEqual(c.atBoundary("settle", usage(69), cfg(), { criticalSections: 0 }), { action: "none" });
});

test("crossing the soft threshold waits for the configured safe point", () => {
	const c = createController();
	c.observe(usage(71), cfg());
	assert.equal(c.state().phase, "pending");
	// settle policy: a turn boundary is not safe
	assert.deepEqual(c.atBoundary("turn", usage(72), cfg(), { criticalSections: 0 }), { action: "wait", why: "safe-point" });
	assert.deepEqual(c.atBoundary("settle", usage(72), cfg(), { criticalSections: 0 }), { action: "preflight" });
	assert.equal(c.state().phase, "preflight");
});

test("turn policy accepts a turn boundary without pending tool work; any accepts all", () => {
	const turn = createController();
	turn.observe(usage(71), cfg({ safePoint: "turn" }));
	assert.deepEqual(turn.atBoundary("turn", usage(71), cfg({ safePoint: "turn" }), { criticalSections: 0, pendingTools: true }), { action: "wait", why: "safe-point" });
	assert.deepEqual(turn.atBoundary("turn", usage(71), cfg({ safePoint: "turn" }), { criticalSections: 0 }), { action: "preflight" });
	const any = createController();
	any.observe(usage(71), cfg({ safePoint: "any" }));
	assert.deepEqual(any.atBoundary("turn", usage(71), cfg({ safePoint: "any" }), { criticalSections: 0, pendingTools: true }), { action: "preflight" });
});

test("disabled preflight compacts directly at the safe point", () => {
	const c = createController();
	const config = cfg({ preflight: { ...DEFAULTS.preflight, enabled: false } });
	c.observe(usage(71), config);
	assert.deepEqual(c.atBoundary("settle", usage(71), config, { criticalSections: 0 }), { action: "compact", why: "threshold" });
	assert.equal(c.state().phase, "compacting");
});

test("critical sections defer until headroom runs out, then force", () => {
	const c = createController();
	c.observe(usage(71), cfg());
	assert.deepEqual(c.atBoundary("settle", usage(75), cfg(), { criticalSections: 1 }), { action: "wait", why: "critical-section" });
	// 71% -> 91% grows 20k tokens = maxDeferTokens
	assert.deepEqual(c.atBoundary("turn", usage(91), cfg(), { criticalSections: 1, pendingTools: true }), { action: "preflight", forced: true });
});

test("reaching the hard threshold forces even at an unsafe point", () => {
	const c = createController();
	c.observe(usage(71), cfg({ maxDeferTokens: 1_000_000 }));
	assert.deepEqual(c.atBoundary("turn", usage(90), cfg({ maxDeferTokens: 1_000_000 }), { criticalSections: 0, pendingTools: true }), { action: "preflight", forced: true });
});

test("preflight ends when the agent hands off", () => {
	const c = createController();
	c.observe(usage(71), cfg());
	c.atBoundary("settle", usage(71), cfg(), { criticalSections: 0 });
	assert.deepEqual(c.ready("goal: X"), { action: "compact", why: "handoff" });
	assert.equal(c.state().handoff, "goal: X");
	assert.equal(c.state().phase, "compacting");
	assert.deepEqual(c.ready("again"), { action: "none" });
});

test("preflight times out by turns or token budget and compacts without handoff", () => {
	const turns = createController();
	turns.observe(usage(71), cfg());
	turns.atBoundary("settle", usage(71), cfg(), { criticalSections: 0 });
	assert.deepEqual(turns.atBoundary("turn", usage(72), cfg(), { criticalSections: 0 }), { action: "none" });
	assert.deepEqual(turns.atBoundary("turn", usage(72), cfg(), { criticalSections: 0 }), { action: "none" });
	assert.deepEqual(turns.atBoundary("turn", usage(72), cfg(), { criticalSections: 0 }), { action: "compact", why: "preflight-turns" });
	assert.equal(turns.state().handoff, undefined);
	const budget = createController();
	budget.observe(usage(71), cfg());
	budget.atBoundary("settle", usage(71), cfg(), { criticalSections: 0 });
	assert.deepEqual(budget.atBoundary("turn", usage(79), cfg(), { criticalSections: 0 }), { action: "compact", why: "preflight-budget" });
});

test("preflight settling without handoff compacts at once", () => {
	const c = createController();
	c.observe(usage(71), cfg());
	c.atBoundary("settle", usage(71), cfg(), { criticalSections: 0 });
	assert.deepEqual(c.atBoundary("settle", usage(72), cfg(), { criticalSections: 0 }), { action: "compact", why: "preflight-settled" });
});

test("after compaction the cycle restarts; a failure cools down until the context grows", () => {
	const c = createController();
	c.observe(usage(71), cfg());
	c.atBoundary("settle", usage(71), cfg(), { criticalSections: 0 });
	c.ready("h");
	c.compacted();
	assert.equal(c.state().phase, "idle");
	c.observe(usage(71), cfg());
	c.atBoundary("settle", usage(71), cfg(), { criticalSections: 0 });
	c.ready("h");
	c.failed(usage(71));
	assert.equal(c.state().phase, "cooldown");
	c.observe(usage(80), cfg());
	assert.equal(c.state().phase, "cooldown");
	c.observe(usage(92), cfg());
	assert.equal(c.state().phase, "pending");
});

test("disabled config never arms, manual request always does", () => {
	const c = createController();
	const off = cfg({ enabled: false });
	c.observe(usage(95), off);
	assert.equal(c.state().phase, "idle");
	assert.deepEqual(c.request(usage(30), off), { action: "preflight" });
	assert.equal(c.state().reason, "manual");
	const skip = createController();
	assert.deepEqual(skip.request(usage(30), cfg({ preflight: { ...DEFAULTS.preflight, enabled: false } })), { action: "compact", why: "manual" });
});

test("native compaction: overflow always proceeds, threshold is cancelled only while headroom remains", () => {
	const c = createController();
	assert.equal(c.nativeCompaction("overflow", usage(99), cfg()), "allow");
	assert.equal(c.nativeCompaction("threshold", usage(85), cfg()), "cancel");
	assert.equal(c.nativeCompaction("threshold", usage(96), cfg()), "allow");
	assert.equal(c.nativeCompaction("threshold", usage(85), cfg({ enabled: false })), "allow");
	assert.equal(c.nativeCompaction("manual", usage(20), cfg()), "allow");
});

test("abort drops a running preflight back to idle", () => {
	const c = createController();
	c.observe(usage(71), cfg());
	c.atBoundary("settle", usage(71), cfg(), { criticalSections: 0 });
	c.abort();
	assert.equal(c.state().phase, "idle");
	assert.deepEqual(c.ready("late"), { action: "none" });
});
