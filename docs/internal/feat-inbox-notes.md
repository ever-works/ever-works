# Inbox (operator message center) — implementation notes

Branch: `session/feat-inbox`. Feature J of the platform program.

One surface where agents / works / the system put messages **for the human**:
blocking questions (the run parks until the reply, and the reply resumes it),
approval requests, escalation mirrors and FYI notices — with unread counts,
archive, a reply box and structured option buttons. Delivery fans out to the
existing notification-channel plugins.

Unrelated to `docs/specs/features/agent-inbox-ui` (the per-agent EMAIL inbox);
nothing under that spec was touched.

## Data model

`inbox_items` — `packages/agent/src/entities/inbox-item.entity.ts`, migration
`apps/api/src/migrations/1785100000000-CreateInboxItems.ts`.

| column                                                                    | notes                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `userId`                                                                  | the recipient; every read/write is owner-scoped on it              |
| `kind`                                                                    | `question` / `approval` / `escalation` / `notice` (varchar 16)     |
| `title`, `body`                                                           | plain text, capped at 300 / 8000 chars; never rendered as markup   |
| `options`                                                                 | `simple-json`, `[{id,label,description?,recommended?}]` or NULL    |
| `sourceType`                                                              | `agent-run` / `escalation` / `proposal` / `system` / `work`        |
| `agentId`, `agentRunId`, `taskId`, `workId`, `escalationId`, `proposalId` | nullable raw uuids, **no `@ManyToOne`, no FKs**                    |
| `status`                                                                  | `open` / `answered` / `archived`                                   |
| `unread`                                                                  | independent of `status` (an item can be answered and still unread) |
| `answeredAt`, `answerText`, `answerOptionId`                              | the recorded answer                                                |
| `tenantId`, `organizationId`                                              | EW-651 Tier C scope columns                                        |

Indexes: `(userId, status, unread)` for the list, plus one each on
`escalationId` / `proposalId` for producer dedup.

**No FKs on purpose** — like `agent_escalations`, an inbox item must survive the
deletion of what it describes. "What did the agent ask me last week?" is still a
valid question after the run is gone. Registered in
`_entities-inventory.ts` + `_entity-names.ts` (missing registration = 500 on
first query).

Wire types + the option normalizer live in
`packages/contracts/src/inbox/inbox.types.ts`.

## Producers (all additive — the mirrored record stays the system of record)

| producer               | seam                                                                                 | idempotency                                                  |
| ---------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `ask_human` agent tool | `agent-inbox-tools.ts`, registered via `AGENT_DOMAIN_TOOL_SOURCES` (`sources.inbox`) | none needed — one call, one item                             |
| escalations            | `AgentEscalationService.record` → `InboxProducer.escalationRaised`                   | pre-check on `escalationId`                                  |
| approvals              | `AgentApprovalsService.createProposal` (**pending only**) → `proposalPending`        | pre-check on `proposalId`                                    |
| system notices         | `InboxBudgetAlertListener` on `BudgetThresholdCrossedEvent` → `InboxService.notice`  | upstream, by `WorkBudgetAlertStateRepository`'s unique index |

The upstream services reach the inbox through `INBOX_PRODUCER`, a token in the
leaf file `packages/agent/src/inbox/inbox-producer.port.ts` with zero runtime
imports, injected `@Optional()`. The api-side `@Global()` `InboxApiModule` binds
it to `InboxService`. That keeps file-import direction one-way (inbox → agents /
approvals for reply routing, never back) while the runtime call goes the other
way. **The `@Global()` matters**: without it those injections resolve to
`undefined` in production and nothing ever mirrors, while every unit test still
passes.

### How `ask_human` parks the run

The tool writes `agent_runs.awaitingInput = true` **directly** via
`AgentRunRepository.setAwaitingInput` rather than threading an outcome through
the tool loop. That is the parking path the executor actually supports for a
domain tool:

- `AgentRunService.finalize` only ever **sets** the flag
  (`if (outcome.awaitingInput === true)`) and never clears it;
- `markCompleted` CASes `status`/`summary` only and does not touch
  `awaitingInput`;

so a flag written mid-loop survives the run's own completion. The
capture-callback channel that could carry an outcome out of a tool is reserved
for the built-in `transitionTask`. The tool result tells the model in words that
the run is parked and to end its turn with a status summary.

The tool is available to **every** agent with no permission gate: asking the
owner a question grants nothing and touches nothing, and a gated question tool
pushes agents back to guessing. `userId` / `agentId` / `agentRunId` are bound at
build time from the run context — never model-supplied — so a prompt-injected
agent cannot point a human's answer at someone else's run. A run that is not the
asking user's is treated as absent: the item is still filed, just without run
links.

## Reply routing (`InboxService.reply`)

| kind         | routing                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `question`   | live run → `RunSteeringService.steer`; parked / resumable run with a Task → `resume` (new run seeded with the reply). Neither → the answer is still recorded and `awaitingInput` is cleared |
| `approval`   | `AgentApprovalsService.decide` by option id (`approve` / `reject`); a 409 from a decision made elsewhere becomes `already-decided`, not an error                                            |
| `escalation` | `AgentEscalationService.resolve` with the reply as the note; a linked parked run is additionally resumed (best-effort)                                                                      |
| `notice`     | marked answered, nothing routed                                                                                                                                                             |

The composed message is `"<option label> — <free text>"` (either half may be
absent). The CAS claim (`markAnswered`, `WHERE status='open'`) runs **last** —
routing is what the reply exists to do, and each downstream is its own
idempotency boundary. A concurrent reply that loses the CAS reports
`already-decided` with the winner's row.

Every downstream router is `@Optional()` in the constructor, so unit tests and
partial runtimes degrade to "recorded but not routed" instead of failing the
reply.

## Endpoints (`apps/api/src/inbox/inbox.controller.ts`, `@Controller('api/inbox')`)

```
GET    /api/inbox                 ?status= (default = active view) &limit &offset → {data, meta:{total,limit,offset,unreadCount}}
GET    /api/inbox/unread-count    {count}
GET    /api/inbox/:id             one message
POST   /api/inbox/:id/reply       {text?, optionId?} → {item, routed, runId?}   (throttled: 30/min)
PATCH  /api/inbox/:id/read        {unread?} — default false = mark read
POST   /api/inbox/:id/archive
POST   /api/inbox/:id/unarchive
DELETE /api/inbox/:id
```

All owner-scoped inside the repository — a foreign id and a missing id give the
same 404, with no existence oracle. Replying to an already-answered item is 409.

## Fan-out

`NotificationService.notifyInboxItem` creates the in-app bell row (dedup key
`inbox_item_<id>`, action URL `/inbox`) and dispatches
`NOTIFICATION_FANOUT_EVENT` so the enabled channel plugins deliver, with quiet
hours / mutes applied downstream as for every other producer. Event keys
`inbox_question` (urgent), `inbox_approval_requested`, `inbox_escalation`,
`inbox_notice` are seeded by `NotificationEventTypeBootstrap` (the path that
matters on SQLite/CI) and by the migration on Postgres.

Activity rows: `INBOX_ITEM_CREATED` / `INBOX_ITEM_ANSWERED` (additive
`ActivityActionType` members — plain varchar storage, no migration needed).

## Web

- Route `/inbox` — `apps/web/src/app/[locale]/(dashboard)/inbox/page.tsx`
  (server component), `?view=archived` for the Archived tab, `?id=` to deep-link
  one message (what the notification's "Open inbox" action carries).
- `apps/web/src/components/inbox/InboxClient.tsx` — the whole two-pane surface:
  Active/Archived toggle, message list (unread dot, kind badge, snippet, time,
  per-row archive / read / delete menu), detail with the "the agent is waiting
  for your reply" banner for open questions, option radio cards + "Other" →
  textarea, reply textarea + Send Reply, and the recorded answer for closed
  items. Polls every 30s (the bell's cadence), paused while a reply is in
  flight.
- Server actions: `apps/web/src/app/actions/dashboard/inbox.ts`.
- Server client: `apps/web/src/lib/api/inbox.ts`; client-safe half in
  `inbox.shared.ts` (`inbox.shared.unit.spec.ts` pins it against contract drift).
- Sidebar: first item after Dashboard, with `SidebarInboxBadge` (30s poll of the
  unread count). This is the documented exception to the sidebar-restraint rule
  — an item that can be blocking work right now has to be one click away.
- i18n: `dashboard.inbox.*`, `dashboard.sidebar.navigation.inbox`,
  `dashboard.sidebar.inboxUnread` in all 21 locale files (English string copied
  verbatim, per conventions).
- `ROUTES.DASHBOARD_INBOX` in `apps/web/src/lib/constants.ts`.

No BFF proxy route was needed: every call goes through server components /
server actions, which is how the rest of the dashboard reaches the API.

## Tests

```bash
# agent package (Jest)
cd packages/agent && npx jest --testPathPattern='src/inbox/'
# plus the pre-existing suites over files this branch touched:
cd packages/agent && npx jest --testPathPattern='(activity-log.types.spec|agent-escalation.service.spec|agent-approvals.service.spec|src/notifications/notification.service.spec|notifications.module.spec|agents/__tests__/agent-tool)'

# api (Jest) — controller + DTO validation, migration, module-shape pin
cd apps/api && npx jest --testPathPattern='(inbox|CreateInboxItems|agents.module.spec)'

# contracts (Vitest) — option normalization
cd packages/contracts && npx vitest run src/inbox

# web (Vitest) — shared-type drift pin
cd apps/web && npx vitest run src/lib/api/inbox.shared.unit.spec.ts

# type-check / build
cd packages/agent && pnpm type-check && pnpm build
cd apps/api && pnpm type-check
cd apps/web && pnpm type-check && pnpm build
```

Coverage: producer wiring on the real services (escalation / proposal → item,
including "no producer bound = unchanged behaviour"), the `ask_human` tool
contract (bound identity, parked message, error path), the full reply routing
matrix (live steer / parked resume / terminal-race fallback / approval proxy /
escalation resolve + resume / notice), unread + archive transitions, owner-scope
404s, the reply CAS, DTO validation and the controller's field mapping, and the
migration on better-sqlite3.

## Known follow-ups

- No Playwright e2e spec. The flows are covered at unit level; an
  `apps/web/e2e/flow-inbox-*.spec.ts` would need seeded inbox rows, which the
  e2e harness has no factory for yet.
- The list is a single bounded page (100 rows, newest first). No pagination
  controls in the UI yet — the API already takes `limit`/`offset`.
- Only one system-notice producer is wired (budget thresholds). Goal / run
  completion notices are the obvious next candidates and need no new
  machinery — just another `InboxService.notice` caller.
- The detail view renders the original message plus the recorded answer. It is
  not yet a multi-turn thread; a second question from the same run files a
  second item today.
- `POST /api/inbox/:id/reply` returns `routed` and `runId`, but the UI only uses
  `routed` for its confirmation toast — it does not yet link through to the
  resumed run.
