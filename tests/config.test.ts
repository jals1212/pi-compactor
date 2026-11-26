import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, getPath, parseValue, resolveConfig, setPath, unsetPath, validateLayer, type ConfigLayer } from "../src/config.ts";

const resolve = (global: ConfigLayer = {}, project: ConfigLayer = {}, model?: string) => resolveConfig({ global, project, model });

test("no files resolves to the defaults with no warnings", () => {
	const { config, warnings } = resolve();
	assert.deepEqual(config, DEFAULTS);
	assert.deepEqual(warnings, []);
	assert.equal(config.strategy, "hybrid");
	assert.equal(config.safePoint, "settle");
});

test("project overrides global, which overrides defaults", () => {
	const { config } = resolve({ softThreshold: 60, strategy: "summary" }, { softThreshold: 65 });
	assert.equal(config.softThreshold, 65);
	assert.equal(config.strategy, "summary");
	assert.equal(config.hardThreshold, DEFAULTS.hardThreshold);
});

test("nested objects merge key by key", () => {
	const { config } = resolve({ preflight: { maxTurns: 5 } }, { preflight: { budgetTokens: 4000 } });
	assert.equal(config.preflight.maxTurns, 5);
	assert.equal(config.preflight.budgetTokens, 4000);
	assert.equal(config.preflight.enabled, DEFAULTS.preflight.enabled);
});

test("per-model overrides apply only to that provider/modelId, project model wins", () => {
	const global = { softThreshold: 70, models: { "anthropic/opus": { softThreshold: 50 } } };
	const project = { models: { "anthropic/opus": { strategy: "handoff-only" as const } } };
	assert.equal(resolve(global, project, "anthropic/opus").config.softThreshold, 50);
	assert.equal(resolve(global, project, "anthropic/opus").config.strategy, "handoff-only");
	assert.equal(resolve(global, project, "openai/gpt").config.softThreshold, 70);
	assert.equal(resolve(global, project, "openai/gpt").config.strategy, "hybrid");
	const both = resolve(global, { models: { "anthropic/opus": { softThreshold: 55 } } }, "anthropic/opus");
	assert.equal(both.config.softThreshold, 55);
});

test("an invalid value is warned and ignored, keeping the lower layer", () => {
	const { config, warnings } = resolve({ softThreshold: 60 }, { softThreshold: 150 as number, strategy: "squash" as never });
	assert.equal(config.softThreshold, 60);
	assert.equal(config.strategy, "hybrid");
	assert.deepEqual(warnings, [
		"project: softThreshold must be a number from 1 to 99 (got 150); ignored",
		"project: strategy must be one of summary, hybrid, handoff-only (got \"squash\"); ignored",
	]);
});

test("unknown keys are warned", () => {
	const { warnings } = resolve({ softTreshold: 60 } as ConfigLayer);
	assert.deepEqual(warnings, ["global: unknown setting softTreshold; ignored"]);
});

test("soft threshold at or above hard is adjusted below it, with a warning", () => {
	const { config, warnings } = resolve({ softThreshold: 92, hardThreshold: 90 });
	assert.equal(config.softThreshold, 85);
	assert.equal(config.hardThreshold, 90);
	assert.deepEqual(warnings, ["softThreshold 92 is not below hardThreshold 90; using 85"]);
});

test("validateLayer reports model override problems with their scope", () => {
	const { layer, warnings } = validateLayer({ models: { "opus": { softThreshold: 50 }, "a/b": { safePoint: "never" } } }, "global");
	assert.deepEqual(layer, { models: {} });
	assert.deepEqual(warnings, [
		"global: model key \"opus\" must be provider/modelId; ignored",
		"global model a/b: safePoint must be one of settle, turn, any (got \"never\"); ignored",
	]);
});

test("a non-object file is warned and treated as empty", () => {
	const { layer, warnings } = validateLayer([1, 2], "project");
	assert.deepEqual(layer, {});
	assert.deepEqual(warnings, ["project: settings must be a JSON object; ignored"]);
});

test("summaryModel and template accept null or a valid string", () => {
	assert.deepEqual(validateLayer({ summaryModel: "anthropic/haiku", preflight: { template: null } }, "global").warnings, []);
	assert.deepEqual(validateLayer({ summaryModel: "haiku" }, "global").warnings, [
		"global: summaryModel must be provider/modelId or null (got \"haiku\"); ignored",
	]);
});

test("getPath, setPath and unsetPath edit dotted keys without touching others", () => {
	const layer: ConfigLayer = { preflight: { maxTurns: 2 }, softThreshold: 60 };
	assert.equal(getPath(DEFAULTS, "preflight.maxTurns"), DEFAULTS.preflight.maxTurns);
	const set = setPath(layer, "preflight.budgetTokens", 5000);
	assert.deepEqual(set, { preflight: { maxTurns: 2, budgetTokens: 5000 }, softThreshold: 60 });
	assert.deepEqual(layer, { preflight: { maxTurns: 2 }, softThreshold: 60 });
	assert.deepEqual(unsetPath(set, "preflight.maxTurns"), { preflight: { budgetTokens: 5000 }, softThreshold: 60 });
	assert.deepEqual(unsetPath({ preflight: { maxTurns: 2 } }, "preflight.maxTurns"), {});
});

test("parseValue converts text input by the key's type and rejects bad input", () => {
	assert.deepEqual(parseValue("softThreshold", "65"), { ok: true, value: 65 });
	assert.deepEqual(parseValue("preflight.enabled", "false"), { ok: true, value: false });
	assert.deepEqual(parseValue("summaryModel", ""), { ok: true, value: null });
	assert.deepEqual(parseValue("strategy", "summary"), { ok: true, value: "summary" });
	assert.deepEqual(parseValue("softThreshold", "abc"), { ok: false, error: "softThreshold must be a number from 1 to 99 (got \"abc\")" });
	assert.deepEqual(parseValue("nope", "1"), { ok: false, error: "unknown setting nope" });
});
