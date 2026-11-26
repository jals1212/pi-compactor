import assert from "node:assert/strict";
import { test } from "node:test";
import { createSummarizer } from "../src/summarize.ts";
import { fakePi, reply } from "./helpers.ts";

const serialize = (messages: unknown[]) => `CONVERSATION(${messages.length})`;

function setup(over: { summaryModel?: string | null; model?: unknown } = {}) {
	const f = fakePi();
	const warnings: string[] = [];
	const controller = new AbortController();
	const ctx = { model: "model" in over ? over.model : f.ctx.model, modelRegistry: f.ctx.modelRegistry };
	const summarize = createSummarizer({ ctx: ctx as never, summaryModel: over.summaryModel ?? null, signal: controller.signal, serialize, warn: (t) => void warnings.push(t) });
	return { f, summarize, warnings, controller };
}

test("summarizes with the session model and Pi's completion options", async () => {
	const { f, summarize, controller } = setup();
	f.setReply(reply("  the summary  ", { usage: { output: 7 } }));
	const out = await summarize({ messages: [1, 2, 3] });
	assert.deepEqual(out, { text: "the summary", usage: { output: 7 } });
	assert.equal(f.completions.length, 1);
	const call = f.completions[0];
	assert.equal(call.model, f.ctx.model);
	assert.equal(call.options.maxTokens, 8192);
	assert.equal(call.options.signal, controller.signal);
	assert.equal(call.options.cacheRetention, "none");
	assert.equal(typeof call.options.sessionId, "string");
	assert.equal(call.context.messages.length, 1);
	const [message] = call.context.messages;
	assert.equal(message.role, "user");
	assert.equal(typeof message.timestamp, "number");
	assert.equal(message.content.length, 1);
	assert.equal(message.content[0].type, "text");
	assert.match(message.content[0].text, /CONVERSATION\(3\)/);
	assert.match(message.content[0].text, /goals/i);
	assert.match(message.content[0].text, /next steps/i);
	assert.doesNotMatch(message.content[0].text, /Previous summary/);
});

test("merges the previous summary and the extra instructions into the prompt only when given", async () => {
	const { f, summarize } = setup();
	await summarize({ messages: [], previousSummary: "OLD STATE", instructions: "do not repeat the handoff" });
	const text = f.completions[0].context.messages[0].content[0].text;
	assert.match(text, /Previous summary[\s\S]*OLD STATE/);
	assert.match(text, /do not repeat the handoff/);
});

test("summaryModel is looked up as provider/modelId in the registry", async () => {
	const { f, summarize, warnings } = setup({ summaryModel: "google/flash" });
	const flash = { provider: "google", id: "flash" };
	f.registry.set("google/flash", flash);
	await summarize({ messages: [] });
	assert.equal(f.completions[0].model, flash);
	assert.deepEqual(warnings, []);
});

test("an unknown summaryModel warns and falls back to the session model", async () => {
	const { f, summarize, warnings } = setup({ summaryModel: "google/missing" });
	await summarize({ messages: [] });
	assert.equal(f.completions[0].model, f.ctx.model);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /google\/missing/);
});

test("without a summary model and a session model it throws before calling the LLM", async () => {
	const { f, summarize } = setup({ model: undefined });
	await assert.rejects(summarize({ messages: [] }), /no model/i);
	assert.equal(f.completions.length, 0);
	const unknown = setup({ model: undefined, summaryModel: "google/missing" });
	await assert.rejects(unknown.summarize({ messages: [] }), /no model/i);
});

test("rejects responses cut by length, errors or aborts", async () => {
	for (const stopReason of ["length", "error", "aborted"]) {
		const { f, summarize } = setup();
		f.setReply(reply("partial", { stopReason, errorMessage: "boom" }));
		await assert.rejects(summarize({ messages: [] }), new RegExp(stopReason), stopReason);
	}
});

test("propagates a failing completion", async () => {
	const { f, summarize } = setup();
	f.setReply(new Error("network down"));
	await assert.rejects(summarize({ messages: [] }), /network down/);
});

test("joins text blocks and ignores the others", async () => {
	const { f, summarize } = setup();
	f.setReply({ content: [{ type: "thinking" }, { type: "text", text: "a" }, { type: "text", text: "b" }], stopReason: "stop" });
	assert.deepEqual(await summarize({ messages: [] }), { text: "a\nb", usage: undefined });
});
