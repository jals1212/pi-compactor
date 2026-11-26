# Feature: pi-compactor

Pi extension package that compacts context in phases: a configurable soft threshold triggers a preflight
in which the agent receives instructions and hands off state, then compaction runs and the agent resumes.
Agnostic extension protocol; no direct adaptations to other extensions.
Status: IMPLEMENTING on branch feat/compactor (L11 "go go go").

## Specs

- S1. "hagamos un autocompactador para Pi, con todo lo esperado en uno bueno"
- S2. "hooks para antes de compactar enviar instrucciones al agente y al cumplirlas seguir con la compactacion"
- S3. Scope: "Completo" — preflight + handoff + compact + resume, pruning of old tool outputs (context_edit), pins, configurable summary model, metrics, commands (`/compactor status|now|off|plan`).
- S4. Delivery: "Paquete npm nuevo en ~/Workspace/oss" (`/Users/jals/Workspace/oss/pi-compactor`). npm package name: `pi-compactor` (reserved by jals1212; `pi-autocompact` rejected by npm as too similar to `pi-auto-compact`). Command, event channels and project config follow the name (L9).
- S5. Preflight instructions: "cofigurable y que se puedan llamar otras extensiones pero siendo agnostico, es decir no ahciendo adaptqciones directas" — configurable template plus a public `pi.events` protocol; the package names no other extension.
- S6. "los umbrales deben ser configurables" — global, project, and per-model (`provider/modelId`) overrides; invalid or inconsistent values are warned and adjusted.
- S7. "se debe poder compactar sin llevarse nada, solo lo que se rescate mediante el hook para handoff" — strategy `handoff-only` (retain-none: handoff + hook contributions + pins).
- S8. Default strategy: "hybrid por defecto". Strategies: `summary`, `hybrid`, `handoff-only`.
- S9. Safety: pins always survive; `handoff-only` without a valid handoff falls back to `hybrid` and records it; `overflow` compaction is never cancelled and skips preflight; preflight bounded by turns and tokens; no unbounded `continue: true` loops; abort cancels preflight cleanly; works without UI.

- S10. "no se debe interrumpir una tarea, no se compacta interrumpiendo algo importante (configurable)" — compaction waits for a safe point per configurable policy (`settle` default: agent settled; `turn`: between turns with no pending tool work; `any`); the agent (tool) and other extensions (agnostic `pi.events` veto/defer) can mark a critical section; deferral is bounded by configurable headroom; only when the hard limit leaves no headroom (or on `overflow`) does compaction proceed, and then with preflight handoff already captured.
- S11. "y todas las configs se deben hacer mediante TUI" — every setting (thresholds, per-model overrides, strategy, safe-point policy, deferral headroom, preflight template/limits, pruning, summary model, pins) is viewable and editable from an interactive TUI (`/compactor` settings), with scope selection (global / project / model) and validation feedback; files remain the storage, never the required editing path.

## Tasks

| ID | Specs | Task | Route | Commit |
|----|-------|------|-------|--------|
| T1 | S4, S6 | Package scaffold, config schema/resolution (global/project/model), validation | inline | 9e65cf9 (done, 24 tests) |
| T2 | S2, S9, S10 | Threshold detector + safe-point/deferral policy + preflight state machine + `compaction_ready` tool + resume | inline | a6d1f97 (done) |
| T3 | S7, S8, S9 | Strategies (summary/hybrid/handoff-only), pins, cumulative file lists, summary model | builder inline; wiring worker | 1fdb163, fb2b1df (done) |
| T4 | S3 | Pruning of old tool outputs via context_edit | planner worker, wiring inline | a407df1 + next commit (done) |
| T5 | S5 | Agnostic `pi.events` contribution protocol + configurable template | inline | 48f0a8f, a6d1f97 |
| T6 | S3, S11 | Commands, TUI settings editor (all configs, scopes, validation), status indicator, metrics in details | worker (context backstop) | cf6a025 (done) |
| T7 | S1-S9 | README/docs, final verification | inline | 98af65b, f66f886, 8f7b248 (done; live evidence L17) |
| T8 | S2, S9 | Automatic compaction as a settle boundary `compaction` draft + resume `custom_message` + `continue` in every mode (own preparation via `findCutPoint`); `ctx.compact` kept for `/compactor now` | inline | 8f7b248 (done: 152 tests, tsc clean, live L17) |

## Plan (design notes for later)

- Flow: soft threshold (configurable) → wait for safe point (S10) → preflight: hidden `custom_message` with checklist (template + `pi.events` contributions) and `continue: true` → agent calls `compaction_ready({ handoff })` → `ctx.compact()` → `session_before_compact` builds summary per strategy → `session_compact` injects resume message only if work was in progress.
- Preflight bounded by `preflightMaxTurns` and `preflightBudgetTokens`; on timeout compact anyway (handoff optional).
- Native threshold compaction during preflight/deferral: cancel in `session_before_compact` only while headroom remains; `overflow` never cancelled, no preflight.
- Strategies: `summary` (Pi format + pins), `hybrid` default (handoff + summary + trimmed recent), `handoff-only` (retain-none; handoff + contributions + pins; fallback to hybrid without valid handoff, recorded in metrics).
- Pins: original user request, corrections, constraints kept verbatim; `/pin` command.
- Keep cumulative read/modified file lists in `details` (Pi drops them for extension summaries).
- Pruning: `context_edit` omissions of old large tool results (repeated reads, superseded reads, long bash logs) before deciding to summarize.
- Protocol (agnostic): `compactor:collect` (contribute preflight steps / handoff sections), `compactor:defer` (critical section), `compactor:done` (post-compact notice). Package names no other extension.
- Config keys (all TUI-editable, scopes global/project/model): `softThreshold`, `preflightBudgetTokens`, `preflightMaxTurns`, `strategy`, `safePoint` (`settle`|`turn`|`any`), `maxDeferTokens`, `template`, `pruning.*`, `summaryModel`, `pins.*`, `modelOverrides`.
- Risks: preflight consumes headroom; headless/RPC/subagents must work without UI; prompt-cache loss; pin Pi peer version and test via public extension API.
- Before coding: read the explorer handoff (API types, TUI API, settings persistence, sibling package conventions in pi-mox/pi-spaces) appended below as evidence.

## Evidence (explorer handoff, T0; PI = node_modules/@earendil-works/pi-coding-agent, line numbers approx ±2)

- Types `PI/dist/core/extensions/types.d.ts`: `ContextUsage {tokens|null, contextWindow, percent|null}` L217; `ctx.getContextUsage()` L268; `ctx.compact({customInstructions,onComplete,onError})` L224-228/L270; ctx has `ui, mode (tui|rpc|json|print), hasUI, cwd, sessionManager, modelRegistry, model, isIdle(), signal, abort()`.
- `SessionBeforeCompactEvent` L621 `{preparation, branchEntries, customInstructions?, reason manual|threshold|overflow, willRetry, signal}`; result L1157 `{cancel?, compaction?: CompactionResult}`; `SessionCompactEvent` L633; failed L643.
- `CompactionPreparation` (`compaction/compaction.d.ts` ~L120): `firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, previousSummary?, fileOps, settings`. `CompactionResult` `{summary, firstKeptEntryId: string, tokensBefore, estimatedTokensAfter?, usage?, details?}`.
- Boundaries: `TurnEndEvent` L848 / `agent_before_settle` L817 extend `{entries, continue, context, outcome completed|aborted|error}`; result `{entries?, continue?}`. Drafts L773-797: `custom`, `custom_message {customType, content, display, details?}`, `context_edit {targetId, replacement null|{content}}`, `compaction {summary, firstKeptEntryId: string|null, details?, usage?}` — `null` = retain-none.
- GAP (RESOLVED 2026-11-26, `prototype/retain-none.test.ts`, 6/6 pass on Pi 1.6.0): `session_before_compact` may return `compaction.firstKeptEntryId: null` (cast; typed `string`) and `SessionManager.appendCompaction` stores `firstKeptEntryId ?? id` (self) → context is only the summary. `""` or an unknown id also retain nothing (silently); the latest entry id keeps just that entry; `custom_message` entries appended after the compaction survive. Core never validates the id on the hook path (`agent-session.js` ~2385/~2676) and honors `cancel` for every reason, so overflow-never-cancel is the extension's rule. Typed/documented route: boundary `compaction` draft (`agent_before_settle`/`turn_end`, `firstKeptEntryId: string|null`, `agent-session.js` ~637-656); it bypasses `session_before_compact` and `ctx.compact()`. `prepareCompaction` is NOT exported; `ctx.compact()` throws when the last entry is already a compaction. Decision: handoff-only uses the hook path with `null` (pinned by a package test), boundary draft as the settle-time alternative.
- Helpers exported from `@earendil-works/pi-coding-agent` (`dist/index.d.ts` L11-19): `compact`, `generateSummary`, `generateSummaryWithUsage`, `serializeConversation`, `estimateTokens`, `findCutPoint`, `calculateContextTokens`, `FileOperations`; `prepareCompaction` maybe not exported (check).
- `examples/extensions/custom-compaction.ts`: `ctx.modelRegistry.find(provider,id)` + `ctx.modelRegistry.complete(model,{messages},{maxTokens,signal,cacheRetention:"none",sessionId})`; `serializeConversation(convertToLlm(msgs))`; return `undefined` to fall back.
- `registerTool(ToolDefinition)` L1271 (TypeBox `parameters`); `registerCommand` L1273; `pi.events` L1451: `emit(channel,data): void`, `on(channel,handler): unsubscribe` — sync, no return values → protocol uses a shared mutable payload (e.g. `{ contributions: [] }`) that listeners push into.
- `ctx.ui.setStatus(key,text)` L95; dialogs `select/confirm/input/notify` L85-89; `ctx.ui.custom(factory(tui,theme,keybindings,done),{overlay,overlayOptions})` ~L150; `docs/tui.md:39` `SelectList`/`SettingsList` components; keys via injected KeybindingsManager (`tui.md:48`). Non-TUI modes: fall back to dialogs or skip.
- Settings: no ExtensionAPI write method → own JSON `~/.pi/agent/extensions/pi-compactor/config.json` (via exported `getAgentDir`) + project `.pi/compactor.json` when trusted; Pi's own compaction keys in `settings-schema.js:10-18`.
- Package conventions (pi-mox): `"type":"module"`, `"pi":{"extensions":["./extensions/<name>.ts"]}`, `node --test "tests/*.test.ts"`, optional peers `pi-coding-agent`/`pi-tui` `*`, `engines.node >=22.18`; tests use a fake `pi` object with injected deps (`src/wire.ts`). pi-spaces adds a build to `dist/` and stub fixtures.
- Still to read before coding: examples `preset.ts`, `questionnaire.ts`, `modal-editor.ts`, `overlay-qa-tests.ts`; pi-ai `Model.contextWindow`.

## Log

- L1. "hagamos un autocompactador para Pi, con todo lo esperado en uno bueno, primero analisis y lluvia de ideas, hooks para antes de compactar enviar instrucciones al agente y al cumplirlas seguir con la compactacion, esa es una idea"
- L2. Answers: scope "Completo"; location "Paquete npm nuevo en ~/Workspace/oss"; preflight "cofigurable y que se puedan llamar otras extensiones pero siendo agnostico, es decir no ahciendo adaptqciones directas".
- L3. "los umbrales deben ser configurables y se debe poder compactar sin llevarse nada, solo lo que se rescate mediante el hook para handoff (no sé si es lo mejor)"
- L4. Default strategy chosen: hybrid.
- L5. "y no se debe interrumpir una tarea, no se compacta interrumpiendo algo importante (configurable)"
- L6. "y todas las configs se deben hacer mediante TUI"
- L7. "no programes, solo anota el plan para despues"
- L8. Name: "pi-autocompact" rejected by npm (403, too similar to `pi-auto-compact`); user wanted a name in the style of their packages, "algo como una prensa, que compacta", chose "pi-compactor o squash"; `pi-compactor` published as placeholder `0.0.0-stage` on 2026-11-26. User: "ok Sí" to updating the plan with the new name.
- L9. User "Sí" to renaming the command to `/compactor`, event channels to `compactor:*`, project config to `.pi/compactor.json`, the directory to `pi-compactor`, and this document to `odd/tasks/compactor.md`.
- L10. User "seguimos" → chose "Prototipo de la brecha primero" (prove retain-none before coding T1). Result recorded in the Evidence GAP line.
- L11. User "go go go" after the prototype result: implementation authorized; T1 done in 9e65cf9.

## Implementation notes (for workers)

- Layout: `src/config.ts` (schema FIELDS/DEFAULTS, resolveConfig, setPath/parseValue), `src/store.ts` (files), `src/controller.ts` (pure cycle state machine), `src/protocol.ts` (pi.events + template), `src/cycle.ts` (Pi wiring of the cycle, tools `compaction_ready`/`compaction_defer`), `src/strategy.ts` (pure `buildCompaction`, pins, file lists), `src/wire.ts` (`registerCompactor` composes everything), `extensions/compactor.ts` (entry). Tests: `tests/*.test.ts` with the fake Pi in `tests/helpers.ts`; run `npm test`.
- Pi facts: `ctx.compact()` aborts a running turn, so compaction runs only at `agent_settled`; preflight is a hidden `custom_message` boundary draft + `continue: true`; Pi caps no continue loops; Pi does not auto-continue after threshold compaction (we send `compactor-resume`); `session_before_compact` honors `cancel` for every reason; `pi.events` listeners are isolated and must act synchronously; `firstKeptEntryId: null` from the hook is retain-none (prototype/retain-none.test.ts). A boundary handler's returned `entries` REPLACE event.entries (return `[...event.entries, ...new]`); one bad draft drops the whole boundary. Pruning runs when usage crosses the soft threshold (idle/pending), before the cycle arms.
- L12. Verification 2026-11-26: 139 tests pass; `tsc --strict` clean against Pi 1.6.1 (tsconfig `paths` to the installed package, scratch dir). Live Pi 1.6.0 (`pi --no-extensions -e extensions/compactor.ts -p`): `/compactor status` works in print mode; with softThreshold 1 + handoff-only the hidden preflight fired at settle, the agent called `compaction_ready` with a handoff, and compaction started at idle (reason manual). Pi refused it with "Nothing to compact (session too small)" (its own cut point keeps recent ~20k tokens), our failure path notified and cooled down. A live compaction that actually writes an entry is still unverified (needs a session larger than Pi's keep-recent window).
- L13. Incident: a scratch `npm i --no-save` in a dir whose node_modules/@earendil-works was a symlink into gentle-pi's install pruned the real packages. User chose "Reinstalar con mise (forzado)"; `mise install --force npm:gentle-pi@5.0.0` restored it (now resolves Pi 1.6.1). Never symlink real installs into a dir where npm runs.
- L14. Live run 3 (Pi 1.6.0, `-p --no-session`, softThreshold 1, handoff-only, two 1000-line `cat` outputs): the cycle armed at ~9.8k tokens and was forced at a turn end once growth exceeded maxDeferTokens (33.8k); the agent called `compaction_ready` and stopped before its third command; `compaction_start` fired, but print mode exited before any `compaction_end`, so no written entry and no resume were observed. Pi printed `Extension error (<boundary>): turn_end could not resolve the persisted assistant entry ID` (open: which draft caused it; may be specific to `--no-session`). Next: diagnose that error, then verify compaction + resume in an interactive session.
- L15. Live runs on Pi 1.6.1 (`/tmp/pc-repro`): small sessions (prune on/off, `--no-session` or persisted) show no boundary error but Pi refuses "Nothing to compact (session too small)". Big persisted sessions (4×3000-line cats): handoff-only wrote a real retain-none compaction (tokensBefore 58761, handoff summary) but no resume followed and the boundary error appeared once; hybrid failed with "Compaction cancelled". Explorer root cause (high confidence): `ctx.compact` is fire-and-forget; print mode disposes the runtime when `prompt()` resolves, `dispose()` aborts the running compaction (hybrid's LLM summary loses the race) and the follow-up resume never runs. The boundary error's turn remains unidentified (low confidence).
- L16. User asked "que recomiendas?", then chose "Yes, compact in the end-of-run step everywhere": automatic compaction moves to the `agent_before_settle` boundary (compaction draft + resume + continue) in every mode; `/compactor now` and Pi's own compactions keep `session_before_compact`. Task T8.
- L17. T8 verified (independent verify, 8f7b248, Pi 1.6.1, persisted print-mode sessions, `/tmp/pc-repro/run2.sh`): S2 pass, S9 pass. handoff-only wrote a retain-none compaction (firstKeptEntryId = own id) and hybrid a compaction keeping an existing assistant call with its tool result; both followed by `compactor-resume`, then the agent ran `cat big4.txt` and replied DONE in the same run. No `Extension error`, no "Compaction cancelled". With softThreshold 1 a second cycle ran after DONE (hybrid compacted again without resume; handoff-only hit Pi's "Nothing to compact" and cooled down), expected. Advisories (non-blocking): `src/prepare.ts` lacks Pi's zero-token skip, recovery-omission advance and split-turn fallback (groups everything in `turnPrefixMessages` when no turn start exists; nothing dropped); it was compared against Pi 1.6.0's compaction.js. The `turn_end` identity error did not recur.
