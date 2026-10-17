# Feature Specification: Domain Events

**Feature ID**: `domain-events`
**Status**: `In progress` — B1 (catalog, outbox, recorder, relay, feed reader, plugin delivery, retention) merged in #2611; B2 (P1 recording points + coverage gate) implemented, see §3 for its known gaps
**Created**: 2026-10-15
**Last updated**: 2026-10-16
**Owner**: Product (Ruslan); implementation: the Ever Works integration lane
**Plan items**: EW-P1-1 (outbox, relay, plugin capability, P1 recording points); later phases add goal, mission, idea,
inbox, KB and email recording points.
**Related**: [`event-subscriptions`](../event-subscriptions/spec.md) (EW-664 notification registry),
[`integrations-api-v1`](../integrations-api-v1/spec.md) (feed and webhooks v2), [`activity-log`](../activity-log/spec.md),
`docs/specs/architecture/events.md` (today's EventEmitter2 events).

> **Problem.** Ever Works emits no domain events for tasks, goals, missions, teams, inbox or docs. EventEmitter2 carries
> only `work.*`, `deployment.*`, `user.*`, `fleet.*`, `app.build.*` and `budget.*`; outgoing webhooks cover 5 work and
> deploy events; and task changes leave only `activity_log` rows and in-app notifications. Nothing durable reaches
> out-of-process consumers, so an integration cannot follow changes without polling every list, and an event emitted
> just before a crash is lost.
>
> **Decision (D7).** Build durable domain events: a typed catalog, a transactional outbox and a relay. **Do not adopt
> `@nestjs/cqrs`**: its `EventBus` is as in-process and non-durable as EventEmitter2, and adopting it means a large
> command/handler refactor without solving durability. CQRS command handlers can still be adopted later per module.
>
> **Hard rule (additive only).** Existing EventEmitter2 events, notifications and activity-log writes keep working
> unchanged. Re-pointing them to domain events happens only after parity is proven.

---

## 1. Catalog

- Types and payloads are versioned in `packages/contracts/src/events/domain/`: `DOMAIN_EVENT_TYPES` (every type of the
  catalog v1), the `DomainEventEnvelope` type, per-type `data` types, and helpers (`isDomainEventType`,
  `matchesDomainEventPattern('task.*')`).
- The published JSON Schemas live in
  [`integrations-api-v1/contract/`](../integrations-api-v1/contract/README.md): the envelope, the catalog
  (`event-catalog.v1.json`) and one `data` schema per event. A contract test asserts the TypeScript catalog and the
  JSON catalog list the same types, and that recorded events validate.
- Names: `<aggregate>.<verb>` or `<aggregate>.<child>.<verb>`, lower-case, `_` inside a word (`task.runtime_updated`).

## 2. Outbox table `domain_events`

| Column                               | Type                     | Notes                                                                                                  |
| ------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `outboxSeq`                          | bigint auto-increment PK | Insert order (internal). Allocated when the row is inserted, so it can commit out of order             |
| `seq`                                | bigint null, unique      | **Feed position**: assigned by the relay when it dispatches the row, strictly increasing, never reused |
| `id`                                 | varchar(32) unique       | `evt_<ULID>`                                                                                           |
| `type`                               | varchar(64)              | e.g. `task.updated`                                                                                    |
| `version`                            | smallint                 | payload schema version (1)                                                                             |
| `tenantId`, `organizationId`         | uuid                     | `organizationId` null for personal scope — never served to integrations                                |
| `aggregateType`, `aggregateId`       | varchar(32) / uuid       |                                                                                                        |
| `aggregateVersion`                   | int                      | the aggregate's `version` after the change (§4)                                                        |
| `visibility`                         | varchar(16) null         | the aggregate's visibility at event time (`private` rows are never served, §5)                         |
| `actorType`, `actorId`, `actorLabel` | varchar                  | `user` \| `agent` \| `integration` \| `system`                                                         |
| `originTag`                          | varchar(100) null        | from `X-Sync-Origin`, e.g. `gauzy:<connectionId>`                                                      |
| `integrationKeyId`                   | uuid null                |                                                                                                        |
| `changedFields`                      | json `string[]`          |                                                                                                        |
| `data`                               | json (MySQL `longtext`)  | full post-change snapshot in the integration DTO shape                                                 |
| `previous`                           | json                     | previous values of `changedFields` only                                                                |
| `occurredAt`                         | timestamp                |                                                                                                        |
| `dispatchedAt`                       | timestamp null           | set by the relay together with `seq`                                                                   |
| `correlationId`                      | varchar(100) null        |                                                                                                        |

Indexes: unique `(seq)`, `(tenantId, seq)`, `(organizationId, seq)`, `(aggregateType, aggregateId, seq)`,
`(dispatchedAt, outboxSeq)` (partial `WHERE dispatchedAt IS NULL` on Postgres and SQLite).

**Why two sequence columns.** An auto-increment value is allocated at insert time, so two concurrent transactions can
commit out of order: if the slower one holds the lower value, a cursor that already moved past the higher one would
never see it. A timeout cannot tell a slow commit from a rollback. So the feed does not page on the insert order:
the single leader relay assigns `seq` only to rows it can already see as committed, in one compare-and-set transaction
per batch. A row that commits late simply receives a later `seq`. The feed (`after=<seq>`) is therefore gap-free and
never skips a committed event. Per aggregate, order is preserved: two writes to one aggregate are serialized by the
`version` bump's row lock, so the second event can only become visible after the first.

Retention: 30 days (`DOMAIN_EVENTS_RETENTION_DAYS`); a nightly job deletes dispatched rows older than that and records
the retention floor (the highest deleted `seq`), below which the feed answers `410 cursor_expired`.

Relay state `domain_event_relay_state` (one row): the DB lease (`holder`, `leaseExpiresAt`), the last assigned position
(`lastSeq`, which is the feed `head`) and the retention floor (`retentionFloorSeq`).

## 3. Recording

- `DomainEventRecorder.record(manager, event)` is called from **service-layer mutation methods inside their
  transaction**, with the `EntityManager` of that transaction. Mutations that were not transactional are wrapped in a
  transaction at the recording point. The event row commits or rolls back with the state change.
- **Not ORM subscribers**: Ever Works writes through QueryBuilder and bulk deletes, which subscribers miss.
- **Hard deletes** record a tombstone: `type = '<x>.deleted'`, `data` = the last snapshot + `deleted: true`, at a version
  claimed before the delete (see _Tombstone version_ below).
- **Child changes** (edges, chat, members, resources) record a child event (`task.assignee.added`, …) whose `aggregate`
  is the parent with its new version.
- **Attribution**: the actor comes from the request (user, agent run, integration key with optional act-as) or is a
  named system actor (`pr-status-cron`, `recurrence-dispatcher`, …). `originTag` comes from `X-Sync-Origin`.
- **Coverage gate**: `apps/api/src/domain-events/domain-event-route-coverage.spec.ts` reads every mutating route
  (POST/PUT/PATCH/DELETE) of the controllers in scope from their source and requires an entry in
  `DOMAIN_EVENT_ROUTE_COVERAGE` naming the catalog events the route records, or the reason it records none. A new
  mutating route fails CI until someone decides. The recording specs in
  `packages/agent/src/domain-events/__tests__/*-recording.spec.ts` pin the behaviour behind each entry and validate
  every event's `data` against the schema its row in `event-catalog.v1.json` names.
- **Two recording modes** (B2):
    - _In the write's transaction_: tasks (fields, transitions, edges, chat, templates), teams (fields, roster,
      resources). A rolled-back write leaves no event.
    - _Right after the write, in a transaction of its own_ (`recordAfterWrite`, best-effort, a failure is logged and
      never fails the write): agents, works (incl. members), organization roster and organization fields. These writes
      are multi-step or go through repositories that take no `EntityManager` yet. The integration's hourly reconcile
      (`updatedSince`) repairs a missed event. Moving them into the write's transaction is a follow-up.
    - The same mode records the **Inbox** (P3, EW-P3-1) in `InboxService`: `inbox.item.created` from every producer
      (`askHuman`, fleet `questionRaised`, `escalationRaised`, `proposalPending`, `notice`); `inbox.item.answered` once
      per answer, from whichever door won the `markAnswered` claim (`reply`, `escalationResolved`,
      `proposalDecided`); `inbox.item.state_changed` for a real read / unread or archive / restore flip;
      `inbox.item.deleted` with a tombstone claimed before the delete. `data` is the inbox-item DTO
      (`resources/inbox-item.schema.json`; `data.recipientUserId` is always set, fleet `sourceMeta` is never exposed).
      They are **recipient-scoped** (`visibility: recipient`, one person's messages): the integration feed and webhooks
      v2 serve them only to an integration key that holds `inbox:read`, never to a user-owned subscription; the gate is
      by event type (`recipientScopeForEventType` in `@ever-works/contracts`, also `email.*` → `email:read`).
      Pinned by `inbox-recording.spec.ts` and `webhook-domain-event-fanout.service.spec.ts`.
    - The same mode records the **Knowledge Base** (P3, EW-P3-2): `kb.document.*` in `KnowledgeBaseService` (create,
      edit, lock, decision, accept, archive / restore, delete with a tombstone, for Work and organization documents) and
      `KnowledgeLibraryService` (`moved` when documents are filed, or unfiled by a folder delete); `kb.folder.*` in
      `MemoryFoldersService` for organization library folders (a rename or a move records `updated` for the whole
      rewritten subtree; a delete records `deleted` per folder, tombstones claimed before it). A document of a
      personal Work records none. Background writers that go straight to the repository (Git-mirror reconcile,
      consolidation markers) record nothing; the integration's reconcile covers them. Pinned by `kb-recording.spec.ts`.
    - **Agent email** (P4, EW-P4-2) records at the repository: `EmailMessageRepository` is the single writer of
      `email_messages` and reports every write after it lands (a new row, a status move, a delivery status, the Task
      link; inside the send-admission lock the reports wait for the commit), and `EmailMessageDomainEventsBridge`
      records `email.message.received` (new inbound), `email.message.sent` (new outbound already sent, or a move to
      `sent`) and `email.message.status_changed` (everything else). Recipient-scoped like the Inbox (`email:read`).
      Pinned by `email-recording.spec.ts`.
- **Known gaps (follow-ups)**: agent bundle import (`POST /api/agents/import`) records no `agent.created`; a work member
  added by accepting a claim records no `work.member.added`; the recurrence dispatcher, release promotion and the other
  direct `casUpdateStatus` callers outside `TaskTransitionService` record no `task.*` event. The reconcile covers each of
  them.
- **Side events**: a team roster change for an agent also records `agent.updated` (`teamIds`); a resource link change
  records `task.updated` / `work.updated` (`teamIds`); deleting a team records `team.updated` for re-parented child
  teams and `agent.updated` / `task.updated` / `work.updated` for everything that loses it from `teamIds`.
- **Tombstone version**: `beforeDelete` bumps the version before snapshotting (the `UPDATE` takes the row lock), and
  `<x>.deleted` carries that version, so a racing edit can never record the same version.
- **Ideas (EW-P2-1)**: `WorkProposalRepository` is the write path every Idea change takes (generation, `+ Add`, the
  build lifecycle, dismiss / restore, delete), so it records `idea.created`, `idea.status_changed` (with the previous
  status; a write that keeps the status, such as BUILDING -> BUILDING on an auto-retry, records nothing),
  `idea.updated` (title / description, `teamIds`) and the `idea.deleted` tombstone, best-effort after the write.
  Integration creates (`WorkProposalService.createExternal`) write the row, its Teams and `idea.created` in one
  transaction. Known gap: the Ideas a Mission clone copies record no `idea.created` until the Missions recording
  points (EW-P2-5) land; the reconcile covers them.
- **Goals (EW-P2-2)**: `GoalsService` writes and records in one transaction (`goal.created`, `goal.updated`,
  `goal.status_changed`, the `goal.deleted` tombstone, and the external-sample `goal.progress_changed`);
  `GoalEvaluationService` records an auto-outcome (`goal.status_changed`) or a moved value / score
  (`goal.progress_changed`) best-effort after its save; the orchestrator records Definition-of-Done edits
  (`goal.updated`), `goal.archived` / `goal.unarchived` and a loop's terminal status. Loop control (start, pause,
  cancel, limits, spend) is runtime like `task.runtime_updated`'s fields, but records nothing and bumps nothing.
  `goal.progress_changed` is throttled to one per Goal per 5 minutes; inside the window only the version moves.
- **Missions (EW-P2-5)**: `MissionsService` writes and records in one transaction (`mission.created`,
  `mission.updated`, `mission.status_changed`, the `mission.deleted` tombstone); typed Work links (`mission.work.*`)
  and Goal links (`mission.goal.*`, from `GoalsService`, with the Goal's `goal.updated`) are children of the Mission,
  recorded best-effort after the write. The clone records `mission.created` and `idea.created` for every Idea it copies
  in its own transaction, which closes the EW-P2-1 gap; a fatal tick records `mission.status_changed` to `failed`.

## 4. Aggregate `version` and `updatedAt`

- `version int NOT NULL DEFAULT 1` on the P1 aggregates `tasks`, `teams`, `agents`, `works` and `organizations`.
  Migration `1795100000000-AddP2AggregateSyncColumns` adds it to `work_proposals`, `goals` and `missions` (EW-P2), with
  nullable `createdByType` / `createdById` (the integration key that created the row; NULL = the owner). P3 added
  `inbox_items` (`AddInboxItemVersion1795090000000`). Later phases add `work_knowledge_documents`.
- Incremented on **every** change to the aggregate, **including edge/child changes**: assignees, watchers, approvers,
  reviewers, blocks, relations, attachments and chat on a task; members and resources on a team; members on a work;
  roster rows on an organization.
- `updatedAt` is bumped in the same cases, so `updatedSince` also catches edge changes.
- **Machine-only writes are excluded**: the PR-status cron, CI state and `latestRun*` columns bump neither `version` nor
  `updatedAt`. They record `task.runtime_updated` (opt-in for integrations), so they never cause false sync conflicts.

## 5. Relay

`DomainEventRelay` (API process):

- **One leader** across replicas via a compare-and-set DB lease on `domain_event_relay_state` (works on Postgres, MySQL
  and better-sqlite3). Non-leaders retry the lease every few seconds; the leader renews it well before it expires.
- **Wake-up**: polls every 1 s; on Postgres it also `LISTEN`s on `ever_works_domain_events`, and the recorder issues
  `pg_notify('ever_works_domain_events', '')` inside the writing transaction, so a commit wakes the relay at once.
- **Positions**: each tick reads up to 200 committed rows with `dispatchedAt IS NULL` in `outboxSeq` order and, in one
  transaction, gives them `seq = lastSeq + 1, + 2, …` and `dispatchedAt = now`, and advances `lastSeq` with a
  compare-and-set that also checks it still holds the lease (fencing). A relay that lost its lease writes nothing.
- **Delivery** after the commit, in `seq` order: `eventEmitter.emitAsync('domain.<type>', envelope)` (listener errors are
  logged and never block the relay; in-process delivery is at most once, like EventEmitter2 today), then the
  cursor-based consumers — EW plugins (§6) and webhooks v2 (EW-P1-5) — which read from the table and are at least once.
- The feed (`GET /api/integrations/v1/events`) serves rows with `seq > after` in `seq` order; `head` is `lastSeq`.
  It never serves events of `private` aggregates, **except** `*.visibility_changed` events to `private`, whose `data`
  carries only `{id, visibility:'private'}` so consumers learn to stop syncing.
- Off switch: `DOMAIN_EVENTS_RELAY_ENABLED=false` stops the relay (recording continues; events wait in the outbox and
  get their positions when it is switched back on).

## 6. Plugin capability `IDomainEventSubscriberPlugin`

```ts
interface IDomainEventSubscriberPlugin {
	readonly subscribes: readonly string[]; // e.g. ['task.*', 'goal.completed']
	onDomainEvent(event: DomainEventEnvelope, ctx: PluginEventContext): Promise<void>;
}
```

- Declared in `packages/plugin/src/contracts/capabilities/domain-event-subscriber.interface.ts` and registered as the
  `domain-event-subscriber` capability in the plugin manifest types.
- **At-least-once** through `plugin_event_cursors(pluginId, tenantId, lastSeq, …)`: a plugin that was down catches up
  from its cursor. Only events of tenants where the plugin is enabled are delivered.
- Runs in the relay's process with a per-plugin timeout (`DOMAIN_EVENTS_PLUGIN_TIMEOUT_MS`, default 10 s). After 10
  consecutive failures on one event, that event is dead-lettered (logged and counted on the cursor) and the cursor
  moves on.

## 7. In-process listeners

`@OnEvent('domain.task.updated')` and friends receive the envelope. The EW-664 notification fan-out and the activity
log keep their direct calls (no-removal rule) until a listener reaches parity; then the direct call is retired in a
separate, owner-visible change.

**Alignment with [`event-subscriptions`](../event-subscriptions/spec.md) (EW-664).** The two catalogs answer different
questions and both stay:

|                 | Domain event catalog (this spec)              | Notification event registry (EW-664, `notification_event_types`) |
| --------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| Question        | _What changed?_ (one row per state change)    | _What may we tell a person, and on which channels?_              |
| Keys            | `task.transitioned`, `task.assignee.added`, … | `task_status_changed`, `task_assigned`, `inbox_question`, …      |
| Audience        | integrations, plugins, in-process listeners   | users, through their channel matrix, quiet hours and mutes       |
| Source of truth | `packages/contracts/src/events/domain/`       | `packages/agent/src/notifications/core-event-catalogue.ts`       |

Domain events **feed** the registry: a notification listener subscribes to `domain.<type>`, maps the type to its
registry key (for example `task.assignee.added` → `task_assigned`, `task.transitioned` → `task_status_changed`) and calls
the existing `resolveAndDispatch` path, so the per-user matrix, quiet hours and category mutes keep deciding delivery.
The registry's coverage test (`event-registry-coverage.spec.ts`) still applies to every key such a listener emits. Plugin
domain-event types use the same `plugin:<pluginId>:` prefix rule as plugin notification keys.

## 8. Out of scope

- `@nestjs/cqrs`.
- Exactly-once delivery: consumers dedupe on `id` (and on `aggregate.version` per aggregate).
- Cross-tenant ordering guarantees beyond the global `seq`.

## 9. Acceptance criteria

- [ ] A state change and its event commit together; a rolled-back change leaves no event.
- [ ] With two API replicas only one relays; killing it hands over within one lease period.
- [ ] Postgres: an event is relayed within ~100 ms of commit (LISTEN); MySQL/SQLite within ~1 s (polling).
- [ ] A slow transaction that commits after later ones is still served by the feed (it gets a later `seq`).
- [ ] Every mutating route in scope records its event (coverage test).
- [ ] Runtime-only task writes record `task.runtime_updated` and change neither `version` nor `updatedAt`.
- [ ] A plugin that was stopped receives the events it missed, in `seq` order, once it is back.
- [ ] Rows older than the retention window are purged; a feed cursor below the floor answers 410.

## 10. Constitution gates

- [x] **I** Plugin-first — a new plugin capability consumes the events.
- [x] **II** Capability-driven — the relay depends only on the `IDomainEventSubscriberPlugin` contract.
- [x] **III–V** Schema changes ship with migrations on Postgres, MySQL and better-sqlite3, with a working `down`.
- [x] **VI** Tests — recorder, relay (lease, gaps, LISTEN), retention, plugin cursors, coverage and contract tests.
- [x] **VII** Secret hygiene — event `data` uses the integration DTOs, which carry no secrets.
- [x] **X** Backwards-compat — additive; existing events, notifications and activity rows are unchanged.
