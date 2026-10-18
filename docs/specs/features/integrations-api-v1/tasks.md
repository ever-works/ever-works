# Task Breakdown: Integration API v1

**Feature ID**: `integrations-api-v1`
**Last updated**: 2026-10-16

## Contract (published)

- [x] **T0** Machine-readable contract v1 in [`contract/`](./contract/README.md): common, error, envelope, catalog, P1
      DTOs, request bodies, examples, webhook signature vectors (+ generator).

## Phase 1 — Namespace and common pieces (EW-P1-4)

- [x] **T1** `integrations-api/v1` module (`apps/api/src/integrations-api/v1/`) + `IntegrationExceptionFilter`
      (error envelope; an exception already shaped as the envelope, e.g. `409 transition_blocked`, keeps its code
      and details).
- [x] **T2** Keyset list helper (`updatedSince`, `(updatedAt, id)` cursor, `limit ≤ 500`) — `readKeysetPage` in
      `packages/agent/src/integrations-api/keyset-cursor.ts`; `(organizationId, updatedAt, id)` indexes (and
      `(taskId, updatedAt, id)` for comments) in migration `1795080300000`.
- [x] **T3** `ETag` / `If-Match` — helpers (`etagFor`, `parseIfMatch`, `assertIfMatch` → `412 version_mismatch`),
      applied per write route (PATCH / DELETE of tasks and teams), and re-checked at the version bump inside the
      write's transaction (`runExpectingAggregateVersion`), so of two writers on one version only the first wins.
- [~] **T4** `integration_idempotency_keys` table + migration (3 dialects, `1795080200000`) +
  `IntegrationIdempotencyService` (claim-first, replay, mismatch/in-progress `409`, release on error/5xx, purge);
  `runIdempotent` on every create (`Idempotent-Replayed: true` on a replay). Open: a schedule for `purgeExpired`.
- [x] **T5** `external_record_links` table + migration (3 dialects, `1795080200000`) + `ExternalRecordLinksService`
      (create in the caller's transaction, `PUT`/`DELETE`/list, `linksFor`, `installationFromOrigin`).
- [x] **T6** `X-Sync-Origin` → event `originTag` (`DomainEventContextInterceptor`, EW-P1-1 #2611).
- [x] **T7** `POST /batch` — ≤ 100 operations in order, not atomic; each one a loopback request with the outer
      credential and pin, so every guard, scope and rate limit applies; paths confined to `/api/integrations/v1`.
- [x] **T8** DTO mappers shared with domain-event `data` builders (`domain-event-snapshots.ts`, EW-P1-1 #2617).

## Phase 2 — P1 resources

- [x] **T9** `whoami` (EW-P1-2), `organization`, `members`.
- [x] **T10** `GET /events` (feed).
- [x] **T11** Agents (read).
- [x] **T12** Teams: `GET`/`POST /teams`, `GET`/`PATCH`/`DELETE /teams/:id`, `PUT /teams/:id/members` (a role change is
      a remove + an add), `PUT /teams/:id/resources`.
- [x] **T13** Works (read).
- [x] **T14** Tasks: reads, `POST` (Idempotency-Key, `externalRef`, status `backlog`\|`todo`, `private` → `422`),
      `PATCH`/`DELETE` with `If-Match`, `POST /tasks/:id/transition {to, mode:'sync'}` (delegates to
      `TasksService.syncTransition`, never `force`), `PUT` assignees / watchers / blocks / relations.
- [x] **T15** Task comments: `GET`/`POST /tasks/:id/comments`, `PATCH`/`DELETE /tasks/:id/comments/:cid` (author only;
      integration-authored: no edit window; refusals `422 domain_rule`; `task.comment.deleted`).
- [x] **T16** Links: `GET /links`, `PUT`/`DELETE /links/:entityType/:entityId` (the record must be visible; types not
      served in v1 yet → `400`).
- [x] **T17** OpenAPI in production: `GET /api/integrations/v1/openapi.json` (`serveIntegrationOpenApi`).
- [~] **T17a** One transaction per request: create + link, and every edge of a `PUT` set or of a create's assignees /
  extra teams. **Done for create + link of tasks and teams**: `TasksService.create` / `TeamsService.create` take a
  `withinCreate` hook that runs in the row's own transaction (with its `*.created` event), and the integration
  routes write the `externalRef` link there, so a lost race rolls the create back instead of undoing it and a crash
  can no longer leave an unlinked task or team. **Also done for Ideas, Goals and Missions** (follow-up of T35–T37):
  `WorkProposalService` / `GoalsService` / `MissionsService.createExternal` take the same hook, run after the row and
  its `*.created` event; so does `WorkLifecycleService.createProjectWork` for `POST /works` (T39), whose lost race
  used to leave a stray bare Project Work behind. Still step by step: a `PUT` set, and a create's extra teams /
  assignees / visibility after the row (each step commits on its own; the reconcile covers a half-applied set).
- [x] **T17b** OpenAPI request bodies: every property of every request DTO carries `@ApiProperty`, written from its
      contract schema (required, enum, format, limits, description), so `/api/integrations/v1/openapi.json` shows whole
      bodies; `integration-contract.spec.ts` fails on a property without it. Response bodies stay the contract JSON
      Schemas (each route's `@ApiResponse` names its shape).
- [x] **T17c** Task `visibility` writes (`team` / `organization`, `visibilityExplicit`) through
      `RecordVisibilityService.setVisibility` (EW-P1-3, #2621); `private` → `422`. Reads hide a row whose STORED
      visibility is `private`.

## Phase 2b — P2 resources (EW-P2)

- [x] **T35** Ideas (EW-P2-1): `GET /ideas`, `GET /ideas/:id`, `POST /ideas` (Idempotency-Key, `externalRef`, always
      `external` + `pending`, `missionId` in the pinned org), `PATCH /ideas/:id` (title, description, `teamIds`,
      `visibility`; `If-Match` re-checked in the edit's transaction), `POST /ideas/:id/dismiss` / `restore`
      (idempotent; other statuses `422`); `idea` link target; keyset index `idx_work_proposals_org_updated`
      (migration `1795120000000`, also `goals` / `missions`); request schemas `CreateIdea` / `UpdateIdea`; contract
      `v1-draft.5` (CR-5). Recording points: [`domain-events`](../domain-events/tasks.md) T20.
- [x] **T36** Goals (EW-P2-2): `GET /goals` (`includeArchived`), `GET /goals/:id`, `POST /goals` (draft; external
      metric source only, default `{pluginId:'external', metricId:'value'}`; Teams + D11 in the create transaction),
      `PATCH /goals/:id` (no status / outcome / source / kind), `PUT /goals/:id/criteria`, `PUT /goals/:id/dod`,
      `POST /goals/:id/samples` (`currentValue`, baseline, re-score; throttled `goal.progress_changed`),
      `DELETE /goals/:id` (not while the loop runs); `goal` link target; `goal_metric_samples.criterionId` (migration `1795140000000`);
      external sources are never read from a provider on evaluation; schemas `goal.schema.json`, `CreateGoal`,
      `UpdateGoal`, `PutGoalCriteria`, `PutGoalDod`, `GoalSample`; contract `v1-draft.11` (CR-9). Recording points:
      [`domain-events`](../domain-events/tasks.md) T21.
- [x] **T37** Missions (EW-P2-5, D3b): `GET /missions`, `GET /missions/:id`, `POST /missions` (paused; `type` /
      `schedule` optional per Gauzy CR-8; no auto-build; title required; Teams + D11 in the create transaction),
      `PATCH /missions/:id` (content, Teams, visibility; `status` paused / completed + `outcome` / failed, never
      `active`), `PUT /missions/:id/goals`, `PUT /missions/:id/works` (new links checked before the first change),
      `DELETE /missions/:id` (also records the cascade's `goal.updated` / `idea.updated` / `mission.updated`);
      `mission` link target; schemas `mission.schema.json` (+ link-event `$defs`), `CreateMission`, `UpdateMission`,
      `PutMissionGoals`, `PutMissionWorks`; contract `v1-draft.12` (CR-8). Recording points:
      [`domain-events`](../domain-events/tasks.md) T22.
- [x] **T38** Organization create + member roles (EW-P2-6): `POST /organizations` (`org:write`, auto-pin, an admin
      creator becomes admin of the new Organization), `organization.created` (catalog + app creates); roles `owner` /
      `admin` / `member` (Tenant owner promotes via `PATCH /api/organizations/:orgId/members/:userId`); admins may create
      integration keys for the Organizations they administer, the key's usable pins re-read per request
      (`ApiKeyService.effectivePins`) and before every webhook send (`effectiveIntegrationKeyPins`); an admin's key
      acts as itself or a plain member only; `users.displayName` (migration `1795150000000`) in the member DTO;
      contract `v1-draft.13` (CR-10).
- [x] **T39** Project Works (EW-P2-4, Gauzy CR-6): `POST /works` (`kind: 'project'` only, behind
      `EVER_WORKS_PROJECT_WORKS_ENABLED`; slug derived from `name`; Teams checked first, then attached; `externalRef`
      de-duplicates); request schema `CreateWork`; contract `v1-draft.14` (CR-6).
- [x] **T40** Member invitations (Gauzy CR-13): `POST /members/invite` (`members:write`, `Idempotency-Key`), the app's
      own invitation sent by the act-as user (else the key's owner), `member` role only, idempotent per email
      (`invited` / `pending` / `already_member` / `added`); `OrganizationInvitationFlowService.inviteForIntegration`;
      schemas `InviteMember`, `member-invite-result.schema.json`; contract `v1-draft.15` (CR-13).

## Phase 3 — Webhooks v2 (EW-P1-5)

- [x] **T18** Subscription columns + migration (3 dialects) — `1795080100000-AddWebhookSubscriptionsV2`.
- [x] **T19** Relay-driven, org-scoped fan-out with `excludeOriginTags` — `WebhookDomainEventFanoutService` (cursor
      `core:webhooks-v2`, at least once, idempotent per `(subscription, event)`).
- [x] **T20** `t=,v1=` signer + rotation grace + vector contract test — `webhook-signature-v2.ts` (all 22 vectors).
- [x] **T21** PATCH resume; key-owned subscriptions at `/api/integrations/v1/webhooks` (`webhooks:manage`: list /
      create / PATCH / rotate-secret / test / delete, only the key's own, only its pinned organizations); revoking the
      key disables them at once (`IntegrationKeyRevokedWebhooksListener`), and the fan-out and the sender re-check the
      owner before each delivery.
- [ ] **T22** Settings → Webhooks UI.

## Phase 4 — Transitions (EW-P1-6)

- [x] **T23** Sync transition path-walk + `409 transition_blocked` (EW-P1-6: `TaskTransitionService.transitionSync` on `POST /api/tasks/:id/transition {to, mode:'sync'}`; the `/integrations/v1` route delegates to it in EW-P1-4).
- [x] **T24** `cancelled → backlog | todo` reopen (+ web board) (EW-P1-6: `TASK_STATUS_TRANSITIONS` / `TASK_BOARD_TRANSITIONS`, Task detail page, Kanban).

## Phase 5 — Tests (EW-P1-8)

- [x] **T25** Contract test suite over `contract/`:
    - `domain-event-contract.spec.ts` — every schema compiles, the catalog is the TypeScript one, every example and a
      recorded envelope validate, the webhook signature vectors;
    - the recording specs (`*-recording.spec.ts`) and the integration services' specs validate every event `data` and
      resource DTO they build against its schema;
    - `apps/api/.../integration-contract.spec.ts` — every request body schema has the properties and the required ones
      of the DTO its route validates with (`forbidNonWhitelisted`: drift would `400` a valid request), a new body
      without a DTO fails; every error the routes answer is a valid envelope with a listed status ↔ code pair; scopes,
      error codes and integration kinds are the TypeScript vocabularies; `GET /whoami` answers its schema.
- [x] **T26** Idempotency / `If-Match` / act-as tests — the `Idempotency-Key` store and `If-Match` in
      `integrations-api-foundation.spec.ts`, the routes' replay / `412` / `act_as_forbidden` paths in the controller
      specs, act-as resolution in `integration-keys.http.spec.ts`.

## Phase 6 — Inbox (EW-P3-1)

- [x] **T27** `GET /inbox/items` (every recipient of the pinned organization; `recipientUserId`, `status`, `kind`,
      `includeArchived`, keyset) and `GET /inbox/items/:id` (`ETag`) — `IntegrationInboxService`; keyset index
      `idx_inbox_items_org_updated` (migration `1795130100000`, 3 dialects).
- [x] **T28** `POST /inbox/items/:id/reply` and `PATCH /inbox/items/:id/state`, act-as = the recipient only
      (`403 act_as_forbidden` otherwise), through the app's own `InboxService`; reply answers
      `{item, routed, restart, runId?}`, `Idempotency-Key` optional; state `If-Match` pre-check. Contract CR-4
      (`requests.schema.json` `InboxReply` / `InboxStateChange`, `resources/inbox-reply-result.schema.json`).

## Phase 7 — Knowledge Base (EW-P3-2)

- [x] **T29** `version` on `work_knowledge_documents` and `memory_folders` + keyset indexes (migration
      `1795130200000`, 3 dialects); `kb_document` / `kb_folder` snapshots (`domain-event-kb-snapshots.ts`, event body
      limit 256 KiB → `bodyOmitted`).
- [x] **T30** `kb.document.*` recorded in `KnowledgeBaseService` (Work and organization documents) and
      `KnowledgeLibraryService` (filing, folder-delete unfiling); `kb.folder.*` in `MemoryFoldersService`
      (organization folders only); the `kb_document_updated` / `kb_document_deleted` activity rows; every class at
      organization scope (inheritance into Works unchanged).
- [x] **T31** `GET`/`POST /kb/documents`, `GET`/`PATCH`/`DELETE /kb/documents/:id`, `/accept`, `/archive`, `/unarchive`,
      `/move`, `GET`/`POST /kb/folders`, `GET`/`PATCH`/`DELETE /kb/folders/:id` (`IntegrationKbController`) + coverage
      gate entries for every KB controller. Contract CR-7 (`kb-document`, `kb-folder`, five request bodies).
- [x] **T35** KB writes as T17a / CAS: a document or folder create and its `externalRef` link commit in one
      transaction (`withinCreate` on `KnowledgeBaseService.createDocument` / `createOrgDocument` and
      `MemoryFoldersService.createOrganizationFolder`); `If-Match` on `PATCH`/`DELETE /kb/documents/:id` and
      `/kb/folders/:id` claims the version with a conditional `UPDATE` (`IntegrationKbService.claimVersion`) and the
      write records that version (`runWithClaimedAggregateVersion`, taken by the publisher's `changed` /
      `beforeDelete`).

## Phase 8 — Agent email (EW-P4-2, EW-P4-1)

- [x] **T32** `email_messages.updatedAt` (backfilled from `createdAt`) + `version` + keyset index (migration
      `1795130300000`, 3 dialects); `email_message` snapshots (recipient-scoped, 256 KiB event body limit);
      `EmailMessageRepository` reports every write and `EmailMessageDomainEventsBridge` records `email.message.received`
      / `sent` / `status_changed`.
- [x] **T33** `GET /email/messages` (`agentId`, `direction`, `status`, keyset) and `GET /email/messages/:id`
      (`email:read`) — `IntegrationEmailService`.
- [x] **T34** `POST /email/inbound` (`email:write`, opt-in): stored on the agent's own inbound address and dispatched
      through `AGENT_INBOUND_EMAIL_DISPATCHER` like provider mail; Message-ID / Idempotency-Key de-duplication;
      attachments recorded, never fetched. Contract CR-11 (`email-message`, `email-inbound-result`, `InboundEmail`).

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
