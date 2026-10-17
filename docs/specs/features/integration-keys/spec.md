# Feature Specification: Integration keys and the integration principal

**Feature ID**: `integration-keys`
**Plan item**: EW-P1-2 (Gauzy ↔ Ever Works integration)
**Status**: `Implemented`
**Created**: 2026-10-15
**Owner**: Ever Works integration lane

---

## 1. Overview

Ever Works API keys (`ew_live_…`) impersonate their user: no scopes, no organization pin, and — before this feature —
they could even mint more keys. That is the wrong credential for a system-to-system integration such as Ever Gauzy,
which must:

- act inside **chosen organizations** only;
- hold **named capabilities** (scopes), not everything its creator can do;
- write **for** a specific person when it knows who did something on its side, and be **attributed** as the
  integration when it does not;
- never reach key management, account, security, billing or Ever ID administration;
- be **rotated** without downtime;
- leave an **audit trail**.

An **integration key** (`ew_int_…`) is a third kind of row in `api_keys` (`kind = 'integration'`, next to `personal`
and `fleet-run`). It authenticates as the **integration principal**: `AuthenticatedUser.authMethod = 'integration'`
plus an `integration` block (key id and name, integration kind, tenant, pinned organizations, scopes, owner, act-as).

Connecting is manual (owner decision D1): the workspace owner creates the key in **Settings → API keys** and pastes it
into Gauzy. One-click connect waits for Ever ID; when it comes, only how the principal is authenticated changes.

## 2. User scenarios

- **Given** I own the workspace, **when** I create an integration key named "Ever Gauzy — Acme", pinned to `acme`, with
  the "Ever Gauzy" scope preset, **then** I see the secret `ew_int_…` exactly once, and the key is listed among the
  workspace's integration keys (never among my personal keys, and not counted against my ten).
- **Given** Gauzy holds that key, **when** it calls `GET /api/integrations/v1/whoami`, **then** it learns the
  workspace, the pinned organizations, the scopes, the API version, the change-feed head and its rate limits.
- **Given** Gauzy creates a Task in `acme` with `X-Scope-Slug: acme` and no act-as, **then** the Task is owned by me (the
  key's owner), `createdByType = 'integration'`, `createdById = <key id>`, and an `integration_write` activity row says
  "Ever Gauzy (Ever Gauzy — Acme)".
- **Given** Gauzy sends `X-Act-As-User: <Jane's user id>`, Jane being an active member of the workspace, **then** the
  Task is Jane's (`createdByType = 'user'`, `createdById = Jane`) and the audit row names Jane and the key.
- **Given** a leaked integration key, **when** it calls `POST /api/auth/api-keys`, `/api/account/*`, billing or Ever ID
  admin routes, **then** it gets `403`, whatever scopes it holds.
- **Given** a personal `ew_live_` key, **when** it calls `POST /api/auth/api-keys`, **then** it gets `403` (minting a key
  needs a signed-in person — this closes the existing hole).
- **Given** I rotate the key, **then** I get a new secret on the **same key id**, and the old secret keeps working until
  the grace period ends (24 h by default), so Gauzy can swap it with no downtime.
- **Given** I revoke the key, **then** every call with it answers `401 invalid_key` at once.

## 3. Functional requirements

### 3.1 The key

| Field             | Rule                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ |
| prefix            | `ew_int_` + 64 hex chars; the stored `prefix` fingerprint is the first 12 characters       |
| `kind`            | `'integration'`                                                                            |
| `scopes`          | ≥ 1, each from vocabulary v1 (§3.4); duplicates collapse                                   |
| `organizationIds` | 1–50, each an organization of the creator's tenant; the scalar `organizationId` stays NULL |
| `integrationKind` | `'ever-gauzy'` \| `'generic'` (default `generic`)                                          |
| `description`     | optional, ≤ 500 chars                                                                      |
| `expiresAt`       | optional, in the future                                                                    |
| `tenantId`        | the creator's tenant                                                                       |
| rotation          | `previousHashedKey`, `previousKeyGraceUntil`, `rotatedAt` (§3.6)                           |

- **FR-1 Who may create (EW-P2-6):** the **tenant owner** (pins: any organization of the tenant), or an
  **organization admin** (roster role `admin`, promoted by the tenant owner), who may pin only the organizations they
  administer. The key acts as its creator. Its usable pins are re-read on every request
  (`ApiKeyService.effectivePins`): a demoted or removed admin's key loses those pins at once. The tenant owner lists and
  may revoke every key of the tenant; an admin lists their own.
- **FR-2 Cap:** 20 active, unexpired integration keys per tenant. They do not count against the ten personal keys.
- **FR-3 Session only:** creating and rotating any API key needs `authMethod = 'session'`. A personal key, a fleet-run
  token, an integration key or a delegated Ever ID token gets `403`.
- **FR-4 Listing:** `GET /api/auth/api-keys/integration` lists the active integration keys: every key of the tenant
  for the tenant owner, their own for an organization admin (EW-P2-6), an empty list for anyone else. Each row: name, description, prefix, kind, scopes, pins (with slug and display name), creator,
  created/last-used/expiry/rotation timestamps. Never the secret or a digest.
- **FR-5 Revocation:** `DELETE /api/auth/api-keys/:id` switches an integration key off (`isActive = false`) instead of
  deleting it, so audit rows and webhook subscriptions keep their target. It emits `integration-key.revoked`
  in-process for owners of things that hang off a key (webhooks v2, EW-P1-5).

### 3.2 The principal

- **FR-6** An `ew_int_` credential (in `x-api-key` or `Authorization: Bearer`) is validated against integration rows
  only: active, not expired, at least one pin, and an owner who is active and still in the key's tenant. Any failure is
  `401 invalid_key` in the integration error envelope (§3.7), never a fall-through to cookies.
- **FR-7** The request's `user.userId` is the key's **owner**, unless act-as (FR-11) replaces it on a write.
- **FR-8 Deny by default:** an integration key may only call routes that declare `@RequireScopes(...)`. Every other
  route answers `403 scope_missing` (`details.reason = 'route_not_integration_enabled'`). `@RequireScopes()` with no
  scopes admits any integration key (e.g. `whoami`).
- **FR-9 Scopes:** the key must hold every scope the route lists, else `403 scope_missing` with `details.required` and
  `details.missing`. Sessions and personal keys are never scope-checked.
- **FR-10 Org pin:** the request must name a pinned organization in `X-Scope-Slug` or `X-Organization-Id` (if both are
  sent they must agree). Otherwise `403 org_not_pinned` — including a slug of an unpinned organization, of another
  tenant's organization, or of a person (personal scope). Routes marked `@IntegrationOrgOptional()` may omit it; a header
  that is sent must still be a pin.
- **FR-11 Act-as (writes only):** `X-Act-As-User: <userId>` must name an active user of the key's tenant who is on the
  roster of the target organization; else `403 act_as_forbidden`. The write then runs **as that user**
  (`request.user.userId` is replaced before the handler runs), so every permission and ownership check of the operation
  is that user's own, exactly as if they made it in the app — act-as attributes, it never authorizes. The key's scopes
  and pins apply as well: the effective permission is the intersection of both. On reads the header is ignored: act-as
  never widens what an integration can read.
    - _Roster:_ `organization_members` is not yet an authorization input (access is tenant-wide, the rule
      `OrganizationMembershipService.ensureMember` applies). Act-as uses the same rule today; EW-P1-3 makes the roster
      authoritative and tightens the one method `IntegrationPrincipalGuard.isOnOrganizationRoster`.
- **FR-12 Forbidden routes:** `IntegrationForbiddenGuard` refuses integration keys on key management
  (`/api/auth/api-keys/*`), account (`/api/account/*`, backups, job runtime), security (`/api/auth/*`, `/api/oauth`,
  device auth, model accounts), billing (`/api/billing/*`, `/api/credits`, `/api/subscriptions`, terms) and admin
  (`/api/admin/*`, Ever ID). It is defence in depth on top of FR-8.

### 3.3 Integration API v1: `whoami`

`GET /api/integrations/v1/whoami` (any scope, no org header):

```json
{
	"keyId": "…",
	"keyName": "Ever Gauzy — Acme",
	"integrationKind": "ever-gauzy",
	"tenant": { "id": "…", "slug": "ruslan" },
	"organizations": [{ "id": "…", "slug": "acme", "displayName": "Acme Inc." }],
	"scopes": ["org:read", "…"],
	"apiVersion": "1",
	"feedHead": "0",
	"limits": { "readsPerMin": 3000, "writesPerMin": 600 }
}
```

`/api/integrations/v1/*` answers only integration principals (`401 invalid_key` otherwise). `feedHead` is the global
change-feed head (`DomainEventFeedService.head()`, EW-P1-1, `'0'` while no event has been relayed).

### 3.4 Scope vocabulary v1

`org:read`, `org:write`, `members:read`, `members:write`, `agents:read`, `teams:read`, `teams:write`, `works:read`,
`works:write`, `missions:read`, `missions:write`, `goals:read`, `goals:write`, `ideas:read`, `ideas:write`,
`tasks:read`, `tasks:write`, `inbox:read`, `inbox:write`, `kb:read`, `kb:write`, `email:read`, `email:write`,
`events:read`, `webhooks:manage`, `links:write`.

- The **"Ever Gauzy" preset** is every scope except `org:write` and `email:write` (opt-in).
- **Never grantable:** `goals:activate`, `missions:activate`, `ideas:build` — they are not in the vocabulary (spend
  safety, decision D9).
- Source of truth: `INTEGRATION_SCOPES` in `packages/contracts/src/integrations/integration-keys.types.ts`, mirrored by
  the contract's `whoami.schema.json`.

### 3.5 Limits

A dedicated throttle tier for integration principals, per key: **600 writes/min** and **3000 reads/min** (one bucket
each across all routes; `INTEGRATION_THROTTLE_WRITES_PER_MIN`, `INTEGRATION_THROTTLE_READS_PER_MIN`), plus the 50/s
burst tier (`INTEGRATION_THROTTLE_BURST_PER_SEC`). It replaces the per-route caps (30/min on most writes) for
integration keys only. Over the limit: `429 rate_limited` with `Retry-After`.

### 3.6 Rotation

`POST /api/auth/api-keys/:id/rotate` `{ graceHours?: 0..168 }` (session only, own keys, personal or integration):

- rotation is **in place**: the key id stays, so webhook subscriptions, audit rows and the integration's stored key id
  stay valid;
- the new secret is returned once; the previous digest moves to `previousHashedKey` and is accepted until
  `previousKeyGraceUntil` (24 h default; `0` retires it immediately);
- a second rotation inside the grace window retires the oldest secret: at most two secrets are live.

_Deviation from plan doc 02 §2:_ the plan named a `rotatedFromKeyId` column (rotation as a new row). In-place rotation
was chosen so the key id never changes; `previousHashedKey` + `rotatedAt` replace `rotatedFromKeyId`.

### 3.7 Errors

Integration principals get the contract's envelope `{ "error": { "code", "message", "details"? } }`:
`401 invalid_key`, `403 scope_missing` / `org_not_pinned` / `act_as_forbidden`, `422 domain_rule`, `429 rate_limited`.
Every other caller keeps today's response shapes.

### 3.8 Audit and attribution

- **FR-13** Every successful write with an integration key writes an `activity_log` row: `actionType =
integration_write`, `actorKind = 'external'`, `actorLabel = 'Ever Gauzy (<key name>)'` (or `'Integration (<key
name>)'`), `userId` = the act-as user or the owner, `details = { integrationKeyId, integrationKind, actAsUserId,
ownerUserId, method, route, statusCode, originTag (X-Sync-Origin), resourceId }`. Domain rows (e.g. `task_created`)
  are still written as before.
- **FR-14** Key lifecycle rows: `integration_key_created`, `integration_key_rotated`, `integration_key_revoked`.
- **FR-15** Without act-as, a Task's `createdByType = 'integration'` and `createdById = <key id>`; a chat message's
  `authorType = 'integration'` and `authorId = <key id>`, with an optional display-only
  `externalAuthor { name, avatarUrl?, source }`. The row's owner (`userId`) is the key's owner either way.

### 3.9 Routes open to integration keys in EW-P1-2

| Route                             | Scope         | Notes                                                                                    |
| --------------------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| `GET /api/integrations/v1/whoami` | any           | no org header needed                                                                     |
| `POST /api/tasks`                 | `tasks:write` | starts in `backlog`/`todo`; no `scheduledAt`; cannot relax approvers (`422 domain_rule`) |
| `POST /api/tasks/:id/chat`        | `tasks:write` | `@agent` mentions never dispatch an agent run (D9)                                       |

Everything else stays closed to integration keys until the integration API v1 (EW-P1-4) opens it. Reads across owners
need record visibility (EW-P1-3).

### 3.10 Settings UI (EW-P1-7)

- **Settings → API keys** shows **Integration keys** below the personal keys: name and kind (Ever Gauzy /
  Integration), prefix, pinned organizations, scope count (full list on hover), last use, the grace deadline of a
  recent rotation, and **Rotate** / **Revoke**. Only the workspace owner sees keys; everyone else sees the empty
  state and the owner-only note.
- **New integration key** dialog: name, description, organizations (multi-select; preselected when there is only one),
  preset (**Ever Gauzy** or Custom), a checklist of every v1 scope, and expiry. The Ever Gauzy preset ticks every
  scope except `org:write` and `email:write`, which stay opt-in. The secret is shown once.
- **Deep link** `/settings/api-keys?new=integration&preset=ever-gauzy` opens the dialog with the Ever Gauzy preset.
- **Rotate** dialog: grace period (none, 1 h, 24 h, 3 days, 7 days; default 24 h); the new secret is shown once.
- **Settings → Integrations → Ever Gauzy** (`/settings/integrations/ever-gauzy`, new nav entry): how to connect
  manually, the API URL to paste, a button to the preset dialog, and the active Ever Gauzy keys with Revoke
  (disconnects Ever Gauzy at once). Webhook subscriptions join this card with webhooks v2 (EW-P1-5).

## 4. Non-functional requirements

- Additive only: personal keys, fleet-run tokens, sessions and delegated Ever ID tokens behave exactly as before, except
  that an API key can no longer create or rotate keys (FR-3).
- Migrations on Postgres, MySQL and better-sqlite3, each with a working `down` (`1795060100000-AddIntegrationApiKeys`).
- Secrets are stored as SHA-256 digests only; the plaintext is returned once.

## 5. Out of scope (follow-ups)

- Org-wide reads within pins (EW-P1-3) and the integration resources (EW-P1-4).
- Authoritative roster for act-as (EW-P1-3).
- Ever ID delegated tokens mapping to the same principal (P5).
