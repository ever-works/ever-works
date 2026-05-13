# ADR-004: Activity Feed Per Directory — Push From Website, Not Pull From Platform

## Status

**Accepted** — Implemented (PR EW-120)

## Date

2026-05-13

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

## Considered alternatives

### Option A — Pull (HMAC-signed aggregator endpoint)

Originally implemented (commits `48077d85` and predecessors, since
reverted in `cd887279`):

- New `/api/platform/activity-feed` endpoint on every deployed site,
  protected by HMAC-SHA256 signing with a per-Work shared secret.
- Per-Work secret generated lazily on first deploy, stored
  AES-256-GCM-encrypted on the `works` row (4 new columns:
  `platformSyncSecretEncrypted`, `platformSyncEnabled`,
  `platformSyncLastSuccessAt`, `platformSyncLastError`).
- Platform `ActivityFeedService` reaches out HTTP-side to every Work's
  deployed URL and merges the response into the feed.
- A `DegradedBanner` UI surfaces network/timeout/unauthorized states.

Why it was rejected:

1. **Couples the feature to template ownership.** The deployed-site
   endpoint must exist for the feature to work. The Work template
   (`directory-web-template`) is shipped as a separate repo and is
   forkable / customer-modifiable. A user on an older template fork
   gets the degraded banner forever, on the platform UI they own.
2. **Encryption + key management for one consumer.** The codebase
   has no other AES-256-GCM helper. Adding it for one feature means
   maintaining a `PLATFORM_ENCRYPTION_KEY` ops contract going
   forward.
3. **Migration with 4 nullable columns + boolean default** for a
   feature that doesn't need its own persistence surface — these
   are observability shims around the cache layer.
4. **Egress from the platform.** Every feed read fans out HTTP calls
   to N customer-deployed sites. Latency, retries, partial failures,
   noisy-neighbour timeouts all become the feed renderer's problem.
5. **DX impedance.** The Spec Kit trio (`spec.md` / `plan.md` /
   `tasks.md`, ~700 LOC) had to document the degraded-mode contract,
   the encryption envelope, the HMAC binding, the timing-window
   replay-protection window, the secret-rotation runbook — all for
   a feature that surfaces ~4 event types.

### Option B — Push (this ADR)

The deployed site **POSTs** events to a platform endpoint as they
happen:

- New `POST /api/activity-log/ingest` on the platform, protected by a
  shared `PLATFORM_API_SECRET_TOKEN` bearer.
- Events are persisted as ordinary `activity_log` rows with one of
  four new action types (`WEBSITE_USER_REGISTERED`,
  `WEBSITE_ITEM_SUBMITTED`, `WEBSITE_REPORT_FILED`,
  `WEBSITE_REPORT_RESOLVED`).
- The feed reads from `activity_log` like every other category —
  no aggregator, no cache, no degraded-mode UI.

## Decision

The platform exposes a push endpoint; the deployed website
authenticates with a platform-wide shared token and POSTs an event
for each user-facing action it wants surfaced.

## Consequences

### Positive

- **Single source of truth.** Website events become ordinary
  activity-log rows the moment they're observed. The same row that
  drives the per-Work feed also feeds future global filters, CSV
  export, analytics dispatch — for free.
- **No template-side prerequisite for the feature itself to ship.**
  The platform PR is mergeable without coordinating a template
  release. Older template forks simply don't push events; their
  owners see an empty users/submissions/reports bucket instead of a
  permanent "Deployed-site events temporarily unavailable" banner.
- **One shared secret, not N per-Work secrets.** The bearer token is
  set in the platform's env and pushed to every deploy alongside
  `WORK_ID` / `PLATFORM_API_URL`. The platform-side
  `PlatformSecretGuard` does a constant-time `timingSafeEqual`
  against `process.env.PLATFORM_API_SECRET_TOKEN`.
- **Idempotency built-in.** Each POST carries a client-generated
  `eventId` (UUID); the partial unique index on
  `(workId, ingestEventId)` makes retries safe.
- **No platform → website egress.** The platform never reaches out to
  customer-owned URLs. Renders are pure DB reads.

### Negative / trade-offs

- **The platform now exposes a public POST endpoint.** Mitigated by
  the bearer guard, class-validator allow-listing of WEBSITE_*
  action types only, payload size limits, the global throttler, and
  attribution to the Work owner (the event author isn't trusted to
  set `userId`).
- **The deployed site must be updated** for the
  users/submissions/reports filter buckets to populate. Templates
  shipped before EW-120 will show platform-only events; this is the
  correct default (it's an additive feature, not a regression).
- **One trust boundary across all Works.** A leaked
  `PLATFORM_API_SECRET_TOKEN` lets an attacker write to any Work's
  feed. Rotation is operator-side (env update + redeploy fans the
  new value out to every Work via `DeployService.setRequiredSecrets`).

### Authentication choice — why not OAuth or per-deploy tokens?

- **Per-deploy tokens** were the pull-architecture model. Same
  generation/encryption/rotation overhead, no real isolation
  improvement (the platform's own DB is the trust root anyway).
- **OAuth** assumes a human actor at the deployed-site end; here the
  actor is the site's own server-side handler reacting to a user
  action. A long-lived bearer matches the actual trust model.

## Implementation

- Schema migration: `1778677529777-AddActivityLogIngestEventId`.
  Adds `activity_log.ingestEventId` (varchar 64, nullable) +
  partial unique index `(workId, ingestEventId) WHERE ingestEventId
  IS NOT NULL`.
- Push endpoint: `apps/api/src/activity-log/activity-log.controller.ts`
  → `POST /api/activity-log/ingest`, decorated `@Public()` +
  `@UseGuards(PlatformSecretGuard)`.
- Guard: `apps/api/src/activity-log/guards/platform-secret.guard.ts`
  — constant-time bearer check against
  `process.env.PLATFORM_API_SECRET_TOKEN`.
- DTO: `apps/api/src/activity-log/dto/ingest-event.dto.ts` —
  class-validator constraints (UUIDs, ISO timestamp, allow-listed
  enum, summary length cap).
- Service: `ActivityLogService.ingestFromWebsite` in
  `packages/agent/src/activity-log/activity-log.service.ts` — checks
  idempotency, attributes the row to the Work owner, delegates to the
  existing `log()` path.
- Deploy push: `DeployService.setRequiredSecrets` pushes `WORK_ID`,
  `PLATFORM_API_URL`, and `PLATFORM_API_SECRET_TOKEN` as GitHub
  Actions secrets so the deployed site can authenticate. Skipped
  gracefully when the platform env is not configured.
- Feed: `users`, `submissions`, `reports` filter buckets now route
  to the corresponding `WEBSITE_*` action types in
  `ActivityFeedService`.

## Wire format

The deployed site authenticates with the platform-wide bearer
token (`PLATFORM_API_SECRET_TOKEN`, pushed by `DeployService` as a
GitHub Actions secret on every deploy) and POSTs JSON to
`${PLATFORM_API_URL}/api/activity-log/ingest`.

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

| Field        | Type                | Notes                                                                                          |
| ------------ | ------------------- | ---------------------------------------------------------------------------------------------- |
| `workId`     | UUID                | The Work ID — also pushed to the deployed site as the `WORK_ID` env var.                       |
| `eventId`    | UUID                | Client-generated; **must be stable across retries** for idempotency.                           |
| `actionType` | enum                | One of `website_user_registered`, `website_item_submitted`, `website_report_filed`, `website_report_resolved`. |
| `occurredAt` | ISO 8601 string     | When the event actually happened. Used as the row's `createdAt` so the feed orders by real time. |
| `summary`    | string, ≤ 500 chars | Human-readable one-liner shown in the feed.                                                    |
| `metadata`   | object, ≤ 8 KiB     | Optional. Free-form. Capped after JSON serialisation.                                          |

Responses:

| Status | Meaning                                                                  |
| ------ | ------------------------------------------------------------------------ |
| 202    | Accepted. Response body: `{ id: <activity-log row id> }`.                |
| 400    | Validation failed (missing field, bad UUID, unknown action type, etc.).  |
| 401    | Missing / invalid bearer token.                                          |
| 404    | `workId` does not exist.                                                 |
| 429    | Rate limit (60 req / min / IP).                                          |
| 503    | `PLATFORM_API_SECRET_TOKEN` is not configured on the platform.           |

Retries: the website should retry on 5xx and on network errors,
reusing the same `eventId`. The partial unique index on
`(workId, ingestEventId)` makes the second POST a no-op that
returns the original row's id.

## Follow-up

- Template-side wiring (`directory-web-template` repo): add 4 fetch
  call sites (post-signup, post-submission, on-report-create, on-report-resolve)
  using the env-injected `PLATFORM_API_URL` +
  `PLATFORM_API_SECRET_TOKEN`. Tracked as a separate PR.
- Secret rotation runbook: documented as part of the platform
  operator handbook (out of scope for this ADR).
