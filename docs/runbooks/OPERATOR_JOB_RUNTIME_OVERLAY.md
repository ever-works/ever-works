# Operator runbook — tenant job-runtime overlay (EW-742)

> Companion to [`docs/specs/features/tenant-job-runtime-overlay/`](../specs/features/tenant-job-runtime-overlay/).
> ADR: [ADR-017](../specs/decisions/017-tenant-scoped-job-runtime-overlay.md).
> Tenant counterpart: [`TENANT_JOB_RUNTIME.md`](TENANT_JOB_RUNTIME.md).
> Provider matrix: [`providers.md`](../specs/features/tenant-job-runtime-overlay/providers.md).

What's documented here today:

- **Allow-list gating** (P5, shipped) — controlling which of the 5
  bundled providers tenants can pick.
- **Force-invalidate** procedure with on-call checklist (P2.0, shipped).
- **Per-tenant overlay rollback** — how to put a tenant back on the
  instance default (`mode: inherit`) when a BYO setup goes sideways.

What's _not_ yet here (waiting on phases that haven't landed):

- **Q5 hosting modes** (`shared` / `per-tenant` / `tiered`) — these
  are a P4 worker-host concern. The env var name (`EVER_WORKS_JOB_RUNTIME_HOSTING`)
  is fixed by ADR-017, but the runtime that consumes it lands with P4.
- **Per-tenant whitelist** (P5.1 deferred) — currently a single
  global allow-list applies to every tenant. The fine-grained version
  ships behind the `EVER_WORKS_TENANT_RUNTIME_PER_TENANT_GATING` flag.
- **Reachability probe** (`provisionTenant`) — the form would call it
  on save, but P4 owns implementing it.

## Allow-list gating

The instance operator declares which of the 5 bundled job-runtime
providers (`trigger | temporal | bullmq | pgboss | inngest`) are
exposed to tenants via:

```env
EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS=trigger,temporal
```

Semantics enforced by `config.tenantJobRuntime.getAllowedProviders()`
in `apps/api/src/config/constants.ts`:

| Env value                  | Result                                                                   |
| -------------------------- | ------------------------------------------------------------------------ |
| Unset                      | All 5 bundled providers allowed (default fail-open)                      |
| Empty string / whitespace  | All 5 bundled providers allowed (treated as unset)                       |
| `trigger,temporal`         | Only `trigger` and `temporal` shown to tenants                           |
| `Trigger, TEMPORAL`        | Trimmed + lowercased → `trigger`, `temporal`. Order preserved.           |
| `trigger,trigger,temporal` | Deduped → `trigger`, `temporal`. Operator order preserved.               |
| `unknownid,anotherbadid`   | All-unknown falls back to bundled default (typo safety). Boot log warns. |
| `trigger,unknownid`        | Only `trigger` allowed; unknown silently dropped.                        |

The list order is **preserved** — tenants see providers in the order
you declared them. Use this to nudge the picker default (P5 picks
`availableProviders[0]` when the row is fresh).

### When tenants are on a now-disabled provider

The allow-list is **picker-side + write-side** gated. Existing
overlay rows for a now-disabled provider are NOT migrated, NOT
silently disabled, and NOT auto-reverted to inherit. The rationale:
disabling a provider in the env var is a deployment-time operator
decision; tearing down in-flight tenants without notice would be
worse than leaving the snapshot in place.

What happens:

- The tenant's saved row stays as-is. Runs continue executing against
  the pinned `credentialVersion`.
- The tenant's Settings page shows a warning banner pointing them at
  `Revert to inherit` or a re-pick.
- `PUT /api/account/job-runtime/config` rejects new writes against
  the disabled provider with `400`:
  `provider 'inngest' is disabled by the operator. Allowed providers: trigger, temporal`.

If you need to forcibly revert a tenant's overlay (e.g. you're
retiring a provider entirely and want zero in-flight work against
it), see [Operator-driven rollback](#operator-driven-rollback) below.

### Audit trail

Every overlay-row mutation writes a row to `tenant_job_runtime_audit`
with `operatorAllowedProviders` captured in the `before` / `after`
JSON blobs. Useful for "why does tenant X have provider Y saved
even though we removed Y from the allow-list a month ago?" — the
audit log answers exactly when the operator dropped it from the list
relative to when the tenant wrote the row.

Sample query (PostgreSQL):

```sql
SELECT
    tenant_id,
    occurred_at,
    action,
    after->>'providerId' AS provider,
    after->'operatorAllowedProviders' AS allow_list_at_time
FROM tenant_job_runtime_audit
WHERE tenant_id = '<tenant-uuid>'
ORDER BY occurred_at DESC
LIMIT 20;
```

## Force-invalidate — on-call checklist

`POST /api/account/job-runtime/force-invalidate` is the break-glass
path: bumps `credentialVersion` AND signals worker hosts to drop
in-flight runs against the old snapshot (`reason='credential_force_invalidated'`).

Use only when:

- A tenant's credentials are confirmed compromised (leaked secret,
  contractor offboarding, exposed in a screenshot).
- You're testing the rotation drop path.

Do NOT use for routine rotation — that's `POST /rotate`, which keeps
in-flight work running on the old snapshot until completion.

### Pre-flight

1. **Confirm the tenant ID.** `tenant_job_runtime_config.tenant_id`
   in the DB. Match it against the user/org context that prompted
   the alert.
2. **Check rate-limit window.** Force-invalidate is throttled to
   ≤ 1 / min / tenant in the controller. If the button is greyed,
   wait or escalate (the throttle is a deliberate guard against
   double-firing).
3. **Notify the tenant if possible.** Force-invalidate kills
   in-flight jobs. If you can give them 30 s heads-up via Slack /
   email / status page, do.

### Execute

From the operator console (when wired) or via direct API call (use
your operator credentials, NOT the tenant's):

```bash
curl -X POST https://<api-host>/api/account/job-runtime/force-invalidate \
    -H "Authorization: Bearer $OPERATOR_TOKEN" \
    -H "X-Tenant-Id: <tenant-uuid>"
```

> Note: operator-impersonation header (`X-Tenant-Id`) is a P5.1+
> follow-up. Today, force-invalidate must be triggered _by_ the
> tenant admin (the route uses the auth-session tenant). For
> operator-driven invalidation today, see the SQL fallback in
> [Operator-driven rollback](#operator-driven-rollback).

### Post-flight

1. **Verify the audit row.** A `force_invalidate` row should land
   in `tenant_job_runtime_audit` with the new `credentialVersion`.
2. **Verify in-flight runs failed.** Look for worker host logs with
   `reason=credential_force_invalidated` and matching run records marked
   `FAILED`. (P4 wires this end-to-end; until then the worker host is the
   instance default and force-invalidate bumps the version but cannot drop
   runs the instance worker doesn't know belong to this tenant.)
3. **Confirm the tenant has saved new credentials** before unblocking
   new enqueues — otherwise their next save will be the first
   non-failing run since invalidation.

## Operator-driven rollback

Scenario: you need to put a tenant back on the platform default,
either because BYO blew up or because you're retiring a provider.

### Soft path (preferred)

Ask the tenant admin to click `Revert to inherit` in the Settings
page. This calls `DELETE /api/account/job-runtime/config`, leaves
the audit trail intact, and bumps `credentialVersion`. After this,
the resolver behaves identically to "no overlay row" — instance
default takes over for every new enqueue.

### Hard path (operator-only)

If the tenant is unreachable / the UI is broken / you're retiring a
provider mid-incident, you can force the row to inherit directly:

```sql
BEGIN;

-- Capture the current state for the audit row
WITH old AS (
    SELECT * FROM tenant_job_runtime_config
    WHERE tenant_id = '<tenant-uuid>'
)
UPDATE tenant_job_runtime_config
SET mode = 'inherit',
    credentials_secret_ref = NULL,
    credential_version = credential_version + 1,
    updated_at = NOW()
WHERE tenant_id = '<tenant-uuid>';

-- Write the operator-driven audit row
INSERT INTO tenant_job_runtime_audit
    (id, tenant_id, actor_user_id, action, before, after, credential_version, occurred_at)
VALUES (
    gen_random_uuid(),
    '<tenant-uuid>',
    NULL,                                       -- NULL actor = operator/SQL path
    'operator_revert_to_inherit',
    (SELECT row_to_json(old) FROM old),
    (SELECT row_to_json(t) FROM tenant_job_runtime_config t
        WHERE tenant_id = '<tenant-uuid>'),
    (SELECT credential_version FROM tenant_job_runtime_config
        WHERE tenant_id = '<tenant-uuid>'),
    NOW()
);

COMMIT;
```

Document the reason in your operator incident log AND post a
follow-up to the tenant admin so they see why their setup changed.

## Removing a provider from the bundled set

The 5 bundled providers (`trigger | temporal | bullmq | pgboss |
inngest`) are pinned in two places:

- `BUNDLED_TENANT_JOB_RUNTIME_PROVIDERS` in `apps/api/src/config/constants.ts`
- `TENANT_JOB_RUNTIME_PROVIDER_IDS` in
  `apps/api/src/account/tenant-job-runtime/dto/upsert-tenant-job-runtime.dto.ts`

A drift spec asserts they stay equal. To add/remove a provider:

1. Edit both constants in lockstep.
2. Run `pnpm test --filter ever-works-api -- tenant-job-runtime` to
   confirm the drift spec passes.
3. If removing: file a migration story — the DTO enum change is a
   hard contract break for any tenant currently on the removed
   provider. Coordinate with affected tenants BEFORE the deploy.

Note that removing a provider from the env var (`EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS`)
is a soft disable — tenants stay on the snapshot and can revert.
Removing it from the bundled set is a hard disable — the API enum
itself rejects the value, so even existing rows can't be re-saved.

## Trigger.dev — tenant BYO is supported; project provisioning remains a click action

Quick reference for what the platform does and does not do for
tenants who pick `trigger` as their job runtime:

- **Tenant `inherit`** — tenant runs against the platform's shared
  Trigger.dev project (the operator's). Per-tenant isolation inside
  that shared project is provided by `concurrencyKey: tenantId` +
  `externalId: tenantId` on every dispatch, per [Trigger.dev's
  per-tenant queuing guide][trigger-concurrency] and [their
  multi-tenant applications page][trigger-multitenant]. Operator
  owns the Trigger.dev account, the billing, and the project ref.
- **Tenant `byo` / `override`** — tenant supplies its own
  Trigger.dev account credentials (`accessToken`, `secretKey`,
  `projectRef`, optional `apiUrl` for self-host). The platform
  routes that tenant's runs through the tenant's project. The
  operator never sees the tenant's workload data plane on
  Trigger.dev. Conformance probe runs on save before persisting.

The previous "one Trigger.dev project per tenant" plan was rejected
after [Trigger.dev's 10-project-per-org cap][trigger-limits] surfaced
during EW-742 implementation review (2026-06). Trigger.dev's own
vendor docs call per-tenant projects an anti-pattern; the runtime-
scoping pattern (single project + `concurrencyKey` + `externalId`)
is now the design across all three tenant modes.

[trigger-limits]: https://trigger.dev/docs/limits#projects
[trigger-multitenant]: https://trigger.dev/docs/deploy-environment-variables#multi-tenant-applications
[trigger-concurrency]: https://trigger.dev/docs/queue-concurrency#concurrency-keys-and-per-tenant-queuing

### Operator-side: Trigger.dev project creation is click-only

There is **no programmatic project creation** exposed in our
runtime. Trigger.dev's `create_project_in_org` capability exists only
in Trigger.dev's own MCP server (`mcp__trigger__*`), not in the
public REST/CLI surface that the platform's worker/dispatcher loops
call. This is intentional and matches the vendor's tenancy
guidance.

Consequences for operators:

- **Onboarding a new operator-owned Trigger.dev project** — log into
  the Trigger.dev dashboard, click `Create new project`, copy the
  resulting `projectRef` + secret key into the operator's runtime
  config (env / k8s Secret). Same flow you'd run for any new
  Trigger.dev account.
- **Onboarding a tenant in `byo` / `override` mode** — there is
  nothing for the operator to do on Trigger.dev itself. The tenant
  does the dashboard click flow against their own account, pastes
  the resulting values into the tenant settings form, and the save
  triggers the conformance probe. The operator-side concern is
  only: is the tenant on a tier where they're allowed to pick
  `trigger` at all (see the allow-list gating section above)?
- **Rotating the operator-owned Trigger.dev project secret** — same
  flow as any operator secret rotation: regenerate in the
  Trigger.dev dashboard, push the new value through the env / k8s
  Secret pipeline, redeploy. Per-tenant `inherit` traffic picks up
  the new secret at next pod rollover.

## Pre-deploy checklist

Before deploying a change that touches `EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS`:

- [ ] `kubectl get secret -n ever-works runtime-env -o yaml` confirms
      the env var is being set at the secret layer (k8s deployments
      ride on the runtime-env Secret forwarding pipeline; see
      `directory-web-template` deploy workflow).
- [ ] Diff the new value against the previous: any provider being
      removed?
- [ ] If yes — query the audit DB for tenants currently on the
      removed provider (see SQL snippet below).
- [ ] Notify any tenants found before rolling out, or accept they'll
      hit the picker-side warning banner on next visit.
- [ ] Verify the new allow-list parses correctly post-deploy via the
      API call `curl https://<api>/api/account/job-runtime/available-providers`
      (auth required; use any tenant's token).

Removed-provider lookup snippet:

```sql
SELECT tenant_id, provider_id, updated_at
FROM tenant_job_runtime_config
WHERE provider_id = '<removing>' AND mode != 'inherit';
```

## Glossary

- **Bundled providers** — the 5 hard-coded provider ids in the API
  enum: `trigger`, `temporal`, `bullmq`, `pgboss`, `inngest`.
- **Allow-list** — subset of bundled providers the operator exposes
  to tenants via `EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS`.
- **Soft disable** — provider removed from the allow-list. Existing
  rows preserved; new writes rejected.
- **Hard disable** — provider removed from `BUNDLED_TENANT_JOB_RUNTIME_PROVIDERS` /
  `TENANT_JOB_RUNTIME_PROVIDER_IDS`. Existing rows can't be re-saved
  because the DTO enum rejects the value.
- **Inherit** — overlay row delegates to the instance default. Same
  resolver behaviour as "no overlay row".
- **Force-invalidate** — break-glass: bump version + drop in-flight.
  Rate-limited.
