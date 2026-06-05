# Knowledge Base — Phase 3 implementation notes (EW-643)

**Status**: `In progress`
**Branch**: `session/ew639-phase3`
**Tracks**: [EW-639](https://evertech.atlassian.net/browse/EW-639) (epic),
[EW-643](https://evertech.atlassian.net/browse/EW-643) (Phase 3).
**See also**: [spec.md](spec.md) · [tasks.md](tasks.md) ·
[acceptance.md](acceptance.md).

## Why this file exists

`tasks.md` is the human-facing checklist, and `acceptance.md` is the
acceptance gate. This file is the engineer-facing notebook for the
Phase 3 PR series — what is shipping in each slice, the contracts that
new code lands behind, and the deliberate scope cuts. It belongs in
`docs/specs/features/knowledge-base/` because it is feature-scoped (per
the platform's CLAUDE.md "no stray docs in root" rule), and it stays
indexed alongside the rest of the KB spec.

## Slice 1 — contracts (this PR)

Lands the **contracts and emitter surface** that the remaining Phase 3
slices will plug into. No user-visible behaviour changes; every change
is additive and gated by capability detection or by an explicit
opt-in.

### What ships

| Area                          | Path                                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcribe(file)` capability | `packages/plugin/src/contracts/capabilities/ai-provider.interface.ts` | Optional method on `IAiProviderPlugin`. New `TranscriptionOptions` + `TranscriptionResponse` + `TranscriptionSegment` types. Plugins that don't implement it leave the field `undefined` and `AiFacadeService.transcribe()` (next slice) falls through to the next available provider.                                                                                                                |
| OpenAI Whisper impl           | `packages/plugins/openai/src/openai.plugin.ts`                        | Wraps `/v1/audio/transcriptions` directly with `fetch` + `FormData` to avoid the heavy `openai` SDK dependency. New `transcriptionModel` setting (default `whisper-1`, env override `OPENAI_TRANSCRIPTION_MODEL`).                                                                                                                                                                                    |
| Activity-log lock events      | `packages/agent/src/entities/activity-log.types.ts`                   | Adds `KB_DOCUMENT_LOCKED`, `KB_DOCUMENT_UNLOCKED`, `KB_DOCUMENT_RESTORED`, `KB_DOCUMENT_LOCK_VIOLATION`, `KB_RECONCILE_COMPLETED`, `KB_UPLOAD_TOMBSTONED`, `KB_UPLOAD_REVIVED`, `KB_CONTEXT_TRUNCATED`, `KB_UPLOAD_TRANSCRIBED`, `KB_UPLOAD_TRANSCRIPTION_FAILED`. Storage is `varchar` (no enum migration needed); API/service layer is the source of allowed strings.                               |
| Typed PostHog event surface   | `packages/monitoring/src/posthog/kb-events.ts` (new)                  | One module enumerating every KB-related telemetry event with its property type. Includes a defensive scrubber that strips body-ish properties (`body`, `content`, `markdown`, `text`, `html`, `excerpt`, `snippet`, `chunk`, `raw`, `preview`). In `NODE_ENV=test` the scrubber throws so unit tests can assert the gate; in `production` it strips silently to keep telemetry call sites zero-throw. |
| Static CI gate                | `scripts/ci/no-kb-body-in-events.sh` (new)                            | Greps every PostHog / activity-log / `emitKbEvent` call site within a tight scope (`apps/api`, `apps/web`, `apps/mcp`, `apps/cli`, `packages/agent`, `packages/tasks`) and looks for forbidden property keys near each emit. Whitelist comment: `// kb-events-allow: <reason>`.                                                                                                                       |
| Vitest spec                   | `packages/monitoring/src/posthog/__tests__/kb-events.spec.ts`         | Asserts forward path, no-op on null client, scrubber throws in test mode, and the forbidden-key list exists for the gate.                                                                                                                                                                                                                                                                             |

### What is _not_ in this slice

The audit in the parent session named these as the heaviest remaining
Phase 3 deliverables. They land in follow-up slices on the same
`session/ew639-phase3*` branch family to keep this PR's blast radius
small and reviewable:

- **ffmpeg-backed video → MP4 + audio → MP3 normalization tasks**
  (`packages/tasks/src/tasks/trigger/kb-normalize-video.ts`,
  `kb-normalize-audio.ts`). Blocks A28 + A29.
- **`AiFacadeService.transcribe()`** that selects the right provider
  per the chain documented on the interface (operator pin →
  capability-available → fallback throw). Wires the new
  `transcribe()` capability into the KB ingest pipeline. Blocks A28 +
  A29.
- **MCP `kb` namespace** (`apps/mcp/src/tools/kb/`). One tool file per
  REST endpoint — `kb.list`, `kb.read`, `kb.search`, `kb.create`,
  `kb.update`, `kb.upload`. Blocks A32.
- **CLI `ever works kb` subcommand group** (`apps/cli/src/commands/kb/`).
  Mirrors the MCP surface. Blocks A33.
- **Embedded-app outputs viewer** — sandboxed iframe for
  `outputs/<slug>/index.html` agent-authored bundles. Web-side. Blocks
  A30 + A31.
- **Daily reconciliation Trigger.dev task**
  (`packages/tasks/src/tasks/trigger/kb-reconcile.ts`) +
  `KbReconcileService`. Blocks A24 (lock-violation surfacing), A35
  (drift), A36 (orphan tombstones + 7-day grace).
- **Wikilink resolver + rename rewriter** in the document mutation
  pipeline. Blocks A34.

### Configuration knobs (env)

| Env var                        | Effect                                                                                                                                                                                                                                                           | Default                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `OPENAI_TRANSCRIPTION_MODEL`   | Whisper model the OpenAI plugin uses. `whisper-1` is cheapest at $0.006/min; `gpt-4o-transcribe` is higher accuracy on noisy audio at higher cost.                                                                                                               | `whisper-1`               |
| `KB_TRANSCRIPTION_PROVIDER_ID` | Operator-pinned transcription provider for `AiFacadeService.transcribe()`. When set, only this provider is tried; on failure the call throws (no silent fallback). Useful when audit requires sticking to a specific compliance-cleared vendor. Read in slice 2. | _unset_ → first available |

## How the slice fits the modular plugin design

The user's brief asked for a modular, plugin-friendly design. This
slice keeps that contract:

1. **No KB-specific code lives inside `packages/plugin`.** The
   `transcribe` capability is generic speech-to-text — the same shape
   any voice-note feature would need. KB consumes it via the facade.
2. **Per-provider impl lives in the plugin package**, not in the
   monorepo's core. Other AI-provider plugins (Anthropic, Groq,
   Google) can ship Whisper-equivalents in their own packages without
   any core changes.
3. **Telemetry events live in `packages/monitoring`** so the web,
   API, MCP, CLI, and worker layers can all import the same typed
   surface. The scrubber guarantees no KB body content leaks
   regardless of which layer emits.
4. **The CI gate is a standalone script**, not coupled to any one
   framework. It runs in CI, in pre-commit if desired, or ad-hoc.

## How to verify locally

```bash
# From the repo root of your local clone:

# 1) Type-check the touched packages
pnpm --filter @ever-works/plugin type-check
pnpm --filter @ever-works/monitoring type-check
pnpm --filter @ever-works/agent type-check
pnpm --filter '@ever-works/plugin-openai' type-check  # or whichever plugin id

# 2) Run the new tests
pnpm --filter @ever-works/monitoring test -- kb-events

# 3) Run the static CI gate against the repo
bash scripts/ci/no-kb-body-in-events.sh .
```
