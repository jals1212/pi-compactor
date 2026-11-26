import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { PIN_TYPE } from "../src/cycle.ts";
import { registerCompactor } from "../src/wire.ts";
import { bigSession, fakePi } from "./helpers.ts";

const settle = (outcome = "completed", context?: unknown) => ({ outcome, entries: [], continue: false, context });
const SUBCOMMANDS = ["status", "now", "off", "on", "plan", "pin", "unpin", "settings"];

async function setup(options: Parameters<typeof fakePi>[0] = {}) {
	const f = fakePi(options);
	const api = registerCompactor(f.pi, { agentDir: f.agentDir, stderr: (t) => void f.stderr.push(t) });
	await f.fire("session_start", { reason: "startup" });
	return { f, api };
}
const last = (f: { notes: [string, string | undefined][] }) => f.notes.at(-1)!;

test("registers /compactor with a description and subcommand completions", async () => {
	const { f } = await setup();
	const command = f.commands.get("compactor");
	assert.match(command.description, /status.*now.*off.*on.*plan.*pin.*settings/s);
	assert.deepEqual(command.getArgumentCompletions("").map((i: any) => i.value), SUBCOMMANDS);
	assert.deepEqual(command.getArgumentCompletions("s").map((i: any) => i.value), ["status", "settings"]);
	assert.equal(command.getArgumentCompletions("status x"), null);
});

test("status is the default and reports phase, usage, thresholds, strategy, safe point and sections", async () => {
	const { f } = await setup();
	await f.command();
	const [text, type] = last(f);
	assert.equal(type, "info");
	for (const line of [
		"phase: idle",
		"usage: 10% (10000 of 100000 tokens)",
		"thresholds: soft 70% · hard 90% · defer up to 20000 tokens",
		"strategy: hybrid",
		"safe point: settle",
		"automatic compaction: on",
		"critical sections: none",
		"last compaction: none",
	])
		assert.ok(text.includes(line), `${line}\n---\n${text}`);
	assert.ok(!text.includes("warnings"));
	await f.command("status");
	assert.equal(last(f)[0], text);
});

test("status lists critical sections and settings warnings", async () => {
	const { f, api } = await setup();
	f.emit("compactor:defer", { source: "deploy", active: true, reason: "migrating" });
	api.settings.store().update("global", "softThreshold", 95);
	api.settings.store().update("global", "hardThreshold", 90);
	f.setPercent(null);
	await f.command("status");
	const text = last(f)[0];
	assert.ok(text.includes("critical sections: deploy (migrating)"), text);
	assert.ok(text.includes("usage: unknown"), text);
	assert.ok(text.includes("thresholds: soft 85% · hard 90%"), text);
	assert.ok(text.includes("settings warnings:\n- softThreshold 95 is not below hardThreshold 90; using 85"), text);
});

test("status reports the last compaction from compactor:done", async () => {
	const { f, api } = await setup();
	api.settings.store().update("global", "strategy", "handoff-only");
	f.setPercent(75);
	await f.fire("agent_before_settle", settle());
	await f.tool("compaction_ready", { handoff: "Goal: x" });
	await f.fire("agent_before_settle", settle("completed", bigSession()));
	await f.command("status");
	const text = last(f)[0];
	assert.ok(text.includes("phase: idle"), text);
	assert.ok(text.includes("last compaction: threshold (handoff ready) · strategy handoff-only · fallback: none · 75000 tokens before · 0 pins · handoff yes"), text);
	// A fallback recorded by any compaction is shown too.
	f.emit("compactor:done", { reason: "manual", compactor: { strategy: "hybrid", fallback: "handoff-only without a handoff", handoff: false, pins: 2, readFiles: [], modifiedFiles: [] }, tokensBefore: 5 });
	await f.command("status");
	assert.ok(last(f)[0].includes("fallback: handoff-only without a handoff"), last(f)[0]);
	assert.equal(api.cycle.state().phase, "idle");
});

test("now requests a compaction through the cycle", async () => {
	const { f, api } = await setup();
	f.setPercent(75);
	await f.command("now");
	assert.equal(api.cycle.state().phase, "preflight");
	assert.equal(f.sent.length, 1);
	assert.equal(f.sent[0][0].customType, "compactor-preflight");
	assert.match(last(f)[0], /preflight started/);
});

test("now compacts directly when preflight is off", async () => {
	const { f, api } = await setup();
	api.settings.store().update("project", "preflight.enabled", false);
	await f.command("now");
	assert.equal(f.compacts.length, 1);
	assert.match(last(f)[0], /compacting/);
});

test("now while a cycle runs does not start another", async () => {
	const { f } = await setup();
	f.setPercent(75);
	await f.command("now");
	await f.command("now");
	assert.equal(f.sent.length, 1);
	assert.match(last(f)[0], /already running \(preflight\)/);
});

test("off and on write enabled in the project file and say which one", async () => {
	const { f, api } = await setup();
	const path = api.settings.store().paths.project;
	await f.command("off");
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { enabled: false });
	assert.equal(api.settings.current().enabled, false);
	assert.deepEqual(last(f), [`automatic compaction off (project: ${path})`, "info"]);
	await f.command("on");
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { enabled: true });
	assert.equal(api.settings.current().enabled, true);
	assert.deepEqual(last(f), [`automatic compaction on (project: ${path})`, "info"]);
	assert.equal(existsSync(api.settings.store().paths.global), false);
});

test("off reports a write failure and changes nothing", async () => {
	const { f, api } = await setup();
	const path = api.settings.store().paths.project;
	api.settings.store().update("project", "strategy", "summary");
	writeFileSync(path, "[1]");
	await f.command("off");
	assert.equal(last(f)[1], "error");
	assert.match(last(f)[0], /cannot update .*not a JSON object/);
	assert.equal(readFileSync(path, "utf8"), "[1]");
});

test("plan describes the next compaction without doing it", async () => {
	const { f, api } = await setup();
	f.setPercent(75);
	await f.command("plan");
	const text = last(f)[0];
	for (const line of [
		"starts when the context reaches 70%",
		"forced at 90% or after 20000 tokens of growth",
		"safe point: settle",
		"preflight: on (up to 3 turns, 8000 tokens; built-in template)",
		"strategy: hybrid",
		"pruning: on (tool results over 2000 tokens, keeping the last 3 turns)",
		"summary model: session model",
	])
		assert.ok(text.includes(line), `${line}\n---\n${text}`);
	assert.equal(f.compacts.length, 0);
	assert.deepEqual(f.sent, []);
	assert.equal(api.cycle.state().phase, "idle");
});

test("plan reflects the configuration", async () => {
	const { f, api } = await setup();
	const s = api.settings.store();
	s.update("project", "preflight.enabled", false);
	s.update("project", "pruning.enabled", false);
	s.update("project", "strategy", "handoff-only");
	s.update("project", "safePoint", "any");
	s.update("project", "summaryModel", "openai/gpt");
	s.update("project", "enabled", false);
	await f.command("plan");
	const text = last(f)[0];
	for (const line of [
		"automatic compaction is off; only /compactor now compacts",
		"preflight: off (compacts without asking for a handoff)",
		"strategy: handoff-only",
		"pruning: off",
		"safe point: any",
		"summary model: openai/gpt",
	])
		assert.ok(text.includes(line), `${line}\n---\n${text}`);
});

test("pin appends a session entry and pin alone lists the pins", async () => {
	const { f } = await setup();
	await f.command("pin");
	assert.match(last(f)[0], /No pins/);
	await f.command("pin  keep the v2 API  ");
	assert.deepEqual(f.appended, [[PIN_TYPE, { text: "keep the v2 API" }]]);
	assert.match(last(f)[0], /Pinned: keep the v2 API/);
	await f.command("pin never touch prod");
	await f.command("pin");
	assert.ok(last(f)[0].includes("1. keep the v2 API\n2. never touch prod"), last(f)[0]);
});

test("unpin explains that pins are cleared by a new session", async () => {
	const { f } = await setup();
	await f.command("unpin 1");
	assert.match(last(f)[0], /pins cannot be removed.*new session/i);
	assert.deepEqual(f.appended, []);
});

test("unknown subcommands print the usage with every subcommand", async () => {
	const { f } = await setup();
	await f.command("frobnicate");
	const [text, type] = last(f);
	assert.equal(type, "error");
	assert.ok(text.startsWith('Unknown subcommand "frobnicate".'), text);
	for (const sub of SUBCOMMANDS) assert.ok(text.includes(`/compactor ${sub}`), `${sub}\n${text}`);
});

test("without a UI output goes to stderr and settings points to the TUI", async () => {
	const { f } = await setup({ hasUI: false });
	await f.command("status");
	await f.command("settings");
	assert.deepEqual(f.notes, []);
	assert.equal(f.stderr.length, 2);
	assert.ok(f.stderr[0].startsWith("[compactor] phase: idle"), f.stderr[0]);
	assert.match(f.stderr[1], /needs the interactive TUI/);
	assert.deepEqual(f.dialogs, []);
});
