# FL-05 — Session status, attention & board · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths and a **Test** line (Constitution VI). Work top to bottom; tasks marked `(parallel)` may run alongside the task immediately above them.

**Epic ID:** `FL-05-session-status-board`
**Spec:** [`./spec.md`](./spec.md) · **Plan:** [`./plan.md`](./plan.md)
**Status:** `Draft`
**Last updated:** 2026-10-18

---

## How to use

- Paths are repo-relative to the monorepo root; run everything with `pnpm` from the root unless said otherwise.
- Migrations are **authored** from `apps/api/`; the API self-applies them on boot. The timestamp is the FL-05 slot (CONTRACTS §13); re-stamp before merge if `develop` moved.
- Runners: `packages/contracts`, `apps/node`, `apps/web` unit, `apps/cli` → **Vitest**; `packages/agent`, `apps/api` → **Jest**; `apps/web` e2e → **Playwright**.
- Prerequisites: FL-04 merged (daemon, launcher with the `hookOverlayFor` seam, link bridge, detail page, `SessionCard` compact layout), FL-01 merged (needs-a-look registry, hub tabs), FL-02 merged (link control messages).
- Before every PR: run the program's reference-tool name check over `docs apps packages` (README §7 rule 16 — the tools that informed this design are never named in this repository); it must print nothing.
- Add tasks at the bottom; never renumber. Commit style `feat(fleet-sessions): …`, `test(fleet-sessions): …`, `chore(i18n): …`.

---

# PHASE 1 — The status pipeline

## P1.A — Contracts and schema

- [ ] **T-01**. Extend `packages/contracts/src/fleet/fleet-sessions.types.ts` with `FleetSessionAttention`, `FleetSessionAttentionReason`, `FleetSessionEvidence`, `FleetSessionHookEvent` (normalised Claude and Codex shapes), `FleetSessionStateUpdate`, the pure `mergeEvidence(prev, evidence)` and `attentionKey(sessionId, reason, promptId)`, and the constants `FLEET_SESSION_IDLE_AFTER_MS`, `FLEET_SESSION_RULE_QUIET_MS`, `FLEET_SESSION_BOUNDARY_MS`, `FLEET_SESSION_NOTIFY_DEDUPE_MS`, `FLEET_SESSION_DONE_BOARD_HOURS`.
    - **Test**: `packages/contracts/src/fleet/__tests__/fleet-session-evidence.spec.ts` — precedence table (hook > structured > rule > exit; a lower source never overrides a higher one newer than 10 s), idle at 30 min ± 1 ms, every CONTRACTS §5.1 transition, boundary window, shell never `needs_you|done`, exit outcomes `success|failure|unconfirmed`.
- [ ] **T-02** (parallel). Add `packages/contracts/src/fleet/fleet-session-rules.types.ts` (`FleetSessionRulesFile` + `isFleetSessionRulesFile` guard: every rule needs `id`, `when`, `then`, `why`; `then.state` may not be `done`); add the link messages `session.status`, `session.attention` (node → platform) and the `session.answer` request/reply shapes to FL-02's `packages/contracts/src/fleet/fleet-link.types.ts`.
    - **Test**: `packages/contracts/src/fleet/__tests__/fleet-session-rules.spec.ts` — a rule without `why` is refused; `then.state: 'done'` is refused; the link guards reject unknown events.
- [ ] **T-03** (parallel). `packages/contracts/src/inbox/inbox.types.ts`: add `'fleet-session'` to `InboxItemSourceType` and `INBOX_ITEM_SOURCE_TYPES` (`:32-41`); add `sessionId`, `sessionTitle`, `provider`, `attentionKey` to `INBOX_SOURCE_META_FIELDS` (`:64`).
    - **Test**: extend `packages/contracts/src/inbox/__tests__/inbox.spec.ts` — the guard accepts the new source; meta fields round-trip.
- [ ] **T-04**. Add to `packages/agent/src/entities/fleet-session.entity.ts` exactly the five CONTRACTS §4.2 FL-05 columns: `attention simple-json?` (`{ key, reason, prompt, options[], raisedAt, acknowledgedAt }`), `stateChangedAt`, `hooks simple-json?` (`{ provider, injected, events[] }`), `lastEvidence simple-json?` (`{ source: 'hook'|'structured'|'rules'|'exit', at, detail }`), `boundaryUntil?`; indexes `(userId, state, stateChangedAt)`, `(organizationId, state, stateChangedAt)`. Author the migration from `apps/api/`: `pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/AddFleetSessionAttention` → `apps/api/src/migrations/1796050000000-AddFleetSessionAttention.ts`. Hand-check: five `ADD COLUMN`, two indexes, no drops.
    - **Test**: applies twice cleanly; empty diff afterwards; the entity spec from FL-04 extended for the new columns' doc comments.

## P1.B — Node: endpoint, file, scripts, spool

- [ ] **T-05**. Write `apps/node/src/core/sessions/hook-endpoint.ts`: `http.createServer` on `127.0.0.1:0`, token minted per start (`randomBytes(32).toString('hex')`), routes `POST /hook/claude` and `/hook/codex`, token header checked **before** the body is read, peer address re-checked against loopback, body ≤ 64 KiB, `204` always, counters (`ok`, `badToken`, `unknownSession`, `malformed`), emits normalised `FleetSessionHookEvent`s with a per-session sequence; the session id comes from `X-Ever-Works-Session`.
    - **Test**: `apps/node/src/core/sessions/__tests__/hook-endpoint.spec.ts` — binds loopback only; bad token answered before body (assert the body stream is never consumed); oversize body → `204` + `malformed` counter; unknown session dropped and counted; a valid Claude `PermissionRequest` normalises with tool name and input summary redacted.
- [ ] **T-06**. Write `hook-endpoint-file.ts` (atomic write of `<config dir>/sessions/hook-endpoint.env` and `.cmd` on Windows; owner-only via the node's existing `icacls`/chmod helpers; rewritten at every start; **kept** at shutdown so scripts spool) and `hook-scripts.ts` (materialises `hooks/claude-hook.sh|.cmd`, `hooks/codex-notify.sh|.cmd` 0700 when content changed: source the endpoint file, `curl --connect-timeout 0.5 --max-time 1.5 -X POST` with the three headers and `--data-binary @-`, `node -e` fetch fallback when `curl` is missing, on failure append `{ts, seq, body}` to `spool/<sessionId>.jsonl`, always `exit 0`).
    - **Test**: `__tests__/hook-endpoint-file.spec.ts` (atomic rename, permissions, rewrite per start, present after stop), `__tests__/hook-scripts.spec.ts` (content per OS; executing the script with the endpoint down exits 0 in ≤ 2 s and leaves a spool line; with the endpoint up the event arrives).
- [ ] **T-07**. Write `hook-spool.ts`: drain `spool/*.jsonl` in file order when the endpoint is up; caps 5 MB/file, 1 024 files, 7 days; applied events carry their original sequence so the merger ignores duplicates. Wire endpoint + file + scripts + spool into the FL-04 `daemon-supervisor.ts` start path and report `hooks: { badTokenLastMinute, spooled }` in the heartbeat `daemon` block.
    - **Test**: `__tests__/hook-spool.spec.ts` — order kept, caps enforced, duplicates ignored after drain; heartbeat block present.

## P1.C — Node: overlay, merger, mirrored outcome

- [ ] **T-08**. Write `apps/node/src/core/sessions/hook-overlay.ts` implementing FL-04's `hook-overlay.port.ts`: Claude → `overlays/<sessionId>/settings.json` (0600) with hooks for `SessionStart UserPromptSubmit PermissionRequest PreToolUse(matcher: AskUserQuestion) Stop SessionEnd Notification`, each omitted when `model-cli-compat.ts` says the installed version lacks it, returning `args: ['--settings', path]` and `hooks: { provider, injected: true, events[] }` (the events actually registered); Codex owner → `args: ['-c', 'notify=["<codex-notify script>"]']` (replaces the person's notify for this session only — CONTRACTS R-6); Codex Agent → `files: { 'config.toml': 'notify = [...]' }` for the overlay home; shell → `null`, `hooks: { provider: 'shell', injected: false, events: [] }`. Remove the overlay directory on session end.
    - **Test**: `__tests__/hook-overlay.spec.ts` — overlay JSON per version matrix; Codex argv and file; **a sentinel `~/.claude/settings.json` and `~/.codex/config.toml` in the fixture home are byte-identical after every call**; overlay removed on end.
- [ ] **T-09**. Write `evidence-merger.ts`: per session, apply hook events, daemon `EXIT`/activity and (P2) rule evidence through `mergeEvidence`; 30 min idle timer; send `session.status` and `session.attention` on channel 0 through FL-04's `session-link-bridge.ts`; mark `boundaryUntil` for 5 s after `SessionStart`/resume.
    - **Test**: `__tests__/evidence-merger.spec.ts` — a `Stop` → `done · success`; `UserPromptSubmit` → `working`; `PermissionRequest` → `needs_you (permission)` with a key; exit 1 while working → `failure` then `ended`; 30 min silence → `idle`; a late lower-precedence event never overrides; messages emitted once per change.
- [ ] **T-10**. Platform: write `packages/agent/src/fleet/sessions/fleet-session-state.service.ts` — applies `session.status`/`session.attention` idempotently by sequence, writes `state`, `outcome`, `stateChangedAt`, `hooks`, `lastEvidence`, mirrors `outcome` into the Agent session's Run on `ended` (`AgentRun.status` completed/failed/cancelled), and emits `fleet.session.changed` on the FL-02 relay bus; register in FL-04's `apps/api/src/fleet-link/families/session.family.ts`.
    - **Test**: `packages/agent/src/fleet/sessions/__tests__/fleet-session-state.service.spec.ts` — idempotent by seq; Run mirroring per outcome; bus event per change; `family` spec extended.
- [ ] **T-11**. Add `packages/tasks/src/tasks/trigger/fleet-session-status-sweeper.task.ts` (cron `6/5 * * * *`, registered with `TriggerInternalModule`): idle decay floor, reconcile `needs_you` whose node-side attention cleared, mark done cards older than 24 h as off-board, expire the Decision of an `ended` session and mark one unanswered for 24 h stale — never auto-answered (CONTRACTS R-12, spec FR-27a).
    - **Test**: `packages/tasks/src/__tests__/fleet-session-status-sweeper.task.spec.ts` — each branch; never ends a session; never answers a Decision; idempotent across overlapping ticks.

## P1.D — Web: the completed card and status notes

- [ ] **T-12**. Complete `apps/web/src/components/fleet/sessions/SessionCard.tsx` to the CONTRACTS §4.8 anatomy: header (who icon · title · `SessionStateGlyph`), body (last user line / last agent line 2-line clamp, or `SessionAttentionBox`), footer — the CONTRACTS §4.8 named slots in order: `computer` · `gitLine` (FL-06) · `prPill` (FL-06) · `taskChip` (FL-15) · `elapsed` (since finish when done, else since start) · `cost` (FL-20) · `cleanUp` (FL-06), each an exported slot other epics fill (R-22) and empty renders nothing; tint warm for `needs_you`, green for `done · success`; unread = bold title; status-source note. Add `SessionStateGlyph.tsx` (spinner ring / question bubble / red dot / green check / muted dot / dashed ring / grey dot / none) and `sessions-status.shared.ts` (pure: glyph map, tint rule, elapsed rule, wording templates, dedupe/boundary helpers, option key hints).
    - **Test**: `SessionCard.unit.spec.tsx` (every state × outcome renders the right glyph, tint and words; colour never the only carrier), `sessions-status.shared.unit.spec.ts`.
- [ ] **T-13**. Add the status-source note and hook health to the FL-04 detail header (`SessionHeader.tsx`) and the computer page Overview (`fleet.sessions.statusSource.*`, `fleet.sessions.hookHealth.*`); hook health is read from the heartbeat `daemon.hooks` counters on the node view (`GET /nodes/:id`) — no route of its own (CONTRACTS §11.2).
    - **Test**: node view mapping spec extended (counters present when the node sends them); `SessionHeader.unit.spec.tsx` — note per `hooks { injected, events }` and provider.
- [ ] **T-14**. i18n: add `fleet.sessions.states`, `fleet.sessions.card`, `fleet.sessions.statusSource`, `fleet.sessions.hookHealth` to `apps/web/messages/en.json` (camelCase leaves, no literal `.`).
    - **Test**: the dotted-key count is unchanged; no literal strings in the new components.
- [ ] **T-15**. Write `apps/web/e2e/flow-fleet-sessions-status.spec.ts` — with a stubbed node posting hook events: working → needs you → done → idle, glyphs and words, status-source note, hook-health row after 20 bad tokens.
    - **Test**: green locally and in CI; FL-04 suites unchanged.

---

# PHASE 2 — Attention, decisions, cards, rules, notifications

## P2.A — Attention and the Decision

- [ ] **T-16**. Extend `packages/agent/src/inbox/inbox-producer.port.ts` with `sessionAttentionRaised(input: { userId, sessionId, agentId?, attention, sourceMeta })` → one item (kind `approval` for `permission`, `question` for `question`, `notice` for `blocked|failed`) keyed by `attentionKey` (update, never duplicate), and `sessionAttentionCleared({ attentionKey, clearedBy, answer? })` → close the item; implement in `packages/agent/src/inbox/inbox.service.ts` with `sourceType: 'fleet-session'`, options from `HitlChoiceOption[]`; route `POST /api/inbox/:id/reply` for `fleet-session` items to `FleetSessionService.answer` (beside the `fleet-run` branch, `inbox.service.ts:151-161`).
    - **Test**: `packages/agent/src/inbox/__tests__/inbox.service.session.spec.ts` — one item per key; second raise updates; clear closes with the answerer; reply routes to the session; `fleet-run` behaviour byte-identical.
- [ ] **T-17**. Add attention handling to `packages/agent/src/fleet/sessions/fleet-session-state.service.ts`: on `session.attention` raise → persist (`attention`, `stateChangedAt`), call the Inbox producer (T-16), raise the needs-a-look row (T-20), notify (T-23); on clear → close everything by key; `acknowledge(key)` sets `acknowledgedAt`; `answer(key, answer, requester, source)` → audience check, Agent-on-permission refusal, stale-key `invalid`, kill-switch `kill_switch`, link `session.answer`, audit `node.session.answer` with `optionId` and never free text.
    - **Test**: `fleet-session-state.service.spec.ts` extended — ack semantics (`acknowledgedAt < raisedAt` = unread; the same key never re-flags); every refusal code; the audit row carries no free text; a clear by any door closes the Inbox item once.
- [ ] **T-17a**. Routes in `apps/api/src/fleet/sessions/fleet-sessions.controller.ts`, CONTRACTS §11.2 paths only: `POST /sessions/:id/answer` (DTO `AnswerFleetSessionDto { key @IsString(), optionId? @IsString() @MaxLength(64), text? @MaxLength(4000) }`, throttle 60/min/user); `GET /sessions/:id` (FL-04) widened to carry `attention`, `stateChangedAt`, `hooks`, `lastEvidence`; `PATCH /sessions/:id` (FL-04) widened with `{ acknowledge: key }`; the Inbox reply branch in `apps/api/src/inbox/inbox.controller.ts` (`:178`) for `fleet-session` items.
    - **Test**: controller spec extended — audience matrix owner/org-admin/org-member/stranger; Agent on a permission prompt → `permission_denied` with the hint; Agent on another session's question with "may answer other sessions" off → `permission_denied` (R-32); `text` where not allowed → `invalid`; acknowledge of a stale key → `invalid`; throttle present; Inbox reply reaches the session service.
- [ ] **T-18**. Node: write `apps/node/src/core/sessions/answer-typist.ts` — `session.answer` → keys per provider and prompt kind (Claude permission: option digit + `\r`, Deny `\x1b`; question: digit + `\r` or text + `\r`; Codex approval `y`/`n` + `\r`; rule-raised: the rule's `answerKeys`) → daemon input; refuses `invalid "Already answered"` when the key is not the current attention; clears node-side attention and emits `session.attention null`.
    - **Test**: `__tests__/answer-typist.spec.ts` — keys per matrix; stale key refused; blocked input (kill switch) refused and the attention kept.
- [ ] **T-19**. Web — the cards: `apps/web/src/components/fleet/sessions/SessionAttentionBox.tsx` (card-embedded: prompt, numbered options, Allow/Deny, free text where allowed; digit and A/D shortcuts on a focused card), `SessionApprovalCard.tsx` and `SessionQuestionCard.tsx` (detail; replace `SessionComposer` while pending and restore on clear; first option primary; Esc = Deny on approval, Esc = keep on question; "Already answered", unreachable and kill-switch variants with disabled buttons).
    - **Test**: `SessionApprovalCard.unit.spec.tsx`, `SessionQuestionCard.unit.spec.tsx`, `SessionAttentionBox.unit.spec.tsx` — shortcuts, Esc behaviours, composer swap, disabled under kill switch, every refusal variant renders its sentence.
- [ ] **T-19a** (parallel). Web — plumbing: BFF `apps/web/src/app/api/fleet/sessions/[id]/answer/route.ts` (acknowledge and attention go through FL-04's `…/[id]/route.ts` `PATCH` / `GET`); `apps/web/src/lib/api/fleet-sessions.ts` gains `answer`, `acknowledge`; the detail acknowledges on open and suppresses the in-app toast for that session while open; `apps/web/src/components/inbox/InboxSessionSource.tsx` ("From a session" chip + provenance) beside `InboxFleetSource.tsx`, and `isSessionAttention(item)` in `apps/web/src/lib/api/inbox.shared.ts`.
    - **Test**: `fleet-sessions.unit.spec.ts` extended (envelopes pass through), `InboxSessionSource.unit.spec.tsx` (renders only for `fleet-session`; text never markup), detail spec extended (acknowledge on open; toast suppressed).
- [ ] **T-20**. Add `packages/agent/src/fleet/needs-a-look/producers/session-needs-you.producer.ts` registered under FL-01's `NEEDS_A_LOOK_PRODUCERS`: one row per `needs_you` session (kind `session-needs-you`, `severity: 'warn'`, title `"<who> waiting for you on <computer> · <prompt>"`, action **Answer** → detail with the card focused) and one row per Node with `unconfirmed` endings in the last hour (kind `session-needs-you`, `severity: 'info'`, action **Open** — spec §8b default until CONTRACTS §4.6 names a kind).
    - **Test**: `packages/agent/src/fleet/needs-a-look/producers/__tests__/session-needs-you.producer.spec.ts` — rows per shape, exactly the §4.6 item fields; cleared when attention clears.

## P2.B — Rules engine

- [ ] **T-21**. Write `apps/node/src/core/sessions/rules/claude-code.json`, `codex.json`, `shell.json` (empty rules) with anchors and rules over `screen|tail|title`, every rule with a `why` and `answerKeys`; `rules-engine.ts` loads and validates at node start (fail start naming the rule id on an invalid file), evaluates every 2 s per session with no hook evidence in 10 s against the daemon's `screen { lines: 40 }` and title, emits `FleetSessionEvidence { source: 'rules' }` (CONTRACTS §4.2 value); may raise `needs_you (permission|question|blocked)`, `working`, `idle (weak)` — never `done`.
    - **Test**: `__tests__/rules-engine.spec.ts` against captured fixtures `apps/node/src/core/sessions/__fixtures__/transcripts/{codex-approval,codex-plan-menu,claude-permission,claude-trust-folder,claude-update-prompt}.txt` — expected state/reason per fixture; a quiet-time rule waits; no rule yields `done`; invalid file fails validation with the id.
- [ ] **T-22**. Wire rule evidence into `evidence-merger.ts` (lower than hooks; 10 s guard) and the "from the screen" note from `lastEvidence.source === 'rules'`.
    - **Test**: `evidence-merger.spec.ts` extended — a rule never overrides a hook newer than 10 s; a rule-raised attention carries `answerKeys`.

## P2.C — Notifications and tools

- [ ] **T-23**. Append `fleet_session_needs_you`, `fleet_session_finished`, `fleet_session_failed` to `packages/agent/src/notifications/core-event-catalogue.ts` (after `fleet_runner_fallback`, `:199`) and add `notifyFleetSessionNeedsYou|Finished|Failed` to `packages/agent/src/notifications/notification.service.ts` with the wording templates, per-subject 5 s dedupe, the boundary rule (no notification for a done inside `boundaryUntil` with no prompt), silence for `interrupted|cancelled` and for shell sessions, and the action URL to the detail; the in-app toast is suppressed client-side while the detail of that session is open.
    - **Test**: `packages/agent/src/notifications/__tests__/notification.service.fleet-session.spec.ts` — wording per state/outcome; a stop and an exit 1 s apart → one; boundary → none; interrupted → none; shell → none; fanout event emitted once.
- [ ] **T-24**. Agent tools in `packages/agent/src/fleet/agent-fleet-session-tools.ts`: `fleet_sessions_question` (readOnly) and `fleet_sessions_answer` (destructive: false, `confirmationClass: 'confirm'` — FL-19 catalogue §9.1; `permission` reasons refused `permission_denied` with the hint; another session's question only with the Agent's "may answer other sessions" setting on — CONTRACTS R-32; AW-15 grant + audience); MCP whitelist entries in `apps/mcp/src/openapi-tools/whitelist.ts`; CLI `apps/cli/src/commands/fleet/session/question.ts`, `answer.ts`.
    - **Test**: `packages/agent/src/fleet/__tests__/agent-fleet-session-tools.spec.ts` extended (permission refusal unconditional); CLI specs `apps/cli/src/commands/fleet/__tests__/session-answer.spec.ts` (exit codes, `--json`).
- [ ] **T-25**. i18n: `fleet.sessions.attention`, `fleet.sessions.notifications`, `dashboard.inbox.sessionSource`, `fleet.errors.*` additions.
    - **Test**: dotted-key count unchanged; no literals.
- [ ] **T-26**. E2E `apps/web/e2e/flow-fleet-sessions-attention.spec.ts` (permission → card → Allow clears everywhere; question with free text; stale second answer refused; kill switch disables) and `flow-fleet-sessions-decisions.spec.ts` (My Decisions shows the item with the session chip; Deny there reaches the session; the Decision records the answerer).
    - **Test**: both green; `flow-inbox-decisions.spec.ts` and `flow-notifications-inbox-deep.spec.ts` unchanged and green.

---

# PHASE 3 — Board, lists, palette

- [ ] **T-27**. Add `'sessions'` to `ACTIVITY_VIEWS` and `n` to `ACTIVITY_VIEW_KEYS` in `apps/web/src/app/[locale]/(dashboard)/activity/activity-views.ts` (`:20,36-41`); add `DASHBOARD_ACTIVITY_SESSIONS` to `apps/web/src/lib/constants.ts` (beside `:119-123`; `DASHBOARD_FLEET_SESSIONS` is FL-01's and is reused); server-render the board/list first page in `activity/page.tsx` (`:84-128` batch) via `fleetSessionsAPI.board|list`; add the toggle entry in `activity-client.tsx` (`:630`) and mount `SessionsBoardClient`.
    - **Test**: `activity-views.unit.spec.ts` — view and key present; the page renders the board without a client fetch on first paint.
- [ ] **T-28**. API: extend `GET /sessions` in the controller with `view=board|list`, filters (`state agentId nodeId kind`), `g=day|week` + `date` for the list, cursor paging, and the audience filter per Node; `board` returns the four columns ordered by `stateChangedAt desc` with `done` limited to 24 h; the BFF is FL-04's `apps/web/src/app/api/fleet/sessions/route.ts` passing `?view=board` through.
    - **Test**: controller spec extended — ordering, 24 h rule, audience filter hides foreign Nodes' sessions, filters reproduce from the query string.
- [ ] **T-29**. Web — the board: `apps/web/src/components/fleet/sessions/SessionsBoardClient.tsx` (polling at `RUNS_POLL_INTERVAL_MS` plus the relay-bus `fleet.session.changed` event when present; URL-bound view and filters), `SessionsBoard.tsx` (four columns, counts in headers, per-column empties, view-transition moves keyed by session id, polite live-region announcement of a move), `SessionsEmptyState.tsx`.
    - **Test**: `SessionsBoard.unit.spec.tsx` — columns, most-recently-moved order, counts, empties, tint rule, a state change re-homes the card; `SessionsBoardClient.unit.spec.tsx` — poll + event both refresh; URL round-trip of `view`.
- [ ] **T-29a** (parallel). Web — the list and filters: `SessionsList.tsx` (groups by Agent × day/week using `parseRunsViewState` / `stepAnchorDate` from `apps/web/src/components/runs/runs.shared.ts:63-157`; ended sessions with their reason; **Answer** inline for `needs_you`), `SessionsFilters.tsx` (Agent, computer, kind, state; written to the address bar).
    - **Test**: `SessionsList.unit.spec.tsx` (grouping, ended reasons, inline Answer), `SessionsFilters.unit.spec.tsx` (URL round-trip; a shared link reproduces the view).
- [ ] **T-30**. Fleet → Sessions: register `SessionsByComputer.tsx` with `registerHubTab('sessions', …)` in `apps/web/src/components/fleet/registry.ts` (FL-01 owns the route file `fleet/sessions/page.tsx`; this task adds no page file), `SessionsByComputer.tsx` (groups by Node with online state and consents; **New session ▾** per online Node; FL-04's `SessionsTab` becomes this view filtered to one Node).
    - **Test**: `SessionsByComputer.unit.spec.tsx` — groups, consent chips, offline group with ended sessions, "Agents need work switched on here" line.
- [ ] **T-31**. Palette: add the `fleet-session` record kind to `apps/web/src/components/command-palette/registry/kinds.ts`; in `sections.ts` (`buildPaletteSections`, `:411`) build a **Needs you** section first on an empty query when any session is waiting (newest first, digit shortcuts 1–6), then recent sessions ordered done → idle within Recent.
    - **Test**: `sections.unit.spec.ts` extended — Needs you first; shortcuts; ordering; absent when nothing waits.
- [ ] **T-32**. i18n: `fleet.sessions.board`, `fleet.sessions.list`, `fleet.sessions.byComputer`, `fleet.sessions.palette`, `dashboard.activity.viewToggle.sessions`.
    - **Test**: dotted-key count unchanged; no literals.
- [ ] **T-33**. E2E `apps/web/e2e/flow-fleet-sessions-board.spec.ts` (four columns, move on state change within 5 s, list grouping, filters in the URL, Fleet → Sessions groups, palette section) and `flow-fleet-sessions-a11y-board.spec.ts` (keyboard-only: `n`, card focus, digit and A/D shortcuts, axe pass).
    - **Test**: both green; `runs-ledger.spec.ts` and `flow-agent-runs-*.spec.ts` unchanged and green.

---

# PHASE 4 — Docs and rollout

- [ ] **T-34**. Write `docs/features/fleet-session-status.md` (the four states, outcome, hooks-first with the overlay rule, attention and Decisions, notifications and the boundary rule, the board and Fleet → Sessions) and list it in `apps/docs/sidebarsPlatform.ts` beside `features/fleet` (`:183`); cross-link from `docs/features/inbox.md`, `docs/features/activity.md` and `docs/features/fleet-sessions.md` (FL-04).
    - **Test**: `pnpm --filter ever-works-docs build` has no broken-link warning.
- [ ] **T-35**. Update `docs/specs/features/fleet/TRACKER.md` (FL-05 impl per phase); no plugin doc change.
    - **Test**: the row links to this folder.
- [ ] **T-36**. Confirm `FLEET_SESSIONS_ENABLED` gates every new route, the Activity view, the hub tab and the palette section; with the flag off `/activity?view=sessions` falls back to `log` and the hub tab is absent.
    - **Test**: flag-off and flag-on runs of the contract and board e2e.
- [ ] **T-37**. Run `pnpm format && pnpm lint && pnpm test && pnpm build`, the banned-terms grep, and the node conformance spec; confirm green.

## Definition of done

- All checkboxes ticked; every `ACC-FL05-nn` in `spec.md` §9 has a passing test named above.
- `pnpm format:check`, `pnpm lint`, `pnpm test`, `pnpm build` green locally and in CI; `pnpm --filter ever-works-docs build` has no broken-link warnings.
- The banned-terms grep over `docs apps packages` prints nothing.
- A permission prompt raised by a real Claude Code session on a Linux Node appears on the card, the Inbox, My Decisions, the hub and a notification with one key, and one **Allow** clears all five (ACC-FL05-12, ACC-FL05-15), demonstrated end to end.
- A hook fired while the node is restarting is applied after the restart (ACC-FL05-02, ACC-FL05-03), demonstrated on Linux, macOS and Windows.
- Constitution gates in `spec.md` §10 confirmed; CONTRACTS clarifications in `spec.md` §8b resolved or recorded as accepted.
