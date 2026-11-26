# Draft issue for earendil-works/pi (not sent; the user decides)

Repository: https://github.com/earendil-works/pi

**Title:** Boundary `compaction` drafts are persisted without emitting `session_compact` (or `compaction_end`)

## Summary

An extension can return a `compaction` draft from a boundary handler (`agent_before_settle` / `turn_end`). This is the typed route for compaction during a run (`firstKeptEntryId: string | null`). Pi persists it as a normal compaction entry, but it emits none of the events the other compaction paths emit. Extensions that react to compaction through `session_compact` never learn that the context was compacted. For example, a memory extension that archives the summary and injects a recovery notice misses it.

## Versions

- `@earendil-works/pi-coding-agent` 1.6.1
- macOS

## Where

In `dist/core/agent-session.js` (1.6.1):

- `_applyBoundaryDrafts` (~L637-656): a `compaction` draft goes to `manager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, true, usage)` (~L652-653). No event is emitted afterwards.
- `compact()` emits `session_compact` (~L2410) and `compaction_end` (~L2428/~L2442) after appending its entry.
- Auto-compaction emits `session_compact` (~L2699) and `compaction_end` (~L2714).

So the same kind of entry (`type: "compaction"`) is announced on two paths and silent on the third.

## Why the boundary path matters

`ctx.compact()` is fire-and-forget. In print mode (`pi -p`) the runtime is disposed as soon as `prompt()` resolves, and `dispose()` aborts a compaction that is still running ("Compaction cancelled"). Any follow-up message sent from `onComplete` never runs. A boundary draft is awaited inside the prompt, so it is the only route that works in every mode. Extensions that use it must currently choose: either work in print/JSON mode, or let `session_compact` listeners see the compaction.

## Reproduction (verified on 1.6.1)

`a.ts` returns a compaction draft from the settle boundary:
```ts
export default function (pi: any) {
	let done = false;
	pi.on("agent_before_settle", (event: any) => {
		if (done || event.outcome !== "completed") return;
		done = true;
		return { entries: [...event.entries, { type: "compaction", summary: "S", firstKeptEntryId: null }] };
	});
}
```
`b.ts` logs the compaction events it observes:
```ts
import { appendFileSync } from "node:fs";
const log = (line: string) => appendFileSync(process.env.EVENTS_LOG!, line + "\n");
export default function (pi: any) {
	pi.on("session_before_compact", (e: any) => void log(`session_before_compact reason=${e.reason}`));
	pi.on("session_compact", (e: any) => void log(`session_compact reason=${e.reason}`));
}
```
`c.ts` (control) compacts through `ctx.compact`, with a summary built in the hook so no LLM call is needed:
```ts
export default function (pi: any) {
	let done = false;
	pi.on("session_before_compact", () => ({ compaction: { summary: "S", firstKeptEntryId: null, tokensBefore: 0 } }));
	pi.on("agent_settled", (_e: any, ctx: any) => {
		if (done) return;
		done = true;
		ctx.compact({ onComplete: () => {}, onError: (err: Error) => console.error(err.message) });
	});
}
```
Runs:
```sh
EVENTS_LOG=$PWD/events-boundary.log pi --no-extensions -e a.ts -e b.ts -p --session-dir sessions-boundary 'Reply with the single word hi.'
# control: the session must exceed keepRecentTokens, so four 3000-line files are read first
EVENTS_LOG=$PWD/events-control.log pi --no-extensions -e c.ts -e b.ts -p --session-dir sessions-control \
  'Run `cat big1.txt`, `cat big2.txt`, `cat big3.txt`, `cat big4.txt`, each in its own tool call. Then reply with the single word hi.'
```

Results:

| Run | Session entries end with | Events logged by `b.ts` |
|---|---|---|
| boundary draft (`a.ts`) | `compaction` | none |
| control (`c.ts`, `ctx.compact`) | `compaction` | `session_before_compact reason=manual`, `session_compact reason=manual` |

The same kind of entry is persisted in both runs, but only the control run announces it.

## Expected

After persisting a boundary `compaction` draft, emit `session_compact` with the same payload shape as the other paths: the persisted compaction entry and a reason, for example `"extension"` or the boundary name. Emitting `compaction_start`/`compaction_end` for consistency would help UIs too. If emitting it from the boundary commit is undesirable, a documented alternative event would also work.

## Context

Found while building pi-compactor (a phased compaction extension: preflight handoff, safe points, pins). Today it uses `ctx.compact` in tui/rpc mode, so `session_compact` listeners work there, and boundary drafts in print/json mode, where they don't. With the event emitted for boundary drafts, it could use one route everywhere.
