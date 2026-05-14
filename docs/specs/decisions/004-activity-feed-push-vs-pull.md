# ADR-004: Activity Feed Per Directory — Dual-Mode Sync (Pull + Push + Disabled)

## Status

**Accepted** — Implemented (PR EW-120). Supersedes the earlier
"push-only" revision of this ADR.

## Date

- 2026-05-13 — Initial (push-only)
- 2026-05-14 — Revised for dual-mode (pull / push / disabled)

## Context

[EW-120](https://evertech.atlassian.net/browse/EW-120) asks for an
Activity Feed tab on each Work's detail page that aggregates:

- **Platform-internal events** the platform already logs (generation
  runs, deployments, item CRUD, settings changes, schedule executions,
  community PRs).
- **Per-Work generation history** from `work_generation_history` rows.
- **Website-sourced events** that happen on the deployed directory
  site after a generated site is live: end-user signups, item
  submissions, and report filings/resolutions.

The first two sources already live in the platform DB. The third
does not — it lives in the deployed Next.js site (typically Vercel,
sometimes k8s) under a different tenancy.

The question is _how the platform learns about category 3_.

## Decision history

This decision flipped three times across the EW-120 PR. The current
version is **dual-mode** — the platform supports both transports
simultaneously and the directory's `works.yml` picks one per Work.

1. **Initial implementation: pull (commits leading up to
   `cd887279`)**. Platform fetches an HMAC-signed
   `/_platform/events` endpoint on each deployed site. Worked
   end-to-end but was flagged in review as "over-engineered": the
   template has to ship a compatible endpoint, and older template
   forks would surface a permanent degraded banner.
2. **Pull reverted, push-only (commits `cd887279` → `0184ac6c`)**.
   Deployed site POSTs each event to a new
   `/api/activity-log/ingest` endpoint on the platform with a
   shared `PLATFORM_API_SECRET_TOKEN`. Much smaller surface, no
   platform-side egress, no per-Work secret management. Greptile
   review approved.
3. **Dual-mode added back (this revision)**. The user wanted both
   options to coexist so site authors can choose:
     - **Pull** is restored as the default to preserve historical
       behaviour and to keep the "old way" available for directories
       that already ship the template endpoint.
     - **Push** stays as an opt-in for directories that prefer the
       lighter-weight one-shot delivery model.
     - **Disabled** lets an operator turn the website-sourced
       categories off entirely.

## Decision

Each Work declares its transport via `activity_sync.mode` in
`works.yml`:

```yaml
activity_sync:
  mode: pull # pull | push | disabled (default: pull)
```

The platform projects the value onto `Work.activitySyncMode` and
routes everywhere downstream by that field. The other transport's
code paths are dormant and rejected with a clean error.

## Mode decision matrix

| Mode       | Platform polls site? | Ingest endpoint accepts? | Deploy pushes `PLATFORM_API_SECRET_TOKEN` | Deploy pushes `PLATFORM_SYNC_SECRET` | Website chips populated |
| ---------- | -------------------- | ------------------------ | ----------------------------------------- | ------------------------------------ | ----------------------- |
| `pull`     | yes, on demand       | **409 mode-mismatch**    | no                                        | yes                                  | yes (via pull fetch)    |
| `push`     | no                   | yes (202)                | yes                                       | no                                   | yes (via ingest)        |
| `disabled` | no                   | **409 mode-mismatch**    | no                                        | no                                   | no                      |

Both transports remain user-facing for the operator; the failure
mode is a clean 409 on the inactive surface, not a 500.

## Pull transport

When `activitySyncMode === 'pull'`:

- `ActivityFeedService.compose` calls `DirectoryWebsiteClient` for
  any `users / submissions / reports / all` category.
- `DirectoryWebsiteClient` issues a `GET` against
  `${work.website}/_platform/events?since=…&limit=…&category=…`
  with `x-platform-timestamp` (ms epoch) + `x-platform-signature`
  (HMAC-SHA256 over `${ts}.${method}.${path}.${query}` with the
  per-Work secret).
- The site verifies the bearer (5-minute clock-skew tolerance, replay
  rejection, constant-time signature compare) before returning events.
- 5s timeout, 0 redirects. Any failure becomes a typed
  `FeedDegradedReason` and a `<DegradedBanner>` on the web side. The
  `platformSyncLastSuccessAt` / `LastErrorAt` / `LastErrorMessage`
  columns track outcomes for the banner's "last seen …" line.
- Pull is **on-demand only** — fetch fires when the user opens the
  Activity Feed tab. No background poller. (Originally considered a
  BullMQ scheduled poller; rejected as unnecessary tail load —
  on-demand is closer to the pre-revert design and scales to zero.)

Per-Work secret lifecycle:

- `PlatformSyncSecretService.getOrGenerate(workId)` runs on every
  deploy via `DeployService.setRequiredSecrets`. First deploy
  generates a fresh 32-byte secret, AES-256-GCM-encrypts with
  `PLATFORM_ENCRYPTION_KEY`, persists to
  `Work.platformSyncSecretEncrypted`. Subsequent deploys read and
  decrypt the existing value.
- Concurrent first-deploys are race-safe via the conditional
  `setPlatformSyncSecretIfNull` UPDATE; the loser re-reads the
  winner's value.
- Rotation is **on-demand only**. `PlatformSyncSecretService.rotate(workId)`
  generates a new secret + persists; the new value only reaches the
  site at the next deploy. The admin UX layer is responsible for
  surfacing the "redeploy required" warning.

## Push transport

When `activitySyncMode === 'push'`:

- The deployed site POSTs each event to
  `${PLATFORM_API_URL}/api/activity-log/ingest` with
  `Authorization: Bearer ${PLATFORM_API_SECRET_TOKEN}`.
- `PlatformSecretGuard` does constant-time bearer compare against
  `process.env.PLATFORM_API_SECRET_TOKEN`. Same-length comparison
  buffer regardless of input length, so the secret's byte length
  isn't recoverable via timing.
- `@Throttle({ limit: 60, ttl: 60_000 })` per-IP cap belt-and-braces
  against a leaked token.
- Idempotency: `activity_log.ingestEventId` column + partial unique
  index on `(workId, ingestEventId) WHERE ingestEventId IS NOT NULL`.
  Retries reuse the same `eventId`; race-recovery catches the unique
  violation and re-queries.
- The platform clamps `occurredAt > now` to "now" so a misbehaving
  template can't park a row above every genuine event.

### Push wire format

```bash
curl -X POST "${PLATFORM_API_URL}/api/activity-log/ingest" \
  -H "Authorization: Bearer ${PLATFORM_API_SECRET_TOKEN}" \
  -H "Content-Type: application/json" \
  --data @- <<'EOF'
{
  "workId":     "11111111-1111-1111-1111-111111111111",
  "eventId":    "22222222-2222-2222-2222-222222222222",
  "actionType": "website_user_registered",
  "occurredAt": "2026-05-13T10:00:00.000Z",
  "summary":    "Alice signed up",
  "metadata":   { "actor": "alice@example.com" }
}
EOF
```

Field rules (enforced by `IngestEventDto` + `class-validator`):

| Field        | Type                | Notes                                                                                                          |
| ------------ | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `workId`     | UUID                | The Work ID — also pushed to the deployed site as the `WORK_ID` env var.                                       |
| `eventId`    | UUID                | Client-generated; **must be stable across retries** for idempotency.                                           |
| `actionType` | enum                | One of `website_user_registered`, `website_item_submitted`, `website_report_filed`, `website_report_resolved`. |
| `occurredAt` | ISO 8601 string     | When the event actually happened (clamped to ≤ now + 5 min server-side).                                       |
| `summary`    | string, ≤ 500 chars | Human-readable one-liner shown in the feed.                                                                    |
| `metadata`   | object, ≤ 8 KiB     | Optional. Free-form. Capped after JSON serialisation.                                                          |

Responses:

| Status | Meaning                                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------------------------- |
| 202    | Accepted. Response body: `{ id: <activity-log row id> }`.                                                            |
| 400    | Validation failed (missing field, bad UUID, unknown action type, etc.).                                              |
| 401    | Missing / invalid bearer token.                                                                                      |
| 404    | `workId` does not exist.                                                                                             |
| **409**| **`{ error: 'mode-mismatch', mode, message }` — the Work's `activitySyncMode` is `pull` or `disabled`, not `push`.** |
| 429    | Rate limit (60 req / min / IP).                                                                                      |
| 503    | `PLATFORM_API_SECRET_TOKEN` is not configured on the platform.                                                       |

## Disabled mode

`activitySyncMode === 'disabled'`:

- The feed renders only platform activity-log + generation history.
- `users / submissions / reports` chips are empty.
- Pull fetch is skipped. Ingest endpoint returns 409.
- Deploy pushes neither `PLATFORM_SYNC_SECRET` nor
  `PLATFORM_API_SECRET_TOKEN`.

The mode is the explicit way for an operator to say "I don't want
the platform to learn anything about my deployed site's user
activity". It's not the same as "no events" — there's no UX
contract that says the chips will eventually populate.

## Mode flip mechanics

Source of truth is `works.yml`; the DB column is the read path. On a
mode flip:

1. Operator edits `works.yml` (via PR to the data repo, or via the
   eventual settings UI — deferred to follow-up).
2. `WorksConfigSyncListener` picks up the change, parses
   `activity_sync.mode`.
3. `WorksConfigImportApplierService.applyActivitySyncMode` writes
   `Work.activitySyncMode`.
4. Next deploy invokes `DeployService.setRequiredSecrets`, which
   pushes the new mode's secrets (and only the new mode's secrets).

In between steps 3 and 4 there is a window where the
DB-recorded mode is the new one but the deployed site still has the
old transport's secret. Practical effects:

- pull → push: pull fetches keep working (decrypt secret still on
  the row) until the next deploy carries the bearer token.
- push → pull: push 409s mode-mismatch (ingest endpoint reads the
  new DB mode). The site's POSTs will fail until the next deploy
  pushes `PLATFORM_SYNC_SECRET` and the site starts answering pulls.
- Any → disabled: ingest 409s; pull fetches don't fire; feed is
  immediately platform-only.

The "next deploy" gap is acceptable for v1 — the operator triggered
the flip and a redeploy is the expected follow-up. Document this
explicitly in the eventual settings UI.

## Schema additions

`works` table (forward-only migration `1778746463309-AddActivityFeedSync`):

| Column                          | Type                                | Notes                                                                                                                              |
| ------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `activitySyncMode`              | varchar(16) NOT NULL DEFAULT 'pull' | Enum: pull / push / disabled.                                                                                                      |
| `platformSyncSecretEncrypted`   | text, nullable                      | Pull-mode only. AES-256-GCM envelope.                                                                                              |
| `platformSyncLastSuccessAt`     | bigint, nullable                    | Pull-mode observability. `@TimestampColumn` (ms-epoch bigint, SQLite/Postgres portable, matches the rest of the codebase pattern). |
| `platformSyncLastErrorAt`       | bigint, nullable                    | "                                                                                                                                  |
| `platformSyncLastErrorMessage`  | text, nullable                      | "                                                                                                                                  |

`activity_log` table (forward-only migration
`1778677529777-AddActivityLogIngestEventId`):

| Column          | Type                | Notes                                                                                          |
| --------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `ingestEventId` | varchar(64) nullable | Push-mode idempotency key. Partial unique index on `(workId, ingestEventId) WHERE NOT NULL`. |

Also: 4 new enum values in `ActivityActionType`
(`WEBSITE_USER_REGISTERED`, `WEBSITE_ITEM_SUBMITTED`,
`WEBSITE_REPORT_FILED`, `WEBSITE_REPORT_RESOLVED`) — only ever
written by the push ingest endpoint, only ever read for push-mode
Works.

## Consequences

### Positive

- **Site authors can choose**. Pull works for directories that
  already shipped the template endpoint; push works for
  directories that haven't (or prefer the lighter contract);
  disabled works for directories that don't want platform-side
  visibility.
- **Both transports use existing platform machinery** — push reuses
  the activity-log table + the existing per-Work feed query; pull
  reuses the encrypted-secret + deploy-time GHA-secret-push paths
  that already shipped (Phase 1 here).
- **Mode flips are mostly transparent**. The DB and works.yml stay
  in sync via the existing sync listener; deploys carry the right
  secrets; the inactive transport returns a typed error.
- **Member visibility preserved** (push-side fix, Phase 3). The
  per-Work feed query bypasses `userId` so members see
  owner-attributed website events.

### Negative / trade-offs

- **Surface area is larger.** Both code paths must be tested and
  maintained. Mitigation: each mode is gated behind a single
  `Work.activitySyncMode` check at the routing boundary; the
  individual code paths (`DirectoryWebsiteClient` for pull,
  `ingestFromWebsite` for push) are independent and don't share
  state.
- **Template-side coupling remains for pull-mode directories.** The
  reviewer's original concern still applies for any Work choosing
  `mode: pull`. Mitigation: push is opt-in, not default — but the
  template still needs to support pull for directories that opt for
  it. The eventual settings-UI page should explain this.
- **Per-Work HMAC secret = ops surface.** `PLATFORM_ENCRYPTION_KEY`
  must be set on the platform for pull mode to work. Without it,
  pull-mode deploys log an error and skip the secret push; pull
  fetches then degrade to `not_provisioned`. Push mode is unaffected
  by this env.

## Implementation map

The PR delivers the dual-mode surface across 8 phases:

1. **Phase 0** — Schema + works.yml plumbing + encryption-key config
2. **Phase 1** — `PlatformSyncSecretService` + WorkRepository helpers
   (resurrected from `a405cdc4`, adapted for the split lastError
   columns; new `rotate()` for the settings-UI follow-up).
3. **Phase 2** — `DirectoryWebsiteClient` + HMAC signing
   (resurrected from `7add7cf5`, gated on `activitySyncMode === 'pull'`).
4. **Phase 3** — `ActivityFeedService` routes by mode (pull → client
   + status writes; push → activity-log with WEBSITE_* types;
   disabled → neither, no degraded).
5. **Phase 4** — Ingest endpoint returns 409 on mode-mismatch;
   `DeployService.setRequiredSecrets` pushes only the active
   transport's secrets.
6. **Phase 5** — Web: resurrect `DegradedBanner`, chip dimming, and
   the 21 `degraded.*` locale strings.
7. **Phase 6** — Settings UI (mode select + rotate-secret button) —
   **deferred to follow-up**. The mechanism already works via
   `works.yml` edits + the existing `WorksConfigSyncListener` →
   `applyActivitySyncMode` projection.
8. **Phase 7** — This ADR rewrite.

## Follow-up

- **Settings UI page**: mode select (pull / push / disabled with
  explainer copy) + "Rotate sync secret" button (pull-mode only,
  with redeploy-required warning).
- **Template-side (`directory-web-template`) wiring**:
    - Pull mode: implement `/_platform/events` with HMAC verification
      against `PLATFORM_SYNC_SECRET`.
    - Push mode: 4 fetch call sites (post-signup, post-submission,
      on-report-create, on-report-resolve) using the env-injected
      `PLATFORM_API_URL` + `PLATFORM_API_SECRET_TOKEN`.
    - Tracked as separate PRs in the template repo.
- **Secret rotation runbook** for the operator handbook.
