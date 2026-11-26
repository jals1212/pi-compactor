// Prototype for the GAP in odd/tasks/compactor.md (S7, S9): does a compaction
// whose firstKeptEntryId is null (or not found) retain nothing but the summary?
// Pins Pi behavior the handoff-only strategy relies on; not part of the package.
// Run: PI_CODING_AGENT=<path to @earendil-works/pi-coding-agent> node --test prototype/
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const root = process.env.PI_CODING_AGENT;
if (!root) throw new Error("Set PI_CODING_AGENT to the pi-coding-agent package directory");
const { SessionManager } = await import(pathToFileURL(join(root, "dist/index.js")).href);

function user(text: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistant(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function seeded() {
  const sm = SessionManager.inMemory(process.cwd());
  const ids = {
    first: sm.appendMessage(user("old request")),
    middle: sm.appendMessage(assistant("old answer")),
    last: sm.appendMessage(user("latest request")),
  };
  return { sm, ids };
}

function texts(sm: any): string[] {
  return sm.buildSessionContext().messages.map((m: any) =>
    typeof m.content === "string"
      ? m.content
      : (m.content ?? []).map((c: any) => c.text ?? "").join("") || m.summary || "",
  );
}

function hasOld(t: string[]) {
  return t.some((s) => s.includes("old request") || s.includes("old answer") || s.includes("latest request"));
}

for (const [name, id] of [["null", null], ["undefined", undefined], ["empty string", ""], ["unknown id", "nope"]] as const) {
  test(`firstKeptEntryId ${name} retains only the summary`, () => {
    const { sm } = seeded();
    sm.appendCompaction("HANDOFF", id as unknown as string, 1000);
    const msgs = sm.buildSessionContext().messages;
    assert.equal(msgs.length, 1, JSON.stringify(msgs));
    assert.equal(msgs[0].role, "compactionSummary");
    assert.match(JSON.stringify(msgs[0]), /HANDOFF/);
  });
}

test("firstKeptEntryId of the latest entry keeps that entry only", () => {
  const { sm, ids } = seeded();
  sm.appendCompaction("HANDOFF", ids.last, 1000);
  const t = texts(sm);
  assert.equal(t.length, 2, JSON.stringify(t));
  assert.ok(t.some((s) => s.includes("latest request")));
  assert.ok(!t.some((s) => s.includes("old request")));
});

test("custom messages appended after a retain-none compaction survive", () => {
  const { sm } = seeded();
  sm.appendCompaction("HANDOFF", null as unknown as string, 1000);
  sm.appendCustomMessageEntry("compactor-pin", "PIN: original request", false);
  const t = texts(sm);
  assert.equal(t.length, 2, JSON.stringify(t));
  assert.ok(t.some((s) => s.includes("PIN: original request")));
  assert.ok(!hasOld(t));
});
