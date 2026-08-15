# Feature K — Session detail (drill-in) + richer run capture

Branch: `session/feat-sessions-detail`. Status: complete, ready for review.

The Sessions LIST already shipped at `/agents/sessions` (Wave 4 M3). This branch adds the
drill-in behind each row — the run's captured timeline (messages + tool calls with rendered
args → results), its touched files, counts, tokens/cost, live-follow and steering — plus the
richer run capture that makes such a timeline possible in the first place.

## What shipped

### 1. Richer run capture (`packages/agent`)

`agent_run_logs` gains no columns — everything rides the existing `simple-json` `metadata`
column, so there is **no migration in this PR**.

- `src/agents/run-capture.ts` (new): pure, bounded helpers.
    - `buildCapturePreview(value, maxChars)` — serialize → **redact (`redactSecrets`) → cap**.
      Redaction runs BEFORE truncation on purpose: a secret straddling the cap boundary must
      not survive as a recognisable prefix. Returns `null` for empty payloads so callers can
      skip the metadata key entirely; never throws (circular payloads degrade to
      `[unserializable payload]`).
    - `extractTouchedFiles(toolName, args)` — the file seam. Only tools whose args carry
      explicit paths are mapped: `commitToRepo` (`files[].path`) and `editAgentFile` (`name`).
      Nothing is inferred from prose. (`openPullRequest` carries no paths; the tool service's
      `editsThisRunByFile` set is keyed `agentId:name`, not a path, so it is not the seam.)
    - Caps: `CAPTURE_PREVIEW_MAX_CHARS` 4096, `CAPTURE_MESSAGE_MAX_CHARS` 8192,
      `CAPTURE_MAX_ENTRIES` 200, `FILES_TOUCHED_CAP` 200.
- `src/agents/agent-run.service.ts` — the tool loop now writes:
    - `tool-invocation` rows with `argsPreview` / `resultPreview` (+ `argsTruncated` /
      `resultTruncated` when capped) and `durationMs`, on all three paths (allow-list miss,
      normal return, thrown tool);
    - `user-message` rows at the opening turn (`context.immediateInput` — the HUMAN's text,
      not `prompt.userMessage`, which also carries the assembled conversation fences and, on
      heartbeats, a machine preamble) and for every injected steering message;
    - `assistant-message` rows for each round's assistant text;
    - one `capture-truncated` marker row once the 200-entry window is exhausted, after which
      message rows stop and tool rows drop their previews but keep their pre-existing shape.
    - `workspaceMeta.filesTouched` is persisted in a `finally`, so a run that died mid-loop
      still reports what it already touched.
    - **Every** capture path is try/catch'd and `.catch(() => undefined)`'d: capture is
      observability, the run is the product. `mergeFilesTouched` is additionally
      feature-detected (older RPC proxies / partial repository doubles do not have it).
- `src/database/repositories/agent-run.repository.ts` — `mergeFilesTouched(runId, paths, cap)`:
  dedupes, preserves insertion order and the workspace-provision audit already on the JSON,
  skips the write when nothing new arrived.
- `src/database/repositories/agent-run-log.repository.ts` — `countByRunSteps` and
  `findTimelineByRun` (keyset cursor on `(createdAt, id)`; `createdAt` alone is not unique —
  one tool round appends several rows per millisecond). Served by the existing
  `idx_agent_run_logs_run_created` index.
- `src/entities/agent-run.entity.ts` — `workspaceMeta.filesTouched?: string[]`; the provision
  fields became optional at the TYPE level because `filesTouched` can be merged onto runs that
  never provisioned an isolated workspace. Column type unchanged.

### 2. API (`apps/api`)

`GET /api/agents/runs/:runId/detail` → `{ run, counts, filesTouched, timeline }`.

- Addressed by **runId alone** under the literal `runs` segment (declared before every `:id`
  route, so it never reaches `ParseUUIDPipe` as an agent id). This deviates from the brief's
  `:id/runs/:runId/detail` on purpose: the caller — `/agents/sessions` — holds run ids, not
  agent ids, and `findByIdAndUser` already scopes by the acting user. A cross-user or unknown
  runId is a **404**, never a 403 (no existence leak).
- `run` is `toSessionRow(...)` — the projection factored out of `listRunSessions` so the list
  and the detail can never drift on a field — plus `chatMessageId` / `memorySessionId`.
- `counts.filesTouched` prefers the captured path list and falls back to the workspace-diff
  rollup `changedFilesCount`.
- `timeline` is one cursor page (`SessionDetailQueryDto`: `limit` 1..200 default 100, `cursor`
  the opaque `<epochMillis>_<uuid>` token from the previous `nextCursor`, regex-validated so a
  garbage cursor is a 400 rather than a silent restart).
- The step-name lists are local literals in the controller (`SESSION_TIMELINE_STEPS`) rather
  than imports: several api-side specs `jest.mock('@ever-works/agent/agents')` with explicit
  export lists, so a runtime value imported from that barrel would arrive `undefined` there.
  Renaming a step means touching both sides — `run-capture.ts` carries the reciprocal note.

### 3. Web (`apps/web`)

- Route `/agents/sessions/[runId]` (`ROUTES.DASHBOARD_AGENT_SESSION`). The server page resolves
  agent name + task title defensively (a hard-deleted agent degrades to a short-id label) and
  `notFound()`s when the API refuses.
- `SessionDetailClient` — header (status/runner/gate chips, started + duration, task link,
  "Open terminal" when `sessionAttachable`, Refresh), the messages / tool calls / files /
  tokens / cost chip row, a collapsible touched-files list, and the timeline: message bubbles
  plus `> tool · args → result` collapsible monospace rows. Every preview is rendered as a
  TEXT node — the server redacts and caps, the client never interprets it as markup.
- Live-follow: `use-session-detail-polling.ts`, 5s, only while the run is open or awaiting
  input (a terminal run costs zero requests). The poll follows from the last row on screen and
  appends (deduped on id). **Mid-pagination it refreshes only the header/chips/files and leaves
  the timeline alone** — replacing it with page one would discard the reader's "Load more"
  clicks every 5 seconds. The one exception is an **empty** timeline: there is no row to follow
  from and nothing to preserve, so page one is adopted — a run opened before its first capture
  row landed (a queued run, the likeliest drill-in moment) must still fill in.
- Tool-row durations render at ms resolution below a second (`formatToolDuration`); the
  run-scale formatter's smallest unit is a whole second, which collapsed every fast tool call
  to "0s".
- Steering: steer input + interrupt/cancel, reusing the existing server actions.
- Each `/agents/sessions` row body now links here; the Attach link stays a sibling so the two
  targets never nest.
- i18n: `dashboard.agentsPage.sessions.detail.*` added to all 21 locale files (English copy in
  every file, per convention).

## Tests

| Command                                                                                               | Covers                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd packages/agent && npx jest --testPathPattern='run-capture'`                                       | preview build/redact/cap table; loop-level capture (previews, turn rows, cap + single marker, swallowed failures, filesTouched)                                |
| `cd packages/agent && npx jest --testPathPattern='(agent-run-log.timeline\|agent-run.files-touched)'` | the three new repository methods (keyset cursor, empty-step short-circuit, merge/dedupe/cap)                                                                   |
| `cd apps/api && npx jest --testPathPattern='agents'`                                                  | detail composition, counts, pagination handshake, marker rows, cross-user 404                                                                                  |
| `cd apps/web && npx vitest run src/components/agents/SessionDetailClient.unit.spec.tsx`               | chips/files/timeline render, append-not-replace pagination, live-follow + dedupe, mid-pagination guard, terminal run does not poll, steering + error surfacing |
| `apps/web/e2e/flow-run-sessions-steering-contract.spec.ts`                                            | API contract for the detail route (shape, 404 authz, 400 paging, 401) — needs a live stack                                                                     |
| `apps/web/e2e/api-public-contract.spec.ts`                                                            | the route is in the unauth-401 tripwire list                                                                                                                   |

Type-check + build: `packages/agent` (`tsc -p tsconfig.types.json`), `apps/api`
(`tsc -p tsconfig.build.json`), `apps/web` (`tsc --noEmit`), and
`turbo build --filter=ever-works-api...` / `--filter=ever-works-web...` all pass.

## Known follow-ups (out of scope here)

- Tool `resultPreview` is not captured on the thrown-tool path (the redacted throw message is
  the row's `message` instead).
- The capture window is per tool-loop invocation; a re-entered run (red-gate iterate) starts a
  fresh 200-entry window.
- The timeline has no filter/search and no jump-to-latest; long sessions page with "Load more".
- `apps/api` full `tsc -p tsconfig.json` (specs included) reports 4 PRE-EXISTING errors
  unrelated to this branch — `@ever-works/k8s-plugin` is not built in a plain worktree, and
  `packages/agent`'s `@src/*` aliases do not resolve from outside that package. CI's actual
  gate (`tsconfig.build.json`) is clean.
