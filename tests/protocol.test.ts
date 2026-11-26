import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNELS, collectContributions, createCriticalSections, DEFAULT_TEMPLATE, renderPreflight, type EventBus } from "../src/protocol.ts";

function bus(): EventBus & { emitted: [string, unknown][] } {
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	const emitted: [string, unknown][] = [];
	return {
		emitted,
		emit(channel, data) {
			emitted.push([channel, data]);
			// Like Pi's event bus: each listener is isolated, its errors are logged by Pi, not thrown to the emitter.
			for (const l of listeners.get(channel) ?? []) {
				try {
					l(data);
				} catch {}
			}
		},
		on(channel, handler) {
			listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
			return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((h) => h !== handler));
		},
	};
}

test("channel names are the documented ones", () => {
	assert.deepEqual(CHANNELS, { collect: "compactor:collect", defer: "compactor:defer", done: "compactor:done" });
});

test("collect gathers steps and handoff sections from any listener, in order", () => {
	const b = bus();
	b.on("compactor:collect", (p: any) => p.contribute({ source: "notes", steps: ["Save notes to notes.md"] }));
	b.on("compactor:collect", (p: any) => {
		assert.equal(p.reason, "threshold");
		assert.equal(p.strategy, "hybrid");
		p.contribute({ source: "todo", handoff: "Open todos: 3" });
	});
	const { contributions, warnings } = collectContributions(b, { reason: "threshold", strategy: "hybrid" });
	assert.deepEqual(contributions, [
		{ source: "notes", steps: ["Save notes to notes.md"] },
		{ source: "todo", handoff: "Open todos: 3" },
	]);
	assert.deepEqual(warnings, []);
});

test("malformed contributions and throwing listeners are warned and skipped", () => {
	const b = bus();
	b.on("compactor:collect", (p: any) => p.contribute({ steps: ["no source"] }));
	b.on("compactor:collect", (p: any) => p.contribute({ source: "x", steps: "not a list" }));
	b.on("compactor:collect", () => {
		throw new Error("boom");
	});
	b.on("compactor:collect", (p: any) => p.contribute({ source: "ok", steps: ["  ", "Do it"] }));
	const { contributions, warnings } = collectContributions(b, { reason: "manual", strategy: "summary" });
	assert.deepEqual(contributions, [{ source: "ok", steps: ["Do it"] }]);
	assert.deepEqual(warnings, [
		"ignored contribution: source must be a non-empty string",
		"ignored contribution from x: steps must be a list of strings",
	]);
});

test("contribute after collection ends is ignored", () => {
	const b = bus();
	let late: ((c: unknown) => void) | undefined;
	b.on("compactor:collect", (p: any) => (late = p.contribute));
	const first = collectContributions(b, { reason: "manual", strategy: "summary" });
	late!({ source: "late", steps: ["x"] });
	assert.deepEqual(first.contributions, []);
});

test("critical sections open and close by source, and listen on the defer channel", () => {
	const b = bus();
	const sections = createCriticalSections(b);
	assert.deepEqual(sections.active(), []);
	b.emit("compactor:defer", { source: "deploy", active: true, reason: "migration running" });
	sections.set("agent", true, "editing");
	assert.deepEqual(sections.active(), [
		{ source: "deploy", reason: "migration running" },
		{ source: "agent", reason: "editing" },
	]);
	b.emit("compactor:defer", { source: "deploy", active: false });
	assert.deepEqual(sections.active(), [{ source: "agent", reason: "editing" }]);
	b.emit("compactor:defer", { nonsense: true });
	sections.clear();
	assert.deepEqual(sections.active(), []);
});

test("the preflight message renders the template with steps and contributions", () => {
	const text = renderPreflight({
		template: null,
		strategy: "handoff-only",
		reason: "threshold",
		percent: 71.6,
		steps: [{ source: "notes", steps: ["Save notes"] }],
	});
	assert.ok(text.startsWith("[compactor] Context is at 72%"));
	assert.match(text, /strategy: handoff-only/);
	assert.match(text, /- Save notes \(from notes\)/);
	assert.match(text, /compaction_ready/);
	assert.ok(DEFAULT_TEMPLATE.includes("{{steps}}"));
});

test("a custom template replaces known placeholders and keeps unknown ones", () => {
	const text = renderPreflight({ template: "At {{percent}}% via {{reason}}: {{steps}} {{other}}", strategy: "summary", reason: "manual", percent: 50, steps: [] });
	assert.equal(text, "At 50% via manual: (none) {{other}}");
});
