# Draft issue for earendil-works/pi (not sent; the user decides)

Repository: https://github.com/earendil-works/pi

**Title:** Boundary `compaction` drafts are persisted without emitting `session_compact` (or `compaction_end`)

## Summary

An extension can return a `compaction` draft from a boundary handler (`agent_before_settle` / `turn_end`). This is the typed route for compaction during a run (`firstKeptEntryId: string | null`). Pi persists it as a normal compaction entry, but it emits none of the events the other compaction paths emit. Extensions that react to compaction through `session_compact` never learn that the context was compacted. For example, a memory extension that archives the summary and injects a recovery notice misses it.

## Versions

- `@earendil-works/pi-coding-agent` 1.6.1 (also seen on 1.6.0)
- Node 22, macOS

## Where

In `dist/core/agent-session.js` (1.6.1):

- `_applyBoundaryDrafts` (~L637-656): a `compaction` draft goes to `manager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, true, usage)` (~L652-653). No event is emitted afterwards.
- `compact()` emits `session_compact` (~L2410) and `compaction_end` (~L2428/~L2442) after appending its entry.
- Auto-compaction emits `session_compact` (~L2699) and `compaction_end` (~L2714).

So the same kind of entry (`type: "compaction"`) is announced on two paths and silent on the third.

## Why the boundary path matters

`ctx.compact()` is fire-and-forget. In print mode (`pi -p`) the runtime is disposed as soon as `prompt()` resolves, and `dispose()` aborts a compaction that is still running ("Compaction cancelled"). Any follow-up message sent from `onComplete` never runs. A boundary draft is awaited inside the prompt, so it is the only route that works in every mode. Extensions that use it must currently choose: either work in print/JSON mode, or let `session_compact` listeners see the compaction.

## Reproduction

1. Write an extension that returns, from `agent_before_settle`, `{ entries: [...event.entries, { type: "compaction", summary: "S", firstKeptEntryId: null }] }`.
2. Write a second extension that registers `pi.on("session_compact", ...)` and logs.
3. Run `pi -p --session-dir <dir> -e a.ts -e b.ts "say hi"`.
4. The session file contains the compaction entry; the `session_compact` listener never runs.

## Expected

After persisting a boundary `compaction` draft, emit `session_compact` with the same payload shape as the other paths: the persisted compaction entry and a reason, for example `"extension"` or the boundary name. Emitting `compaction_start`/`compaction_end` for consistency would help UIs too. If emitting it from the boundary commit is undesirable, a documented alternative event would also work.

## Context

Found while building pi-compactor (a phased compaction extension: preflight handoff, safe points, pins). Today it uses `ctx.compact` in tui/rpc mode, so `session_compact` listeners work there, and boundary drafts in print/json mode, where they don't. With the event emitted for boundary drafts, it could use one route everywhere.
