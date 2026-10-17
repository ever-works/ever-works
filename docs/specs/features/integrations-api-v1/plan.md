# Implementation Plan: Integration API v1

**Feature ID**: `integrations-api-v1`
**Spec**: [`spec.md`](./spec.md)
**Status**: `Draft`
**Last updated**: 2026-10-15

Depends on [`domain-events`](../domain-events/plan.md) (EW-P1-1: outbox, versions, feed source) and
[`integration-keys`](../integration-keys/plan.md) (EW-P1-2: principal, scopes, pins, act-as). Read filters come from
[`record-visibility`](../record-visibility/plan.md) (EW-P1-3).

## Phase 1 — Namespace and common pieces (EW-P1-4)

- **P1.1** `apps/api/src/integrations-api/v1/` module: controllers delegate to existing domain services; every route
  is integration-principal only (`@RequireScopes(...)`, pinned `X-Scope-Slug`).
- **P1.2** Error envelope: an exception filter scoped to the namespace maps domain errors to the codes in
  [`error.schema.json`](./contract/schemas/error.schema.json).
- **P1.3** List pagination helper: `updatedSince`, keyset cursor on `(updatedAt, id)`, `limit ≤ 500`, `includeArchived`;
  index `(organizationId, updatedAt)` on every listed table (all three dialects).
- **P1.4** `version` / `ETag` / `If-Match` interceptor (versions from EW-P1-1).
- **P1.5** `idempotency_keys` table (24 h TTL, `(keyId, key)` unique, stored status + body) + interceptor + purge job.
- **P1.6** `external_record_links` table (org-scoped generalisation of `external_issue_links`, which stays as it is):
  unique `(organizationId, source, installationId, entityType, entityId)` and
  `(organizationId, source, installationId, entityType, externalId)`; `externalRef` on creates, atomic with the row;
  repeat → 200 existing.
- **P1.7** `X-Sync-Origin` → request context → `DomainEventRecorder` `originTag` (EW-P1-1 already persists it).
- **P1.8** `POST /batch` (≤100, sequential, per-op status, each op rate-limited).
- **P1.9** DTO mappers (entity → integration DTO) shared with EW-P1-1's event `data` builders, so an event's `data`
  and a GET of the same version are identical.

## Phase 2 — P1 resources

- **P2.1** `GET /whoami`, `GET /organization`, `GET /members`.
- **P2.2** `GET /events` over `domain_events`: pinned orgs, non-private aggregates, `types` with `<domain>.*`,
  `excludeOrigin`, `410 cursor_expired` below the retention floor, `task.runtime_updated` only on exact request.
- **P2.3** `GET /agents`, `GET /agents/:id`.
- **P2.4** Teams: CRUD + `PUT members` + `PUT resources`.
- **P2.5** `GET /works`, `GET /works/:id`.
- **P2.6** Tasks: CRUD, PUT sets, comments (with `authorType='integration'` + `externalAuthor` from EW-P1-2).
- **P2.7** Links.
- **P2.8** OpenAPI for the namespace, served in production at `/api/integrations/v1/openapi.json` (x-api-key + bearer).

## Phase 3 — Webhooks v2 (EW-P1-5)

- **P3.1** Subscription columns: `ownerType` (`user` | `integration_key`) + `ownerId`, `events[]`, `organizationIds[]`,
  `excludeOriginTags[]`, `version` (1 | 2).
- **P3.2** Fan-out from the domain-event relay, scoped by org; the old `accountId === work.userId` rule stays for v1.
- **P3.3** Signing `t=,v1=` over `"<t>.<rawBody>"` + `X-Ever-Works-Event-Id`; two `v1` during the rotation grace window;
  legacy headers kept on v1 subscriptions. Contract test against
  [`webhook-signature-vectors.json`](./contract/webhook-signature-vectors.json).
- **P3.4** PATCH resume; key revocation disables the key's subscriptions.
- **P3.5** Settings → Webhooks UI (list, create, deliveries, redeliver).

## Phase 4 — Transitions for sync, reopen (EW-P1-6)

- **P4.1** `POST /tasks/:id/transition {to, mode:'sync'}`: BFS over `ALLOWED_TRANSITIONS`, blocker/approver gates
  enforced per hop, `409 transition_blocked {blockers, pendingApprovers, path}`, one `task.transitioned` per hop.
- **P4.2** Domain change: `cancelled → backlog | todo` (reopen) for all callers; mirror in `TASK_BOARD_TRANSITIONS`.

## Phase 5 — Later resources

P2: ideas, goals (external metric source, drafts only), missions (paused only), task dates/estimate, repo-less `project`
Work kind. P3: inbox (act-as recipient), KB. P4: email. Each publishes its DTO schemas into
[`contract/`](./contract/README.md) and fills the reserved catalog rows (`dataSchema: null` today).

## Testing

- Contract tests: every DTO, error and event served validates against `contract/` (EW-P1-8).
- Idempotency, `If-Match`, act-as, scope and pin tests per route; visibility matrix from EW-P1-3.
- Multi-DB migration tests for `idempotency_keys` and `external_record_links` (Postgres, MySQL, better-sqlite3).
