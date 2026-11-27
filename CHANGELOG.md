# Changelog

## 0.1.5

First npm release. Phased context compaction for Pi: the agent hands off first, then the press comes down.

- Preflight handoff: past `softThreshold` the agent gets hidden instructions and calls `compaction_ready({ handoff })` before anything is compacted.
- Safe points (`settle`, `turn`, `any`): compaction never interrupts a running task. Critical sections defer it within a bounded headroom (`hardThreshold`, `maxDeferTokens`).
- Strategies: `hybrid` (default), `summary`, `handoff-only`. Pins keep the original request, user corrections and `/compactor pin` text verbatim. Read/modified file lists carry across compactions.
- Pruning of old large tool outputs before compacting.
- Per-model thresholds, global or per project, edited from `/compactor settings`.
- Agnostic `pi.events` protocol: `compactor:collect`, `compactor:defer`, `compactor:done`.
- Footer status: `🗜️ 88k to compact`, `🗜️ preflight 21%`, `🗜️ compacted from 208k`, `🗜️ off`.
- TUI/RPC compact through Pi, so `session_compact` listeners such as memory extensions see it. Print/JSON write the compaction as a boundary entry and resume in the same run (earendil-works/pi#12598).
- Release workflow: tags stage the release on npm through trusted publishing, with provenance.

Versions 0.1.0 to 0.1.4 were tagged on GitHub only.
