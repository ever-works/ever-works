# Feature Specification: Integration API v1

**Feature ID**: `integrations-api-v1`
**Status**: `Draft` — contract `v1-draft.16`; P1 resources live, P2 Ideas (EW-P2-1), Goals (EW-P2-2), Project Works (EW-P2-4), Missions (EW-P2-5) and organization create (EW-P2-6), P3 inbox, P4 email
**Created**: 2026-10-15
**Last updated**: 2026-10-16
**Owner**: Product (Ruslan); contract owner: the Ever Works integration lane
**Plan items**: EW-P1-4, EW-P1-5, EW-P1-6 (P1); EW-P2-1/2/5, EW-P3-1/2, EW-P4-1/2 (later resources)
**Source of truth**: integration plan doc 03 Part B (private `ever-co/homelab`,
`docs/superpowers/specs/2026-10-15-gauzy-ever-works-integration/03-events-sync-engine-and-contract.md`). This file
mirrors it for readers of this repo, and [`contract/`](./contract/README.md) holds the machine-readable schemas.

> **Why a separate, versioned namespace.** User-facing routes (`/api/me/goals`, `/api/tasks`) change often and filter by
> owner. The integration namespace gives Ever Gauzy (and later other systems) a **stable** contract: it calls the same
> domain services, accepts only the integration principal (an `ew_int_` key now, Ever ID tokens later — see
> [`integration-keys`](../integration-keys/spec.md)), and a breaking change requires `/v2`.
>
> **Hard rule (additive only):** nothing here changes an existing route. The per-user behaviour of the app stays the
> default (owner decision, 2026-10-15).

**Base URL:** `https://api.ever.works/api/integrations/v1` (stage and dev use their own API hosts). Paths below are
relative to it. The plan's shorthand `GET /integrations/whoami` and `GET /integrations/events` (doc 02) mean these same
`/api/integrations/v1/...` routes.

---

## 1. Common rules (B.1)

### 1.1 Request headers

| Header                                            | Requirement                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Authorization: Bearer ew_int_…` (or `x-api-key`) | required                                                                                                                                                                                                                                        |
| `X-Scope-Slug: <ewOrgSlug>`                       | required on org resources; must name a pinned org (`403 org_not_pinned`)                                                                                                                                                                        |
| `X-Act-As-User: <ewUserId>`                       | optional, writes only; the user must be active, in the key's tenant and on the target org's roster (`403 act_as_forbidden`)                                                                                                                     |
| `X-Sync-Origin: gauzy:<connectionId>`             | sent on every write; persisted as `domain_events.originTag` and echoed as `origin.tag`                                                                                                                                                          |
| `Idempotency-Key: <≤128 chars>`                   | required on every POST that creates something; the response is stored for 24 h per `(keyId, key)` and replayed for the same request (method, path, body, organization and act-as user; another one answers `409 request_mismatch`, v1-draft.16) |
| `If-Match: "<version>"`                           | optional on PATCH/PUT/DELETE of a versioned aggregate (the PUT-set routes included, v1-draft.16); a mismatch answers `412 version_mismatch` with `details {expected, current}`                                                                  |

### 1.2 Responses

- Every versioned resource carries `version` and an `ETag: "<version>"` header. Child rows (members, team
  members/resources, work members, task edges, comments) have no version of their own: a change to one bumps the
  parent's version. Comment routes take no `If-Match` in v1.
- **Lists**: `?updatedSince=<ISO>&cursor=<opaque>&limit=<≤500, default 200>&includeArchived=false`, ordered by
  `(updatedAt, id)`, answering `{ "data": [...], "nextCursor": "…" | null, "hasMore": bool }`
  ([`Page`](./contract/schemas/common.schema.json)).
- **Errors**: `{ "error": { "code": "…", "message": "…", "details": {} } }` ([schema](./contract/schemas/error.schema.json)):

| Status | Codes                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------ |
| 400    | `validation_failed` (details: `fields[{path, message}]`)                                                           |
| 401    | `invalid_key`                                                                                                      |
| 403    | `scope_missing`, `org_not_pinned`, `act_as_forbidden`                                                              |
| 404    | `not_found`                                                                                                        |
| 409    | `transition_blocked` (details: `blockers[]`, `pendingApprovers[]`, `path[]`), `duplicate_external_ref`, `conflict` |
| 410    | `cursor_expired`                                                                                                   |
| 412    | `version_mismatch`                                                                                                 |
| 422    | `domain_rule`                                                                                                      |
| 429    | `rate_limited` (with `Retry-After`)                                                                                |
| 5xx    | `internal_error` (retry with back-off)                                                                             |

### 1.3 Visibility

The integration principal sees every row in its pinned orgs whose `visibility` is `team` or `organization`
([`record-visibility`](../record-visibility/spec.md)), regardless of owner. Writes may set `team` or `organization`
only; `private` answers `422 domain_rule`. Scope rule (owner decision D11): a record attached to a Team is team-scoped,
a record with no team is organization-scoped. `private` records never leave Ever Works.

## 2. Identity and change feed (B.2)

| Method | Path      | Scope         | Notes                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | --------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/whoami` | any           | `{keyId, keyName, tenant{id,slug}, organizations[{id,slug,displayName}], scopes[], apiVersion:"1", feedHead:"<seq>", limits{readsPerMin,writesPerMin}}` ([schema](./contract/schemas/resources/whoami.schema.json))                                                                                                                                                                   |
| GET    | `/events` | `events:read` | `?after=<seq>&limit=≤1000&types=task.*,goal.*&excludeOrigin=gauzy:<id>` → `{events:[Envelope], nextCursor, hasMore, head}` ([schema](./contract/schemas/resources/events-page.schema.json)). Only pinned orgs, and never events of `private` aggregates except the id-only `*.visibility_changed` notice (below). A cursor older than retention → `410 cursor_expired` (full resync). |

- Events come in ascending `seq`. `nextCursor` is the `seq` to pass as `after` next time; `head` is the newest feed
  position overall. Positions are global across organizations, so `head` (and `whoami.feedHead`) is never below the
  retention floor: a consumer that is caught up, or a quiet organization, can always continue from `head` without a
  `410`. `seq` is a gap-free feed position assigned when Ever Works dispatches the event, so a consumer
  paging with `after` never misses a committed event (see [`domain-events`](../domain-events/spec.md) §2).
- **Private records**: events of an aggregate that is `private` at event time are never served. The one exception is
  `<aggregate>.visibility_changed` **to** `private`: it is always served (for pinned orgs) with `data` reduced to
  `{id, visibility:'private'}`, so consumers learn to stop syncing without seeing the content.
- `types` takes exact types and `<domain>.*` wildcards. `task.runtime_updated` is returned only when named exactly.
- Retention is 30 days (`DOMAIN_EVENTS_RETENTION_DAYS`), see [`domain-events`](../domain-events/spec.md).

## 3. Event envelope (B.3)

The feed, webhooks v2 and EW plugins share one envelope ([schema](./contract/schemas/event-envelope.schema.json),
[examples](./contract/examples/events/)):

```json
{
	"id": "evt_01JAB…",
	"seq": "102938",
	"type": "task.updated",
	"version": 1,
	"occurredAt": "2026-10-15T18:00:00.000Z",
	"tenantId": "…",
	"organizationId": "…",
	"aggregate": { "type": "task", "id": "…", "version": 17 },
	"actor": { "type": "user|agent|integration|system", "id": "…", "label": "Ruslan" },
	"origin": { "tag": "gauzy:8f…", "integrationKeyId": "…" },
	"changedFields": ["status", "assignees"],
	"data": { "…full integration DTO (§6)…": "" },
	"previous": { "status": "todo" }
}
```

- `aggregate.version` is the aggregate's version **after** the change.
- **Applying events (consumer rules).** Webhooks may arrive out of order and more than once; the feed is in `seq`
  order. Dedupe every event on `id`. Then:
    - **Full-snapshot events** (`<x>.created`, `<x>.updated`, `<x>.transitioned`, `<x>.status_changed`,
      `<x>.archived`, `<x>.deleted`, `<x>.visibility_changed`): skip the event when `aggregate.version` ≤ the version
      already applied for that aggregate; otherwise apply `data` and store `aggregate.version`.
    - **Child events** (`catalog.child` set, e.g. `task.comment.created`, `team.member.added`): `data` is only the child,
      so never skip one by the parent's version — an older child event can still carry a change the newer one does not.
      Apply them idempotently by child identity (comments by `data.id` + `updatedAt`, set edges by their keys: adding an
      existing member or removing an absent one is a no-op). When in doubt, fetch the parent's full DTO, which carries
      every set.
    - **`task.runtime_updated`** carries the unchanged current version: apply it when its `seq` (feed) or `occurredAt`
      (webhooks) is newer than the last runtime update applied for that task; it never conflicts with user edits.
- **Delete events**: `data` is the last known snapshot plus `"deleted": true`; `aggregate.version` is the last version + 1.
- **Child events** (for example `task.comment.created`, `team.member.added`): `data` is the child DTO and `aggregate` is
  the parent with its new version.
- `previous` holds the previous values of `changedFields` only (`{}` when empty). An optional `correlationId` may be
  present.

## 4. Event catalog v1 (B.4)

Machine-readable: [`contract/event-catalog.v1.json`](./contract/event-catalog.v1.json) (type, aggregate, `data` schema,
phase, child / opt-in flags).

| Domain        | Events                                                                                                                                                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization  | `organization.created` (P2), `organization.updated`, `organization.member.added`, `organization.member.updated`, `organization.member.removed`                                                                                                                                                                  |
| Agents        | `agent.created`, `agent.updated`, `agent.status_changed`, `agent.archived`, `agent.deleted`                                                                                                                                                                                                                     |
| Teams         | `team.created`, `team.updated`, `team.deleted`, `team.member.added`, `team.member.updated`, `team.member.removed`, `team.resource.added`, `team.resource.removed`                                                                                                                                               |
| Works         | `work.created`, `work.updated`, `work.archived`, `work.deleted`, `work.member.added`, `work.member.updated`, `work.member.removed`                                                                                                                                                                              |
| Missions (P2) | `mission.created`, `mission.updated`, `mission.status_changed`, `mission.deleted`, `mission.goal.linked`, `mission.goal.unlinked`, `mission.work.linked`, `mission.work.unlinked`                                                                                                                               |
| Goals (P2)    | `goal.created`, `goal.updated`, `goal.status_changed`, `goal.progress_changed` (at most 1 per goal per 5 min), `goal.archived`, `goal.unarchived`, `goal.deleted`                                                                                                                                               |
| Ideas (P2)    | `idea.created`, `idea.updated`, `idea.status_changed`, `idea.deleted`                                                                                                                                                                                                                                           |
| Tasks         | `task.created`, `task.updated`, `task.transitioned`, `task.deleted`; `task.assignee.added/removed`, `task.watcher.added/removed`, `task.block.added/removed`, `task.relation.added/removed`; `task.comment.created/updated/deleted`; `task.attachment.added/removed` (P3); `task.runtime_updated` (opt-in only) |
| Inbox (P3)    | `inbox.item.created`, `inbox.item.answered`, `inbox.item.state_changed`, `inbox.item.deleted` (`data.recipientUserId` always set)                                                                                                                                                                               |
| KB (P3)       | `kb.document.created/updated/moved/archived/unarchived/deleted/review_changed`; `kb.folder.created/updated/deleted`                                                                                                                                                                                             |
| Email (P4)    | `email.message.received`, `email.message.sent`, `email.message.status_changed`                                                                                                                                                                                                                                  |
| Visibility    | `task.visibility_changed`, `goal.visibility_changed`, `mission.visibility_changed`, `idea.visibility_changed`, `agent.visibility_changed`. A change **to** `private` carries only `{id, visibility:'private'}` in `data`.                                                                                       |

Changes with no dedicated child event record the parent's full-snapshot event: a task's **approvers** and **reviewers**
(added, removed, or a decision such as `approvalState`) record `task.updated` with `changedFields` `["approvers"]` or
`["reviewers"]`; labels, teams and every other field change likewise record `task.updated`.

`task.runtime_updated` is emitted for machine-only task writes (PR, CI and run state). It bumps neither `version` nor
`updatedAt`, carries the unchanged current version, and is excluded from the feed and webhooks unless requested by its
exact name.

## 5. Webhooks v2 (B.5)

| Method | Path                          | Notes                                                                                                             |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| POST   | `/webhooks`                   | `{url, events[], organizationIds[], excludeOriginTags[], description}` → `{id, secret, …}` (secret returned once) |
| GET    | `/webhooks`                   |                                                                                                                   |
| PATCH  | `/webhooks/:id`               | Pause **and resume** both work in v2 (`status: active \| paused`)                                                 |
| POST   | `/webhooks/:id/rotate-secret` | Returns the new secret once; the previous one keeps signing as a second `v1` during the grace window              |
| POST   | `/webhooks/:id/test`          |                                                                                                                   |
| DELETE | `/webhooks/:id`               |                                                                                                                   |

- A subscription is owned by the integration key and is disabled when the key is revoked
  ([schema](./contract/schemas/resources/webhook-subscription.schema.json)).
- **Delivery**: one event per POST, body = the envelope (§3), with headers `X-Ever-Works-Event` (type),
  `X-Ever-Works-Event-Id`, `X-Ever-Works-Delivery` (uuid) and
  `X-Ever-Works-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<rawBody>")>` — the same scheme as Gauzy's
  `verifyWebhookSignature`. The HMAC key is the secret string exactly as returned (UTF-8 bytes); tolerance is 300 s,
  inclusive. **Test vectors:** [`contract/webhook-signature-vectors.json`](./contract/webhook-signature-vectors.json).
- **Retry** follows the existing ladder (30 s → 24 h); only 5xx and timeouts are retried.
- **Ordering is not guaranteed.** Consumers order by `seq` per aggregate and fill gaps from `/events`.
- Legacy v1 subscriptions (user-owned, 5 work/deploy events, `X-Ever-Works-Signature-256`) continue unchanged.

## 6. Resources (B.6)

**Fields on every versioned DTO** ([`ResourceBase`](./contract/schemas/common.schema.json)): `id`, `organizationId`,
`version`, `createdAt`, `updatedAt`, `visibility` (`team` | `organization`), `visibilityExplicit`, `owner {type, id}`,
`createdBy {type, id, label}`, `externalLinks [{source, installationId, externalId, externalUrl}]` (filtered to the
caller's source). `teamIds[]` on tasks, goals, missions, ideas, works and agents: `teamId` plus the `team_resources`
rows (for agents: team memberships), as one set; writable on POST/PATCH where the resource is writable, the first id
stored as `teamId` where the entity has that column. Teams are org-wide (`visibility` always `organization`); a Work's
visibility is derived (`team` when it sits on a team).

| Resource      | Routes                                                                                                                                                                                                                                                                                                                 | Scope                   | Schema                                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Organization  | `GET /organization` (the `X-Scope-Slug` org); P2: `POST /organizations` (`org:write`, §6.6)                                                                                                                                                                                                                            | `org:read`, `org:write` | [organization](./contract/schemas/resources/organization.schema.json), [requests](./contract/schemas/requests.schema.json) `CreateOrganization`  |
| Members       | `GET /members` — `userId, username, displayName?, email, emailVerified, avatarUrl, role, joinedAt, everIdSubjects[]`; `POST /members/invite` (CR-13, §6.6)                                                                                                                                                             | `members:*`             | [member](./contract/schemas/resources/member.schema.json), [member-invite-result](./contract/schemas/resources/member-invite-result.schema.json) |
| Agents        | `GET /agents`, `GET /agents/:id` — `id, name, slug, title, capabilities, status, scope, scopeTargetId, reportsToAgentId, avatar{mode,url}, modelId, lastRunAt, webUrl`                                                                                                                                                 | `agents:read`           | [agent](./contract/schemas/resources/agent.schema.json)                                                                                          |
| Teams         | `GET`/`POST /teams`, `GET`/`PATCH`/`DELETE /teams/:id`, `PUT /teams/:id/members` (full set), `PUT /teams/:id/resources`                                                                                                                                                                                                | `teams:*`               | [team](./contract/schemas/resources/team.schema.json)                                                                                            |
| Works         | `GET /works`, `GET /works/:id` (members, `repoUrls[]`, `website`, `kind`, `status`, `webUrl`); P2: `POST /works` with `kind:'project'` (§6.7)                                                                                                                                                                          | `works:*`               | [work](./contract/schemas/resources/work.schema.json), [requests](./contract/schemas/requests.schema.json) `CreateWork`                          |
| Tasks         | `GET`/`POST /tasks`, `GET`/`PATCH`/`DELETE /tasks/:id`; `POST /tasks/:id/transition {to, mode:'sync'}` (shortest legal path; gates → `409 transition_blocked`); `PUT /tasks/:id/assignees`, `/watchers`, `/blocks`, `/relations`; comments `GET`/`POST /tasks/:id/comments`, `PATCH`/`DELETE /tasks/:id/comments/:cid` | `tasks:*`               | [task](./contract/schemas/resources/task.schema.json), [comment](./contract/schemas/resources/task-comment.schema.json)                          |
| Links         | `GET /links?entityType=&externalId=&cursor=&limit=` (a keyset list, v1-draft.16), `PUT /links/:entityType/:entityId {externalId, externalUrl}`, `DELETE /links/:entityType/:entityId`                                                                                                                                  | `links:write`           | [link](./contract/schemas/resources/link.schema.json)                                                                                            |
| Batch         | `POST /batch {operations:[{method, path, headers?, body?}]}` — ≤100 operations, in order, not atomic; per-operation `{status, body}`; each counts against limits                                                                                                                                                       | per operation           | [requests](./contract/schemas/requests.schema.json) `Batch`                                                                                      |
| Missions (P2) | `GET`/`POST /missions` (POST forces `status='paused'`), `GET`/`PATCH`/`DELETE /missions/:id` (PATCH cannot set `active`), `PUT /missions/:id/goals`, `PUT /missions/:id/works` (§6.5)                                                                                                                                  | `missions:*`            | [mission](./contract/schemas/resources/mission.schema.json), [requests](./contract/schemas/requests.schema.json) `CreateMission`                 |
| Goals (P2)    | `GET`/`POST /goals` (POST forces `status='draft'`), `GET`/`PATCH`/`DELETE /goals/:id` (PATCH cannot activate or resume), `PUT /goals/:id/criteria`, `PUT /goals/:id/dod`, `POST /goals/:id/samples {criterionId?, value, sampledAt}` (§6.4)                                                                            | `goals:*`               | [goal](./contract/schemas/resources/goal.schema.json), [requests](./contract/schemas/requests.schema.json) `CreateGoal`                          |
| Ideas (P2)    | `GET`/`POST /ideas` (POST forces `source='external'`, `status='pending'`), `GET`/`PATCH /ideas/:id` (title, description, `teamIds`, `visibility`), `POST /ideas/:id/dismiss`, `POST /ideas/:id/restore` (§6.3)                                                                                                         | `ideas:*`               | [idea](./contract/schemas/resources/idea.schema.json), [requests](./contract/schemas/requests.schema.json) `CreateIdea`                          |
| Inbox (P3)    | `GET /inbox/items` (every recipient in the pinned org; `?recipientUserId=&status=&kind=&includeArchived=`), `GET /inbox/items/:id`, `POST /inbox/items/:id/reply {text?, optionId?}` → `{item, routed, restart, runId?}`, `PATCH /inbox/items/:id/state {unread?, archived?}`; writes act as the recipient only (§9)   | `inbox:*`               | [inbox-item](./contract/schemas/resources/inbox-item.schema.json), reply result (§9)                                                             |
| KB (P3)       | `GET`/`POST /kb/documents`, `GET`/`PATCH`/`DELETE /kb/documents/:id`, `POST /kb/documents/:id/{accept,archive,unarchive,move}`, `GET`/`POST /kb/folders`, `GET`/`PATCH`/`DELETE /kb/folders/:id` (§10)                                                                                                                 | `kb:*`                  | [kb-document](./contract/schemas/resources/kb-document.schema.json), kb-folder (§10)                                                             |
| Email (P4)    | `GET /email/messages` (`?agentId=&direction=&status=&updatedSince=`), `GET /email/messages/:id`, `POST /email/inbound` (§11)                                                                                                                                                                                           | `email:*`               | [email-message](./contract/schemas/resources/email-message.schema.json), inbound result (§11)                                                    |

Request bodies for the P1 writes: [`contract/schemas/requests.schema.json`](./contract/schemas/requests.schema.json).
PUT-set routes take an object (`{members:[…]}`, `{resources:[…]}`, `{assignees:[…]}`, `{userIds:[…]}`,
`{blockedBy:[…]}`, `{relations:[…]}`) and answer the parent DTO. Task status is never set by PATCH; on create it may
be `backlog` (default) or `todo`.

### 6.1 Creating with an external reference

- Every create accepts `externalRef: {source:'gauzy', externalId, externalUrl}`.
- The row and its `external_record_links` row are created **atomically** (tasks and teams: one transaction, T17a;
  comments, KB documents and folders: created, then linked, undone on a lost race).
- A repeat with the same `externalRef` returns **200 with the existing entity**, not a duplicate. Together with
  `Idempotency-Key` this makes creates safe to retry.

### 6.2 Spend safety (D9)

Integration writes never start Ever Works autonomous spend: goals are created as `draft`, missions as `paused`, ideas
are never accepted or built through this API, and PATCH can neither activate a goal or mission nor resume one.

### 6.3 Ideas (EW-P2-1)

An Ever Works Idea (`work_proposals`) is a Gauzy task of issue type "Idea" (plan D4). The routes call the same
`WorkProposalService` as the app, and record the same `idea.*` events.

- **Reads:** every `team` / `organization` Idea of the pinned organization, in every status (`pending`, `queued`,
  `building`, `accepted`, `failed`, `dismissed`); a `private` Idea is never served (404 by id).
- **`POST /ideas`** ([`CreateIdea`](./contract/schemas/requests.schema.json)): `Idempotency-Key` required, `externalRef`
  de-duplicates (200 with the existing Idea). The Idea is always `source='external'` and `status='pending'` (a `source`
  or `status` in the body answers `400`), owned by the act-as user or else the key's owner, `createdBy` = the
  integration key (or the act-as person). `missionId` must name a non-private Mission of the pinned organization (404
  otherwise); `teamIds` become `team_resources` rows of the same organization (404 for a foreign Team) and decide the
  scope (D11) unless `visibility` is set by hand. The row, its Teams and `idea.created` commit together.
- **`PATCH /ideas/:id`** ([`UpdateIdea`](./contract/schemas/requests.schema.json)): `title` (at most 120 characters),
  `description`, `teamIds`, `visibility`; `If-Match` optional, re-checked inside the edit's transaction (`412` when
  stale). Records `idea.updated` (`changedFields`, `previous`), or `idea.visibility_changed` when the scope moves.
- **`POST /ideas/:id/dismiss`** (`pending` → `dismissed`) and **`POST /ideas/:id/restore`** (`dismissed` → `pending`)
  answer the Idea and record `idea.status_changed` with `previous.status`. Both are idempotent: an Idea already in the
  target status answers `200` unchanged. Any other status answers `422 domain_rule` (`details.status`): an Idea that is
  queued, building, accepted or failed has its own Ever Works paths.
- **Writes act as the Idea's owner**, like the task writes: the key's owner, or `X-Act-As-User`. An Idea owned by
  someone else answers `404 not_found`.
- **Never:** accept, queue, build, retry or delete (D9). Building stays a user action in Ever Works.
- **Links:** `PUT /links/idea/:id` is served (the Idea must be visible in the pinned organization).

### 6.4 Goals (EW-P2-2)

An Ever Works Goal is a Gauzy Goal plus key results (plan 01 §6): weighted **criteria** are numeric key results, the
**Definition of Done** is True/False key results. The routes call the same `GoalsService` (and the orchestrator for the
Definition of Done) as the app, and record the same `goal.*` events.

- **Reads:** every `team` / `organization` Goal of the pinned organization; archived ones (`archivedAt` set) only with
  `includeArchived=true`. The DTO ([goal](./contract/schemas/resources/goal.schema.json)) carries `progress` (0..100:
  the weighted score, else baseline → current → target, else the closed share of the approved Definition of Done),
  `missionIds` / `primaryMissionId`, and `loop {status, iteration, spentCents}`: the EW-only execution loop, read-only
  and runtime (loop changes never bump the version).
- **External metric source.** A metric Goal an integration writes reads `metricSource: {pluginId: 'external',
metricId}` (the default when omitted is `{pluginId: 'external', metricId: 'value'}`), and so does each criterion
  (its own source or the Goal's). Any other `pluginId` answers `422 domain_rule`: a provider read can be metered spend
  (D9), and the integration knows the values anyway. Values arrive through `POST /goals/:id/samples`.
- **`POST /goals`** ([`CreateGoal`](./contract/schemas/requests.schema.json)): `Idempotency-Key` required, `externalRef`
  de-duplicates. Always `status='draft'`. A metric Goal needs `comparator`, `targetValue` and `unit` (`window` defaults
  to `point`); a delivery Goal needs at least one Definition-of-Done item. `teamIds` (`team_resources` type `goal`) decide
  the scope (D11) unless `visibility` is set by hand; the row, its Teams and `goal.created` commit together.
- **`PATCH /goals/:id`** ([`UpdateGoal`](./contract/schemas/requests.schema.json)): title, description, comparator,
  target, unit, window, baseline, deadline, `teamIds`, `visibility`. **No** `status`, `outcome`, `metricSource` or
  `goalKind`: an integration never activates, resumes or completes a Goal (D9). `If-Match` optional, re-checked at the
  version bump inside the write's transaction (`412`).
- **`PUT /goals/:id/criteria`** (`{criteria}`, metric Goals; `[]` clears the weighted path) and
  **`PUT /goals/:id/dod`** (`{dodCriteria}`, written as approved operator items) replace the whole set and answer the
  Goal DTO (`goal.updated`). `PUT /goals/:id/dod` keeps every planner proposal (`proposed: true`) the body does not
  name, so editing one key result never drops proposals awaiting a person (Gauzy CR-12).
- **`POST /goals/:id/samples`** ([`GoalSample`](./contract/schemas/requests.schema.json) `{criterionId?, value,
sampledAt}`, `Idempotency-Key` required): appends a `goal_metric_samples` row. Without `criterionId` the newest sample
  becomes `currentValue` (and the baseline when there is none); with `criterionId` it measures that criterion. A Goal
  with criteria is re-scored from the latest pushed values (`resolvedScore`). The Goal / criterion must read the
  external source (`422` otherwise; a delivery Goal takes no samples). Answers `200` with the Goal DTO. It never
  activates, completes or schedules the Goal: an ACTIVE Goal's own evaluation applies the outcome rules to the pushed
  values (it never reads a provider for an external source).
- **`DELETE /goals/:id`** (`If-Match` optional) records the `goal.deleted` tombstone; a Goal whose execution loop is
  `running` answers `422 domain_rule`.
- **Events:** `goal.created`, `goal.updated` (fields, Teams, Definition of Done), `goal.status_changed` (activate,
  pause, an auto-outcome, an `outcome` override, a loop that completes a delivery Goal; `previous.status`),
  `goal.progress_changed` (a sample or an evaluation moved the value or the score; **at most one per Goal per 5
  minutes** — inside the window only the version moves, so a GET or the reconcile still sees it), `goal.archived` /
  `goal.unarchived`, `goal.deleted`, `goal.visibility_changed`.
- **Writes act as the Goal's owner** like the task writes (the key's owner, or `X-Act-As-User`): someone else's Goal
  answers `404 not_found`. `PUT /links/goal/:id` is served.

### 6.5 Missions (EW-P2-5, plan D3b)

An Ever Works Mission is a Gauzy Strategic Initiative: Goals 1:N (one primary), Works M:N (typed), owner = steward. The
routes call the same `MissionsService` (and `GoalsService` for the Goal links) as the app, and record the same events.

- **Reads:** every `team` / `organization` Mission of the pinned organization, in every status. The
  [mission DTO](./contract/schemas/resources/mission.schema.json) embeds `goals [{goalId, isPrimary}]` (the primary
  first), `works [{workId, relation}]`, and the EW-only `type`, `schedule`, `autoBuildWorks` (read-only).
- **`POST /missions`** ([`CreateMission`](./contract/schemas/requests.schema.json) `{title, description, type?,
schedule?, teamIds?, visibility?, externalRef?}`): `Idempotency-Key` required, `externalRef` de-duplicates. Always
  `status='paused'` with no auto-build (D9: only a person resumes a Mission in Ever Works, which is what starts its
  ticks); `type` defaults to `one-shot`, a `scheduled` one needs `schedule`. A title is required (no generated title).
  `teamIds` + D11 apply in the create's transaction.
- **`PATCH /missions/:id`** ([`UpdateMission`](./contract/schemas/requests.schema.json)): title, description,
  `teamIds`, `visibility`, and `status`: `paused` pauses an active Mission, `completed` (+ `outcome`) completes an
  active or paused one, `failed` fails an active or paused one (its ticks stop; a person can resume it). `status:
active` answers `422 domain_rule`; the status already reached is a no-op; any other move is `422`. `If-Match`
  optional, re-checked at the version bump.
- **`PUT /missions/:id/goals`** (`{goals:[{goalId, isPrimary?}]}`, at most one primary — else `422 domain_rule` —,
  no repeats) and **`PUT /missions/:id/works`** (`{works:[{workId, relation}]}`) replace the sets; each link change
  records `mission.goal.linked` / `unlinked` (plus the Goal's `goal.updated`: `missionIds`, `primaryMissionId`) or
  `mission.work.linked` / `unlinked`. Every newly linked Goal or Work must be the caller's (404, checked before the
  first change); a link to a Goal outside the caller's scope is neither shown nor touched. Both answer the Mission DTO;
  `If-Match` is a pre-check (the sets are not one transaction, T17a).
- **`DELETE /missions/:id`**: the `mission.deleted` tombstone; its Ideas and clones are kept (their back-links are
  cleared), and in the same transaction each linked Goal records `goal.updated`, each Idea `idea.updated` and each
  clone `mission.updated`.
- **Never here:** resume, run-now, clone (D9).
- **Events:** `mission.created` (also for a clone, with `idea.created` for each Idea it copies), `mission.updated`
  (fields, Teams), `mission.status_changed` (`previous.status`; also a fatal tick's `failed`), `mission.deleted`,
  `mission.goal.*` / `mission.work.*` (children of the Mission: `data` = the link, `aggregate` = the Mission at its new
  version), `mission.visibility_changed`.
- **Writes act as the Mission's owner** (the key's owner, or `X-Act-As-User`); `PUT /links/mission/:id` is served.

### 6.6 Organizations and members (EW-P2-6)

- **`POST /organizations`** ([`CreateOrganization`](./contract/schemas/requests.schema.json) `{displayName, slug?,
legalName?, countryCode?}`, scope `org:write` — opt-in, not in the Ever Gauzy preset; `Idempotency-Key` required; no
  `X-Scope-Slug`): creates an Organization in the key's Tenant, owned by the Tenant owner like every Organization of
  the Tenant, and **pins it to the calling key** (at most 50 pins: a full key answers `400` before anything is
  written; concurrent creates through one key keep every pin). A key created by an Organization admin also makes its
  creator an `admin` of the new Organization, and creates only while that creator still administers an Organization
  of the Tenant (`422 domain_rule`, `details.reason: 'creator_not_admin'`). Answers `201` with the organization DTO and records
  `organization.created` (new in the catalog; also recorded when a person creates an Organization in the app).
- **Member roles:** `owner` (the Tenant owner, a member of every Organization by construction), `admin`, `member`
  (every existing roster row). Only the Tenant owner promotes or demotes (`PATCH
/api/organizations/:orgId/members/:userId {role: admin|member}` in the app, `organization.member.updated`); invitations
  always create `member`s. Today `admin` grants exactly one thing: **creating integration keys** pinned to the
  Organizations the admin administers. Such a key acts as its creator, and its usable pins are re-read on every
  request and before every webhook send, so a demoted or removed admin's key loses those pins at once (`403
  org_not_pinned`; with no pin left the key no longer authenticates, `401`, and its webhooks pause). Its
  `X-Act-As-User` may name only its creator or a plain `member` of the pinned Organization — never the Tenant owner or
  another admin (`403 act_as_forbidden`). The Tenant owner sees and may revoke every key of the Tenant; an admin sees
  their own.
- **`displayName`:** members now carry the optional `users.displayName` (null when the person set none; fall back to
  `username`). Profile fields are copied once by the consumer (plan 01 §3): changing them records no event.
- **`POST /members/invite`** (CR-13, `members:write`, `Idempotency-Key` required): the app's own `member` invitation
  into the pinned Organization, sent by the act-as user (else the key's owner), idempotent per email
  (`invited` / `pending` / `already_member` / `added`; §17).

### 6.7 Project Works (Gauzy CR-6, EW-P2-4)

`POST /works` ([`CreateWork`](./contract/schemas/requests.schema.json) `{kind:'project', name, description?, website?,
teamIds?, visibility?, externalRef?}`, scope `works:write`) is Gauzy's "Create in Ever Works" for a project (plan D3):
a repo-less **Project Work** — no repositories, no deploy, no generator, so nothing is provisioned and nothing spends
(D9). Only `kind: 'project'` (anything else `400`). `Idempotency-Key` required; a repeated `externalRef` answers `200`
with the existing Work. The owner is the act-as user, else the key's owner, and `createdBy` is the integration key (or
the act-as person), as for every integration create (stored on the Work, migration `1795162200000`); the slug is derived
from `name` (`<slug>-N` when taken). `teamIds` become `team_resources` rows (type `work`); a Work's visibility is derived from them (CR-1), so
`visibility` is only validated (`private` → `422`). While `EVER_WORKS_PROJECT_WORKS_ENABLED` is off the route answers
`422 domain_rule` with `details.reason: 'project_works_disabled'`. Answers `201` with the work DTO and records
`work.created` (plus `team.resource.added` / `work.updated` per Team). `work` stays a served link type.

## 7. Acceptance criteria

- [ ] Every DTO and event served under `/api/integrations/v1` validates against [`contract/`](./contract/README.md)
      (contract tests in CI).
- [ ] The webhook signer reproduces every valid vector, and the reference verifier rejects every invalid one.
- [ ] `If-Match` mismatch → 412; repeated `Idempotency-Key` → replayed response; repeated `externalRef` → 200 existing.
- [ ] `/events` pages losslessly from `whoami.feedHead`; a cursor older than retention → 410.
- [ ] A Gauzy-originated write is excluded from that connection's feed (`excludeOrigin`) and webhooks
      (`excludeOriginTags`).
- [ ] `POST /tasks/:id/transition {mode:'sync'}` reaches `done` from `backlog` through the legal path, and answers 409
      with blockers / pending approvers when a gate holds.
- [ ] OpenAPI for `/integrations/v1` is served in production at `/api/integrations/v1/openapi.json` with the
      `x-api-key` and bearer schemes.

## 8. Clarifications in `v1-draft.1`

Recorded as CR-1 on the plan's STATUS board (additive, nothing breaking): canonical `/api/integrations/v1` paths;
`organizations` gets a `version` so organization events carry one; child rows have no own version and comment routes take
no `If-Match`; team visibility fixed to `organization`, work visibility derived; delete events carry last version + 1;
`internal_error` for 5xx; optional envelope `correlationId`; feed `seq` is a relay-assigned, gap-free position;
consumer rules for applying full-snapshot, child and runtime events (§3); private aggregates' events are never served
except the id-only `*.visibility_changed` notice; approver and reviewer changes record `task.updated`; `Actor.id` is
always set; PUT-set bodies are objects and answer the parent DTO; the
webhook HMAC key is the secret's UTF-8 bytes, with multiple `v1` during rotation; task create status `backlog|todo`; link
`source` derived from the key's `integrationKind`; subscription status `disabled` after key revocation; member DTO adds
`organizationId`, `updatedAt`, `isActive`.

## 9. Inbox (P3, EW-P3-1) — `v1-draft.4`, CR-4

An inbox item is **one human's message** (its recipient): a question an agent run asked, an approval request, an
escalation mirror or a system notice ([`inbox-item`](./contract/schemas/resources/inbox-item.schema.json)). It is not
an organization resource, so it has no `visibility`, owner, teams or `externalLinks`; the consumer keys it by its Ever
Works `id` (`PUT /links/inbox_item/...` stays `400 validation_failed`).

- **Reads** (`inbox:read`): `GET /inbox/items` lists every recipient's messages in the pinned organization, ordered by
  `(updatedAt, id)` like every v1 list. Filters: `recipientUserId`, `status` and `kind` (comma-separated or repeated,
  closed vocabularies; anything else is `400`), `updatedSince`, `cursor`, `limit`. Without `status`, archived messages
  are left out unless `includeArchived=true`. A message outside any organization (personal scope) is never served, and
  one of another organization answers `404`. `GET /inbox/items/:id` carries `ETag: "<version>"`.
- **Writes act as the recipient only** (`inbox:write`): `X-Act-As-User` must name the item's `recipientUserId`, or the
  write answers `403 act_as_forbidden` (`details.reason: not_the_recipient`). The integration key's own identity, or
  another member, never answers somebody's message.
- `POST /inbox/items/:id/reply` [`InboxReply`](./contract/schemas/requests.schema.json) goes through the app's own Inbox
  reply, so it does exactly what the recipient answering in Ever Works does: a question steers the live run or resumes
  the parked one, an approval decides its proposal, an escalation resolves. It answers
  [`{item, routed, restart, runId?}`](./contract/schemas/resources/inbox-reply-result.schema.json). An item already
  answered or archived answers `409 conflict`; a lost race answers `200` with `routed: "already-decided"` and the
  winning answer. `Idempotency-Key` is optional (a reply creates nothing); with one, a retry replays the first answer.
  The resumed run is the recipient's own decision on their own run, not autonomous spend the integration starts (D9).
- `PATCH /inbox/items/:id/state` [`InboxStateChange`](./contract/schemas/requests.schema.json) `{unread?, archived?}`
  (at least one): read / unread, archive / restore (an answered item comes back `answered`, else `open`). Archiving an
  OPEN fleet question releases the run parked on it, as in the app. `If-Match` is optional (`412`); it is checked
  against the version read at the start of the request. Answers the item DTO and its `ETag`.
- **Who receives the events.** `inbox.item.*` are recipient-scoped (one person's messages): the feed serves them only
  to a key that holds `inbox:read` on top of `events:read`, and webhooks v2 deliver them only to a subscription owned
  by such a key, never to a user-owned subscription (another member would otherwise receive somebody else's messages).
  The outbox records them `visibility: recipient`. The same rule will cover `email.*` with `email:read` (P4).
- **Events** (`inbox.item.*`, `data` = the same DTO): `created` from every producer, `answered` once per answer whichever
  door it came through (Inbox reply, escalation resolve, approval decide), `state_changed` for a real read / archive
  flip (also when a reply whose routing failed leaves the item read), `deleted` with the last snapshot. `webUrl` is the
  Inbox deep link `/inbox?id=<id>`.

## 10. Knowledge Base (P3, EW-P3-2) — `v1-draft.6`, CR-7

The integration sees the Knowledge Base the way the Knowledge library does:

- documents: the organization's own, plus those of every Work in the organization (never a personal Work's);
- folders: the organization library folders (never a person's own Memory folders).

Documents are Markdown with `[[path]]` wikilinks ([`kb-document`](./contract/schemas/resources/kb-document.schema.json)).
Folders form a tree ([`kb-folder`](./contract/schemas/resources/kb-folder.schema.json)).

**Reads** (`kb:read`). Each answers with `ETag: "<version>"`.

| Route                   | Notes                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /kb/documents`     | Filters: `scope=organization\|work`, `workId`, `folderId=<id>\|unfiled`, `class`, `status`, `includeArchived`. Keyset by `(updatedAt, id)`. |
| `GET /kb/documents/:id` | Always carries the full body.                                                                                                               |
| `GET /kb/folders`       |                                                                                                                                             |
| `GET /kb/folders/:id`   |                                                                                                                                             |

**Change detection.**

- `revision` moves only on a real change to the title, description, tags, class or body.
- `normalizedContentHash` fingerprints the body.
- `version` moves on every recorded change (status, review, lock, folder) and is the `ETag`.

**Writes** (`kb:write`) go through the app's Knowledge Base and Knowledge library. The Git mirror, embeddings, the
organization overlay into Works, locks, revisions and the activity trail therefore behave as they do in the app.

- **Who writes:** the `X-Act-As-User` person, else the key's owner.
- **What they may change** is decided by the app's rules:
    - a Work's documents need edit access to that Work;
    - organization documents and library folders need organization admin.
- **A refusal** answers `422 domain_rule`.
- **`If-Match`** is a compare-and-set. A stale version answers `412` at once. Otherwise the write first claims the
  version with one conditional `UPDATE … SET version = version + 1 WHERE id = ? AND version = ?` (the same on
  Postgres, MySQL and SQLite), so of two writers sending the same version only one writes and the other gets `412`.
  The write's event carries the claimed version: one version per write. Rules the API can check up front
  (organization admin) are checked before the claim. A refusal that only the Knowledge Base can make (a locked
  document, no edit access to the Work) leaves the claimed version moved.
- **Creates** check `folderId` before writing: a folder that is not one of the organization's library folders answers
  `404` and creates nothing. An organization document's `path` must stay relative: no `..` segment, `\`, NUL or drive
  letter (`400`). A Work document's path follows the Work rule, which also requires a class folder first.
- **An archived document** changes `status` only through `/unarchive`: a `PATCH` with `status` answers `422`. Other
  edits are allowed.

Document routes:

| Route                              | Body                                                                                                                                         | Behaviour                                                                                                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /kb/documents`               | [`CreateKbDocument`](./contract/schemas/requests.schema.json): `scope {type, id}`, `folderId?`, `path`, `title`, `class`, `body`, `tags?`, … | `scope.type` is `organization` (the pinned organization) or `work` (one of its Works). `Idempotency-Key` is required. A repeated `externalRef` answers `200` with the existing document. |
| `PATCH /kb/documents/:id`          | `UpdateKbDocument`                                                                                                                           | `If-Match` is optional. A fully locked document answers `422`.                                                                                                                           |
| `DELETE /kb/documents/:id`         | —                                                                                                                                            | Deletes a Work document. An organization document answers `422 domain_rule`: organization documents are archived, never deleted.                                                         |
| `POST /kb/documents/:id/accept`    | —                                                                                                                                            | The review.                                                                                                                                                                              |
| `POST /kb/documents/:id/archive`   | —                                                                                                                                            |                                                                                                                                                                                          |
| `POST /kb/documents/:id/unarchive` | —                                                                                                                                            |                                                                                                                                                                                          |
| `POST /kb/documents/:id/move`      | `{folderId}`                                                                                                                                 | `null` means Unfiled.                                                                                                                                                                    |

**Every class may live at organization scope.** Only `legal`, `style` and `seo` are inherited into Works.

Folder routes:

| Route                    | Body                 | Behaviour                                                                                       |
| ------------------------ | -------------------- | ----------------------------------------------------------------------------------------------- |
| `POST /kb/folders`       | `CreateKbFolder`     | `Idempotency-Key` is required. A repeated `externalRef` answers `200` with the existing folder. |
| `PATCH /kb/folders/:id`  | `{name?, parentId?}` | Rename, move, or both.                                                                          |
| `DELETE /kb/folders/:id` | —                    | Its subfolders are deleted too. Their documents move to Unfiled; no document is deleted.        |

**Events.** `data` carries the same DTOs.

| Event                        | Recorded when                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `kb.document.created`        | A document is created.                                                                      |
| `kb.document.updated`        | Content, lock or decision changes.                                                          |
| `kb.document.moved`          | A document is filed or unfiled.                                                             |
| `kb.document.archived`       | A document is archived.                                                                     |
| `kb.document.unarchived`     | A document is restored.                                                                     |
| `kb.document.review_changed` | A document is accepted, or a decision is accepted.                                          |
| `kb.document.deleted`        | A document is deleted; `data` is the last snapshot.                                         |
| `kb.folder.created`          | A folder is created.                                                                        |
| `kb.folder.updated`          | A rename or a move. One event per folder of the rewritten subtree.                          |
| `kb.folder.deleted`          | One event per folder of the subtree. The unfiled documents each record `kb.document.moved`. |

- When a body exceeds 262144 UTF-8 bytes, the event carries `body: null, bodyOmitted: true`. `GET` the document for the body.
- A document of a personal Work records no events.

**Links.** `PUT /links/kb_document|kb_folder/...` still answers `400`. The consumer keys documents and folders by their
Ever Works id; creates still de-duplicate on `externalRef`. A create and its `externalRef` link commit in one
transaction (the T17a pattern; for a folder, the folder tree's): a lost race rolls the create back and answers the
winner (`200`). Filing into `folderId` follows as its own step (the folder is checked before the create).

## 11. Agent email (P4, EW-P4-2 + EW-P4-1) — `v1-draft.10`, CR-11

An agent email ([`email-message`](./contract/schemas/resources/email-message.schema.json)) is mail an Ever Works agent
received (`inbound`) or sent / drafted (`outbound`), in its owner's mailbox. Like the Inbox it is **recipient-scoped**:

- `GET` needs `email:read`.
- The `email.message.*` events are served by the feed only to a key that also holds `email:read`.
- Webhooks v2 deliver them only to a subscription owned by such a key, never to a user-owned subscription.

Bcc, provider metadata, approval bookkeeping and failure reasons are never exposed.

**Reads.** `GET /email/messages` lists the pinned organization's agent mail.

- Filters: `agentId`, `direction=inbound|outbound`, `status` (the lifecycle vocabulary).
- Supports `updatedSince` and keyset paging by `(updatedAt, id)`.
- `updatedAt` moves on every write, so status and delivery changes are caught.
- `GET /email/messages/:id` answers with an `ETag`.

**`POST /email/inbound`** ([`InboundEmail`](./contract/schemas/requests.schema.json); `email:write`, an opt-in scope
outside the Ever Gauzy preset) pushes an email a Gauzy mailbox received to an Ever Works agent of the pinned
organization:

1. The message is stored as `email_messages(direction=inbound)` on the **agent's own inbound address**: its first
   inbound assignment, the same choice the provider path makes.
2. It goes through the **same dispatcher as provider mail**:
    - the assignment's mode decides between task-spawn and conversation;
    - `In-Reply-To` / `References` join an existing thread.
3. It answers [`{message, dispatch}`](./contract/schemas/resources/email-inbound-result.schema.json) with `201`.

Edge cases:

- **No inbound assignment.** An agent without an active inbound assignment answers `422 domain_rule`. Its owner opts in
  by giving it one; that is also what starts any agent work on the mail.
- **Address of another organization.** The stored message takes its address's organization, so an inbound address of
  another organization, or of none, answers `422 domain_rule`: its mail would be invisible to the key.
- **Repeated push.** `Idempotency-Key` is required. A push repeated with the same Message-ID into the same organization
  answers `200` with the message already delivered. The de-duplication key is per integration key **and** pinned
  organization, so one key pushing the same mail into two organizations delivers it to each.
- **Attachments.** They are recorded with their `url` and **never fetched**: Ever Works makes no request to a
  caller-supplied URL.

**Events** (`data` = the same DTO):

| Event                          | When                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `email.message.received`       | An inbound message is stored.                                                                        |
| `email.message.sent`           | An outbound message reaches `sent`.                                                                  |
| `email.message.status_changed` | Any other change: a draft filed, `sending`, `failed`, `discarded`, a delivery status, the Task link. |

`changedFields` names DTO fields (`to`, `text`, `messageId` …) and lists only what the write really changed; a write
that changes nothing the DTO shows (Bcc, provider bookkeeping, metadata) records no event and keeps `version`.

An event whose text + HTML exceed 262144 UTF-8 bytes carries `text: null, html: null, bodyOmitted: true`. A message
outside any organization records none.

## 12. Changes in `v1-draft.5` (CR-5, EW-P2-1 Ideas)

Additive. Recorded as CR-5 on the plan's STATUS board: the Ideas routes of §6.3 are served; the
[idea DTO](./contract/schemas/resources/idea.schema.json) is the `data` of `idea.created`, `idea.updated`,
`idea.status_changed` and `idea.deleted` (catalog rows filled); request bodies `CreateIdea` / `UpdateIdea`; `idea` is a
served link entity type; dismiss / restore are idempotent and answer `422 domain_rule` from any other status; writes act
as the Idea's owner (404 for someone else's Idea). `v1-draft.2` (CR-2), `v1-draft.3` (CR-3, task dates and estimate) and `v1-draft.4` (CR-4, Inbox)
are recorded on the same board.

## 13. Changes in `v1-draft.11` (CR-9, EW-P2-2 Goals)

Additive. Recorded as CR-9 on the plan's STATUS board: the Goals routes of §6.4 are served; the
[goal DTO](./contract/schemas/resources/goal.schema.json) is the `data` of every `goal.*` event (catalog rows filled);
request bodies `CreateGoal`, `UpdateGoal`, `PutGoalCriteria`, `PutGoalDod`, `GoalSample`; integrations write only the
external metric source (`pluginId: 'external'`, else `422 domain_rule`); `goal.progress_changed` is throttled to one
per Goal per 5 minutes with the version still moving; `goal` is a served link entity type; the `loop` block is
read-only runtime. Also answers the Gauzy request CR-12: `PUT /goals/:id/dod` keeps the planner proposals it does not
name.

## 14. Changes in `v1-draft.12` (CR-8, EW-P2-5 Missions)

Additive. Answers the Gauzy request CR-8 on the plan's STATUS board: the Missions routes of §6.5 are served; the
[mission DTO](./contract/schemas/resources/mission.schema.json) is the `data` of `mission.created` / `updated` /
`status_changed` / `deleted`, and `MissionGoalLinkEvent` / `MissionWorkLinkEvent` of the link events, which the catalog
now marks `child: goal` / `child: work`; the Goal DTO's `missionIds` / `primaryMissionId` change records `goal.updated`;
request bodies `CreateMission`, `UpdateMission`, `PutMissionGoals`, `PutMissionWorks`; `mission` is a served link
entity type. A cloned Mission's Ideas now record `idea.created` (the EW-P2-1 known gap). As the request asked:
`CreateMission` takes `type` / `schedule` (still created `paused`, so a `scheduled` Mission ticks only once a person
resumes it), `PATCH {status: 'failed'}` fails an active or paused Mission, and a second primary Goal is
`422 domain_rule`. A Mission delete also records what its cascade changes (`goal.updated`, `idea.updated`,
`mission.updated`).

## 15. Changes in `v1-draft.13` (CR-10, EW-P2-6 organizations and members)

Additive. Recorded as CR-10 on the plan's STATUS board: `POST /organizations` (`org:write`, §6.6) with the new catalog
type `organization.created` (`data` = the organization DTO); member `role` values `owner` / `admin` / `member`
(`admin` may create integration keys for the Organizations it administers; such a key's usable pins follow the
creator's current roles); member `displayName` from `users.displayName`; request body `CreateOrganization`.

## 16. Changes in `v1-draft.14` (CR-6, EW-P2-4 Project Works)

Additive. Answers the Gauzy request CR-6 on the plan's STATUS board: `POST /works` (§6.7, `works:write`) creates a
repo-less Project Work (`kind: 'project'` only; no repositories, deploy or generator, so nothing is provisioned, D9)
and records `work.created`; request body `CreateWork`. Teams are checked before the Work is created. While
`EVER_WORKS_PROJECT_WORKS_ENABLED` is off the route answers `422 domain_rule` (`details.reason:
'project_works_disabled'`).

## 17. Changes in `v1-draft.15` (CR-13, member invitations)

Additive. Answers the Gauzy request CR-13 on the plan's STATUS board ("invite to Ever Works" on Gauzy's People tab):
**`POST /members/invite`** ([`InviteMember`](./contract/schemas/requests.schema.json) `{email, role?, invitedName?}`,
scope `members:write`, already in the Ever Gauzy preset; `Idempotency-Key` required) invites a person into the pinned
Organization with the app's own invitation: the email-bound token, the normal invitation email and the seat check,
sent by the act-as user, else the key's owner. `role` is `member` only; promotion stays the Tenant owner's step in
the app (§6.6). It is **idempotent per email** and answers
[`member-invite-result`](./contract/schemas/resources/member-invite-result.schema.json) `{status, invitation, userId}`:
`201 invited` (a new invitation, emailed), `200 pending` (one still pending is answered again; nothing is sent twice,
also when a concurrent call won the race), `200 already_member` (the Tenant owner counts as a member of every
Organization), `201 added` (a person already in the Tenant joins this roster directly, with no email, and
`organization.member.added` is recorded). The token never appears in a response.

## 18. Changes in `v1-draft.16` (CR-14, review fixes)

From the 2026-10-17 post-merge review of the Ever Works side (findings F32/F37, F36, F39, F40, F41, F42). Behaviour
the contract already implied, made true; one list gains its paging.

- **Idempotency-Key** (§1.1): "the same request" is the method, path and body **and** the organization the request is
  scoped to (`X-Scope-Slug` / `X-Organization-Id`) and the resolved `X-Act-As-User`. The same key reused for another
  organization or another act-as user answers `409 request_mismatch` instead of replaying the first one's result.
- **`If-Match` on the PUT-set routes**: `PUT /tasks/:id/assignees`, `/watchers`, `/blocks`, `/relations`,
  `PUT /teams/:id/members` and `/resources` check it against the current version (`412`), and again at the first
  version bump of the set's changes, as `PATCH` does.
- **`null` in a PATCH body**: a field whose schema is not nullable (`title`, `priority`, `labels`, `teamIds`,
  `visibility`, a team `name`, KB `title`/`body`/`class`/…, webhook `url`/`events`/…) answers `400 validation_failed`
  for `null` (it answered `500`). Nullable fields keep taking `null`.
- **Comment `body` ≤ 16384** is counted in characters (code points), as JSON Schema `maxLength` counts; a body of
  emoji within the limit is accepted.
- **Cursors**: a cursor this API did not issue (its id is not a uuid, for instance) answers `400 validation_failed`
  on every list (it could answer `500` on Postgres).
- **`GET /links`** is a list like the others (§1.2): `?entityType=&externalId=&updatedSince=&cursor=&limit=` (≤ 500,
  default 200), ordered by `(updatedAt, id)`, answering `{data, nextCursor, hasMore}`. It answered the first 500 links
  as `{data}` with no way to read the rest. A link to a private record is still left out of `data`, so a page may hold
  fewer than `limit` links while `hasMore` is true.
