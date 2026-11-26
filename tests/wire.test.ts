import assert from "node:assert/strict";
import { test } from "node:test";
import { registerCompactor } from "../src/wire.ts";
import { fakePi } from "./helpers.ts";

function setup(options: Parameters<typeof fakePi>[0] = {}) {
	const f = fakePi(options);
	const settings = registerCompactor(f.pi, { agentDir: f.agentDir, stderr: (t) => void f.stderr.push(t) });
	return { f, settings };
}

test("settings resolve for the session model and follow model changes", async () => {
	const { f, settings } = setup();
	await f.fire("session_start", { reason: "startup" });
	settings.store().update("global", "softThreshold", 50, "anthropic/opus");
	assert.equal(settings.current().softThreshold, 50);
	await f.fire("model_select", { model: { provider: "openai", id: "gpt" } });
	assert.equal(settings.current().softThreshold, 70);
	assert.deepEqual(f.notes, []);
});

test("edits on disk apply without reload", async () => {
	const { f, settings } = setup();
	await f.fire("session_start", { reason: "startup" });
	settings.store().update("project", "strategy", "summary");
	assert.equal(settings.current().strategy, "summary");
});

test("warnings are notified once per distinct set, in the UI", async () => {
	const { f, settings } = setup();
	await f.fire("session_start", { reason: "startup" });
	settings.store().update("global", "softThreshold", 95);
	settings.store().update("global", "hardThreshold", 90);
	settings.current();
	settings.current();
	assert.deepEqual(f.notes, [["settings adjusted:\nsoftThreshold 95 is not below hardThreshold 90; using 85", "warning"]]);
	assert.deepEqual(f.stderr, []);
});

test("without a UI warnings go to stderr", async () => {
	const { f, settings } = setup({ hasUI: false });
	await f.fire("session_start", { reason: "startup" });
	settings.store().update("global", "softThreshold", 95);
	settings.store().update("global", "hardThreshold", 90);
	settings.current();
	assert.deepEqual(f.stderr, ["[compactor] settings adjusted:\nsoftThreshold 95 is not below hardThreshold 90; using 85\n"]);
});
