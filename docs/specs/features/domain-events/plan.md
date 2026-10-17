# Implementation Plan: Domain Events

**Feature ID**: `domain-events`
**Spec**: [`spec.md`](./spec.md)
**Status**: `Draft`
**Last updated**: 2026-10-15

Two pull requests keep the change reviewable:

- **B1 — infrastructure:** catalog, tables, recorder, relay, retention, plugin capability, contract tests.
- **B2 — recording points:** P1 aggregates (tasks incl. edges and chat, teams incl. members and resources, organization
  members, agents, works incl. members), `version` bumps, `task.runtime_updated`, coverage test.

## Phase 1 — Catalog (B1)

- **P1.1** `packages/contracts/src/events/domain/`: `DOMAIN_EVENT_TYPES`, `DomainEventEnvelope`, per-type data types,
  pattern matcher; exported from the package barrel.
- **P1.2** Contract test (agent package, Ajv 2020): the TypeScript catalog equals `event-catalog.v1.json`; every example
  in `integrations-api-v1/contract/examples/` validates; every catalog `dataSchema` resolves; the signature vectors verify.

## Phase 2 — Tables and entities (B1)

- **P2.1** Entities `DomainEvent`, `DomainEventRelayState`, `PluginEventCursor` (registered in the entity barrel,
  `_entities-inventory.ts`, `_entity-names.ts`).
- **P2.2** One migration, three dialects, idempotent, with `down`: `domain_events` (bigint auto-increment `outboxSeq`,
  relay-assigned `seq`),
  `domain_event_relay_state`, `plugin_event_cursors`, and `version int NOT NULL DEFAULT 1` on `tasks`, `teams`,
  `agents`, `works`, `organizations`.
- **P2.3** Migration spec (better-sqlite3): columns, indexes, idempotent second `up`, `down`.

## Phase 3 — Recorder (B1)

- **P3.1** `DomainEventRecorder.record(manager, input)` → inserts the row with the caller's `EntityManager`; generates
  `evt_<ULID>`; on Postgres issues `pg_notify` in the same transaction.
- **P3.2** `bumpAggregateVersion(manager, aggregate, id, { touchUpdatedAt })` → `version = version + 1` (and `updatedAt`),
  returns the new version.
- **P3.3** Request context for actor / origin / integration key / correlation id (fed by the integration principal in
  EW-P1-2 and `X-Sync-Origin`).

## Phase 4 — Relay (B1)

- **P4.1** Lease: compare-and-set on `domain_event_relay_state` (pattern of `instance-stats-lease.service.ts`).
- **P4.2** Loop: 1 s tick (`setInterval` + `unref`, re-entry guard, stop on module destroy); Postgres `LISTEN` on a
  dedicated `pg` client for early wake-up; batch of 200.
- **P4.3** Positions: assign `seq` to committed undispatched rows in `outboxSeq` order, in one compare-and-set
  transaction per batch that also checks the lease (fencing); late commits get later positions, so no gap handling.
- **P4.4** Delivery: `emitAsync('domain.<type>')`; registered consumers; plugin cursors (per plugin and tenant,
  timeout, dead-letter after 10 failures).
- **P4.5** Retention job (`@Cron`, distributed task lock, bounded batches, floor recorded).
- **P4.6** Flags: `DOMAIN_EVENTS_RELAY_ENABLED` (default on), `DOMAIN_EVENTS_RETENTION_DAYS` (30),
  `DOMAIN_EVENTS_PLUGIN_TIMEOUT_MS` (10000).

## Phase 5 — Plugin capability (B1)

- **P5.1** `packages/plugin/src/contracts/capabilities/domain-event-subscriber.interface.ts` + type guard + manifest
  capability `domain-event-subscriber`.

## Phase 6 — Recording points (B2)

- **P6.1** DTO snapshot builders (task, team, agent, work, organization, member, comment) shared with the integration
  API mappers.
- **P6.2** Tasks: create, update, delete, transition, assignees, approvers, reviewers, watchers, blocks, relations,
  attachments, chat create/edit/delete; runtime-only writers → `task.runtime_updated`.
- **P6.3** Teams: create, update, delete, members add/update/remove, resources add/remove.
- **P6.4** Organization: update, members add (invitation accept / roster insert), update, remove.
- **P6.5** Agents: create, update, status changes, archive, delete.
- **P6.6** Works: create, update, archive, delete, members add/update/remove.
- **P6.7** Coverage test over the controllers in scope.

## Dependencies

- **Feeds**: [`integrations-api-v1`](../integrations-api-v1/plan.md) (feed, webhooks v2),
  [`event-subscriptions`](../event-subscriptions/plan.md) (notification fan-out can consume `domain.*`).
- **Uses**: [`integration-keys`](../integration-keys/plan.md) for the integration actor (optional until it lands).
