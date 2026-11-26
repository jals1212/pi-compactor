import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStore } from "../src/store.ts";

function dirs() {
	const root = mkdtempSync(join(tmpdir(), "compactor-store-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	return { agentDir, cwd, store: createStore({ agentDir, cwd }) };
}

test("paths follow the documented locations", () => {
	const { agentDir, cwd, store } = dirs();
	assert.equal(store.paths.global, join(agentDir, "extensions", "pi-compactor", "config.json"));
	assert.equal(store.paths.project, join(cwd, ".pi", "compactor.json"));
});

test("missing files load as empty with no warnings", () => {
	const { store } = dirs();
	assert.deepEqual(store.load(), { global: {}, project: {}, warnings: [] });
});

test("invalid JSON is warned and loads as empty", () => {
	const { cwd, store } = dirs();
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(store.paths.project, "{ nope");
	const loaded = store.load();
	assert.deepEqual(loaded.project, {});
	assert.equal(loaded.warnings.length, 1);
	assert.match(loaded.warnings[0], /^project: cannot read .*compactor\.json: /);
});

test("update writes the key, creating directories, and keeps other content", () => {
	const { store } = dirs();
	assert.deepEqual(store.update("global", "softThreshold", 60), { ok: true });
	assert.deepEqual(store.update("global", "preflight.maxTurns", 4), { ok: true });
	assert.deepEqual(JSON.parse(readFileSync(store.paths.global, "utf8")), { softThreshold: 60, preflight: { maxTurns: 4 } });
	assert.deepEqual(store.load().global, { softThreshold: 60, preflight: { maxTurns: 4 } });
});

test("update with a model writes under models and undefined removes the key", () => {
	const { store } = dirs();
	store.update("project", "strategy", "handoff-only", "anthropic/opus");
	assert.deepEqual(store.load().project, { models: { "anthropic/opus": { strategy: "handoff-only" } } });
	store.update("project", "strategy", undefined, "anthropic/opus");
	assert.deepEqual(store.load().project, {});
});

test("update rejects an invalid value and leaves the file unchanged", () => {
	const { store } = dirs();
	store.update("global", "softThreshold", 60);
	const before = readFileSync(store.paths.global, "utf8");
	assert.deepEqual(store.update("global", "softThreshold", 120), { ok: false, error: "softThreshold must be a number from 1 to 99 (got 120)" });
	assert.deepEqual(store.update("global", "bogus", 1), { ok: false, error: "unknown setting bogus" });
	assert.deepEqual(store.update("global", "softThreshold", 50, "opus"), { ok: false, error: "model must be provider/modelId (got \"opus\")" });
	assert.equal(readFileSync(store.paths.global, "utf8"), before);
});

test("update refuses to overwrite a file that is not valid JSON", () => {
	const { cwd, store } = dirs();
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(store.paths.project, "{ hand edited");
	const result = store.update("project", "softThreshold", 60);
	assert.equal(result.ok, false);
	assert.match((result as { error: string }).error, /^cannot update .*compactor\.json: /);
	assert.equal(readFileSync(store.paths.project, "utf8"), "{ hand edited");
});

test("update preserves unknown keys already in the file and leaves no temp files", () => {
	const { cwd, store } = dirs();
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(store.paths.project, JSON.stringify({ note: "mine" }));
	store.update("project", "enabled", false);
	assert.deepEqual(JSON.parse(readFileSync(store.paths.project, "utf8")), { note: "mine", enabled: false });
	assert.deepEqual(readdirSync(join(cwd, ".pi")), ["compactor.json"]);
	assert.ok(existsSync(store.paths.project));
});
