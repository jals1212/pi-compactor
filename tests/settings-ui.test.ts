import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { FIELDS, getPath, parseValue } from "../src/config.ts";
import { registerCompactor } from "../src/wire.ts";
import { fakePi, pick } from "./helpers.ts";

async function setup(options: Parameters<typeof fakePi>[0] = {}) {
	const f = fakePi(options);
	const api = registerCompactor(f.pi, { agentDir: f.agentDir, stderr: (t) => void f.stderr.push(t) });
	await f.fire("session_start", { reason: "startup" });
	return { f, api };
}
const file = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("the scope choice offers global, project and the current model in both files", async () => {
	const { f } = await setup();
	f.answers(undefined);
	await f.command("settings");
	assert.equal(f.dialogs.length, 1);
	assert.equal(f.dialogs[0].kind, "select");
	assert.deepEqual(f.dialogs[0].options, ["global", "project", "model anthropic/opus (global file)", "model anthropic/opus (project file)"]);
	assert.deepEqual(f.appended, []);
});

test("without a current model only global and project are offered", async () => {
	const { f } = await setup({ model: undefined });
	f.answers(undefined);
	await f.command("settings");
	assert.deepEqual(f.dialogs[0].options, ["global", "project"]);
});

test("the list shows every setting in order with its effective and own value", async () => {
	const { f, api } = await setup();
	api.settings.store().update("global", "softThreshold", 50);
	api.settings.store().update("project", "softThreshold", 60);
	f.answers(pick("project"), undefined);
	await f.command("settings");
	const list = f.dialogs[1];
	assert.ok(list.title.includes("scope: project"), list.title);
	const rows = list.options!.slice(0, FIELDS.length);
	FIELDS.forEach((field, i) => assert.ok(rows[i].startsWith(`${field.key} = `), `${i}: ${rows[i]}`));
	assert.ok(rows.find((r) => r.startsWith("softThreshold"))!.startsWith("softThreshold = 60 · project: 60"), JSON.stringify(rows));
	assert.ok(rows.find((r) => r.startsWith("strategy"))!.startsWith("strategy = hybrid · project: inherit"));
	assert.ok(rows.find((r) => r.startsWith("preflight.template"))!.includes("built-in"));
	assert.ok(list.options!.slice(FIELDS.length).length >= 2, "has done and change-scope entries");
});

test("a number is edited in the chosen scope and applies at once", async () => {
	const { f, api } = await setup();
	const path = api.settings.store().paths.project;
	f.answers(pick("project"), pick("softThreshold"), pick("Edit"), "60", undefined);
	await f.command("settings");
	assert.deepEqual(file(path), { softThreshold: 60 });
	assert.equal(api.settings.current().softThreshold, 60);
	assert.equal(existsSync(api.settings.store().paths.global), false);
	assert.deepEqual(f.notes.at(-1), [`saved softThreshold = 60 (project: ${path})`, "info"]);
	// the list opened again afterwards shows the new value
	assert.ok(f.dialogs.at(-1)!.options!.some((o) => o.startsWith("softThreshold = 60 · project: 60")));
});

test("invalid input shows the validation error, asks again and writes nothing", async () => {
	const { f, api } = await setup();
	const path = api.settings.store().paths.project;
	f.answers(pick("project"), pick("softThreshold"), pick("Edit"), "abc", "150", undefined, undefined);
	await f.command("settings");
	const errors = f.notes.filter(([, t]) => t === "error").map(([m]) => m);
	assert.deepEqual(errors, [parseValue("softThreshold", "abc"), parseValue("softThreshold", "150")].map((r) => (r as { error: string }).error));
	assert.equal(errors[1], "softThreshold must be a number from 1 to 99 (got 150)");
	assert.equal(f.dialogs.filter((d) => d.kind === "input").length, 3, "asked again after each error");
	assert.equal(existsSync(path), false);
});

test("an enum is chosen from its values and a boolean from true/false", async () => {
	const { f, api } = await setup();
	f.answers(pick("global"), pick("strategy"), pick("handoff-only"), pick("enabled"), pick("false"), undefined);
	await f.command("settings");
	const enumDialog = f.dialogs.find((d) => d.kind === "select" && d.options!.includes("hybrid"))!;
	assert.deepEqual(enumDialog.options, ["summary", "hybrid", "handoff-only", "Reset (inherit)", "Cancel"]);
	const boolDialog = f.dialogs.find((d) => d.kind === "select" && d.options!.includes("true"))!;
	assert.deepEqual(boolDialog.options, ["true", "false", "Reset (inherit)", "Cancel"]);
	assert.deepEqual(file(api.settings.store().paths.global), { strategy: "handoff-only", enabled: false });
});

test("reset removes the setting from that scope only", async () => {
	const { f, api } = await setup();
	const s = api.settings.store();
	s.update("global", "strategy", "summary");
	s.update("project", "strategy", "handoff-only");
	f.answers(pick("project"), pick("strategy"), pick("Reset"), undefined);
	await f.command("settings");
	assert.deepEqual(file(s.paths.project), {});
	assert.deepEqual(file(s.paths.global), { strategy: "summary" });
	assert.equal(api.settings.current().strategy, "summary");
	assert.match(f.notes.at(-1)![0], /reset strategy \(project: /);
});

test("cancelling an edit leaves the value alone", async () => {
	const { f, api } = await setup();
	f.answers(pick("project"), pick("strategy"), pick("Cancel"), undefined);
	await f.command("settings");
	assert.equal(existsSync(api.settings.store().paths.project), false);
});

test("model scope edits models[provider/modelId] of the file chosen", async () => {
	const { f, api } = await setup();
	const s = api.settings.store();
	f.answers(pick("model anthropic/opus (project"), pick("softThreshold"), pick("Edit"), "40", undefined);
	await f.command("settings");
	assert.deepEqual(file(s.paths.project), { models: { "anthropic/opus": { softThreshold: 40 } } });
	assert.equal(api.settings.current().softThreshold, 40);
	await f.fire("model_select", { model: { provider: "openai", id: "gpt" } });
	assert.equal(api.settings.current().softThreshold, 70);
	assert.ok(f.dialogs[1].title.includes("scope: model anthropic/opus (project file)"), f.dialogs[1].title);
});

test("the template is edited in a multi-line editor and empty means built-in", async () => {
	const { f, api } = await setup();
	const s = api.settings.store();
	f.answers(pick("project"), pick("preflight.template"), pick("Edit"), "Write a handoff.\nBe brief.", pick("preflight.template"), pick("Edit"), "", undefined);
	await f.command("settings");
	const editors = f.dialogs.filter((d) => d.kind === "editor");
	assert.equal(editors.length, 2);
	assert.equal(editors[0].initial ?? "", "");
	assert.equal(editors[1].initial, "Write a handoff.\nBe brief.");
	assert.deepEqual(file(s.paths.project), { preflight: { template: null } });
	assert.equal(api.settings.current().preflight.template, null);
});

test("the summary model accepts provider/modelId or empty and rejects the rest", async () => {
	const { f, api } = await setup();
	const s = api.settings.store();
	f.answers(pick("project"), pick("summaryModel"), pick("Edit"), "gpt", "openai/gpt", pick("summaryModel"), pick("Edit"), "", undefined);
	await f.command("settings");
	assert.equal(f.notes.filter(([, t]) => t === "error").length, 1);
	assert.deepEqual(file(s.paths.project), { summaryModel: null });
});

test("inconsistent thresholds are saved and the adjustment is reported", async () => {
	const { f, api } = await setup();
	f.answers(pick("global"), pick("softThreshold"), pick("Edit"), "95", undefined);
	await f.command("settings");
	assert.equal(api.settings.current().softThreshold, 85);
	assert.ok(f.notes.some(([m, t]) => t === "warning" && m.includes("softThreshold 95 is not below hardThreshold 90; using 85")));
});

test("every setting can be edited from the TUI", async () => {
	for (const field of FIELDS) {
		const { f, api } = await setup();
		const kind = field.kind;
		const text = { number: kind.type === "number" ? String(kind.min) : "", boolean: "false", enum: kind.type === "enum" ? kind.values.at(-1)! : "", model: "a/b", text: "hello" }[kind.type];
		const edit = kind.type === "boolean" || kind.type === "enum" ? [pick(text)] : [pick("Edit"), text];
		f.answers(pick("project"), pick(`${field.key} =`), ...edit, undefined);
		await f.command("settings");
		const stored = getPath(api.settings.store().load().project, field.key);
		const expected = parseValue(field.key, text);
		assert.ok(expected.ok, field.key);
		assert.deepEqual(stored, expected.value, field.key);
	}
});
