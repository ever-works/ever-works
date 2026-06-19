# Tenant job-runtime overlay — migration guide (EW-742 P7 / T44)

> Companion to [`TENANT_JOB_RUNTIME.md`](TENANT_JOB_RUNTIME.md) (tenant admin runbook)
> and [ADR-017](../specs/decisions/017-tenant-scoped-job-runtime-overlay.md) (graceful drain rationale).
> Spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../specs/features/tenant-job-runtime-overlay/spec.md).
> Operator counterpart: [`OPERATOR_JOB_RUNTIME_OVERLAY.md`](OPERATOR_JOB_RUNTIME_OVERLAY.md).

This guide is for tenant admins migrating between overlay modes —
opting INTO BYO, rotating BYO credentials, or rolling BACK to the
platform default. It assumes you have already read the tenant runbook;
the procedures here name fields and buttons from that runbook rather
than re-defining them.

It is intentionally narrow. It does NOT cover:

- the operator-side rollback procedure (see the operator runbook;
  operators use SQL to revert a tenant when the tenant cannot self-serve);
- writing the BYO credentials themselves (each provider's plugin README
  ships its own credential setup — see [`providers.md`](../specs/features/tenant-job-runtime-overlay/providers.md));
- the schema-driven credentials form (P2.2 — currently a deferred
  follow-up; until it ships you set `credentialsSecretRef` as an opaque
  pointer to your secret-store entry).

## The version-pinning mechanic (read this first)

Every overlay-row mutation bumps the per-tenant `credentialVersion`
counter. The platform stamps `(tenantId, credentialVersion)` onto every
run record at enqueue time. The worker host resolves credentials by
that pair — NOT by reading the current row state. So:

- In-flight runs always finish against the credential version that was
  active when they were enqueued.
- New enqueues see the new version immediately on the next dispatch.
- The dispatcher and worker host disagree on "current" credentials for
  the duration of an in-flight run — that's the design, not a bug.

This is called **graceful drain** and is locked in
[ADR-017 §3 / Q4](../specs/decisions/017-tenant-scoped-job-runtime-overlay.md#q4--credential-rotation-strategy).
Every migration below either relies on graceful drain or deliberately
bypasses it (force-invalidate). Knowing which is which is the whole
point of this guide.

## Scenario A — `inherit` → `byo` (first-time opt-in)

You are on the platform default today and want to point this tenant at
your own Trigger.dev project (or Temporal cluster, or BullMQ Redis,
etc.). Nothing is in flight that needs special handling — `inherit`
runs were never tagged with a tenant credential version.

**Procedure:**

1. Provision the underlying credential in your secret store. The
   pointer format depends on what the operator has wired. Examples:
   `vault:secret/tenants/acme/temporal`,
   `k8s:tenant-acme-trigger-credentials`,
   `env:TENANT_ACME_TRIGGER`,
   `infisical:<workspaceId>/prod/tenants/acme`,
   `doppler:ever-works/prod/TENANT_ACME_TRIGGER`. Ask the operator
   which schemes are wired — the platform never stores plaintext, so
   the pointer convention is operator-specific. The default ships with
   `inline:` (dev only) + `env:` (self-hoster path).
2. On **Settings → Job Runtime**, pick `mode: byo`, pick the provider
   from the picker (only operator-allow-listed providers appear —
   see the tenant runbook ["Why is provider X missing?"](TENANT_JOB_RUNTIME.md#why-is-provider-x-missing)),
   paste the secret pointer into `credentialsSecretRef`, leave
   `enabled: true`, click **Save**.
3. Verify the row landed: `credentialVersion` should bump from `0` /
   absent to `1`. The audit-log row written by this save has
   `action = 'config_upsert'` and `operatorAllowedProviders` snapshot
   so you can later prove what the allow-list looked like at write time.

**What happens to runs that were already queued?** They were enqueued
with no tenant `credentialVersion` (because you had no overlay row);
the worker host treats that as "no tenant overlay was active when this
was enqueued" and runs them against the instance default. Same path
as if you'd never touched the overlay. No special handling needed.

**Rollback if BYO is wrong:** Click **Revert to inherit** (see
[Scenario C](#scenario-c--byo--inherit-rollback)). The next enqueue
goes back to the instance default; in-flight BYO runs continue against
the pinned BYO snapshot until they complete.

## Scenario B — `byo` → rotate BYO credentials

You rotated the underlying secret in your secret store and want new
runs to use the new value. **In-flight runs must not break.** This is
the everyday "we rotated keys, did the right thing happen?" workflow.

**Procedure:**

1. Confirm the current row state:

    ```bash
    curl -s -X GET https://app.ever.works/api/account/job-runtime/config \
        -H "Cookie: $YOUR_SESSION_COOKIE" | jq .
    # → { mode: 'byo', providerId: 'trigger', credentialVersion: 7,
    #     credentialsSecretRef: 'vault:secret/tenants/acme/trigger', ... }
    ```

    Note the `credentialVersion` (here: 7). Any in-flight run was
    enqueued at version 7 or earlier.

2. Rotate the underlying secret in your secret store. The
   `credentialsSecretRef` POINTER does not change — only the value it
   points at changes. (If the pointer itself changes, use `PUT /config`
   from the UI; same outcome version-wise.)

3. Click **Rotate** on the Settings page (or `POST /api/account/job-runtime/rotate`).
   This bumps `credentialVersion` from 7 → 8 in a single TypeORM
   `UPDATE ... SET "credentialVersion" = "credentialVersion" + 1`
   round-trip (no read-modify-write window). Audit row:
   `action = 'rotate'`.

4. Verify the bump:

    ```bash
    curl -s -X GET https://app.ever.works/api/account/job-runtime/config \
        -H "Cookie: $YOUR_SESSION_COOKIE" | jq '.credentialVersion'
    # → 8
    ```

5. From this moment forward, every new enqueue resolves against
   version 8 → reads the new secret value. Runs still on version 7
   finish against the OLD pinned snapshot (graceful drain).

**Monitoring drain progress:** there is no in-product "X runs still on
version 7" counter today. Operators can query the run-record table
directly (see the operator runbook). For most tenants the drain is
sub-minute because most jobs are short-lived; long-running jobs (e.g.
content-import pipelines) may stay on the old version for the full job
duration.

**Common confusion:** "I rotated but new runs are still failing — did
rotation not take?" Almost always: the new secret value is wrong in
your secret store. Rotation only bumps the pointer-version, it
doesn't validate the underlying credential. Check the worker logs for
auth-rejection errors against the NEW version, not the old one.

## Scenario C — `byo` → `inherit` (rollback)

BYO broke. You want to fall back to the platform default fast.

**Procedure:**

1. Click **Revert to inherit** on the Settings page (or `DELETE /api/account/job-runtime/config`).
   This:
    - Sets `mode = 'inherit'` on the overlay row.
    - Clears `credentialsSecretRef` to `NULL`.
    - Bumps `credentialVersion` so any in-flight BYO runs that capture
      the new version (none should, since `mode = 'inherit'` writes no
      version stamp) see the rollback immediately.
    - Writes an audit row with `action = 'revert_to_inherit'`.

2. From this moment forward, every new enqueue resolves to the
   instance default — no overlay credentials involved.

3. In-flight BYO runs continue against their pinned BYO snapshot until
   they complete. This is intentional: rolling back to inherit should
   NOT drop in-flight work. If you also need to drop in-flight work
   (e.g. the BYO credential is actively compromised), use
   force-invalidate FIRST, then revert (see [Scenario D](#scenario-d--force-invalidate-emergency-rollback)).

**Why the row stays:** the entity row remains in the database with
`mode = 'inherit'` rather than being deleted. This preserves the
audit trail (`tenant_job_runtime_audit` carries the row's whole
history; the row itself anchors the FK). Functionally
indistinguishable from "no row at all" — the resolver returns the
instance default in both cases.

## Scenario D — force-invalidate (emergency rollback)

The break-glass path. Use ONLY when:

- Credentials are confirmed compromised (contractor with access left,
  secret leaked into a screenshot, secret-store breach, etc.).
- You explicitly need to drop in-flight runs against the old
  snapshot, not just stop new ones.

This is NOT routine rotation. Routine rotation uses **Scenario B**.

**Procedure:**

1. Rotate the underlying secret in your secret store FIRST (so the
   old value is dead even if drain takes time).

2. Click **Force-invalidate** on the Settings page (or `POST /api/account/job-runtime/force-invalidate`).
   This:
    - Bumps `credentialVersion` (same as **Rotate**).
    - Writes an audit row with `action = 'force_invalidate'`.
    - Signals the worker host to drop any in-flight runs whose pinned
      `credentialVersion` is now < current, with
      `reason = 'credential_force_invalidated'`.

3. Rate-limited at ≤ 1 / minute / tenant in the controller. If you
   hit the throttle the response is `429 Too Many Requests` and the
   UI surfaces it inline ("force-invalidate rate-limited — try again
   in N s"). The rate-limit prevents an operator footgun, not a
   security issue.

4. Re-enqueue any work you needed dropped runs to complete. The
   dropped run records carry the `credential_force_invalidated` reason
   so your re-enqueue script can filter them out of automated retry
   logic if needed.

5. If you also need to roll back to inherit (not just rotate),
   **Revert to inherit** AFTER the force-invalidate.

**When force-invalidate is wrong:** if the goal is "the old key
should not be used anywhere again", Scenario B (Rotate) achieves that
just as well for NEW enqueues, AND lets in-flight work complete.
Force-invalidate is for "the old key MUST NOT continue running
in-flight work" — typically credential-compromise scenarios.

## Failure modes and recovery

| Symptom                                                           | Likely cause                                                                                 | Recovery                                                                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| BYO save returns `400` "provider 'X' is disabled by the operator" | Operator removed `X` from `EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS` since you last saved | Pick a different allow-listed provider OR ask operator to re-add `X`                                              |
| New enqueues immediately fail auth against the provider           | `credentialsSecretRef` points at an empty / wrong secret OR provider rejects the credential  | Verify the underlying secret value in your secret store; if value is fine, double-check the pointer string itself |
| In-flight runs fail after rotation                                | Rotation should NOT affect in-flight runs (graceful drain) — investigate the run record      | Pull the run record's `credentialVersion`; if it matches the old version, the OLD snapshot was the problem        |
| Picker is empty                                                   | Operator allow-list is `[]` OR your auth session has no tenant attached                      | Check `GET /api/account/job-runtime/available-providers` returns a non-empty `providers` array                    |
| `Force-invalidate` returns `429`                                  | Hit the 1 / minute / tenant rate-limit                                                       | Wait the throttle window the response surfaces; do not retry tighter                                              |
| `credentialsSecretRef` points at a missing secret-store entry     | Secret was deleted out-of-band                                                               | Restore the entry OR pick a different pointer via `PUT /config` (bumps version)                                   |
| `Revert to inherit` saved but new runs still hit BYO credentials  | A run was enqueued BEFORE the revert and still has the old `credentialVersion`               | Wait for graceful drain to finish, OR use **Force-invalidate** to drop in-flight                                  |

## Verification queries

All require an authenticated request from a user attached to this
tenant (1 User : 1 Tenant — no `:tenantId` path parameter).

**Current overlay state:**

```bash
curl -s -X GET https://app.ever.works/api/account/job-runtime/config \
    -H "Cookie: $YOUR_SESSION_COOKIE" | jq .
# → { mode, providerId, credentialVersion, credentialsSecretRef (redacted), enabled, updatedAt, ... }
```

**Operator allow-list (does this tenant see provider X?):**

```bash
curl -s -X GET https://app.ever.works/api/account/job-runtime/available-providers \
    -H "Cookie: $YOUR_SESSION_COOKIE" | jq '.providers'
# → ["trigger", "temporal", ...]
```

**Audit-log read (operator-side only today — surfacing to tenant UI
is a P2.2+ follow-up):** operators query the platform DB directly:

```sql
SELECT action, "credentialVersion", "occurredAt",
       before->>'mode' AS old_mode,
       after->>'mode' AS new_mode,
       after->'operatorAllowedProviders' AS allowed_at_write_time
FROM tenant_job_runtime_audit
WHERE "tenantId" = '<your-tenant-uuid>'
ORDER BY "occurredAt" DESC
LIMIT 20;
```

If you need this read and don't have DB access, ask the operator —
self-serve audit-log UI is part of the schema-driven admin follow-up
(P2.2+).

## Cross-references

- Day-to-day overlay operations: [`TENANT_JOB_RUNTIME.md`](TENANT_JOB_RUNTIME.md)
- Operator procedures (allow-list, force-invalidate-on-behalf, hard SQL rollback): [`OPERATOR_JOB_RUNTIME_OVERLAY.md`](OPERATOR_JOB_RUNTIME_OVERLAY.md)
- Per-provider isolation matrix (Temporal namespace, pg-boss schema, etc.): [`docs/specs/features/tenant-job-runtime-overlay/providers.md`](../specs/features/tenant-job-runtime-overlay/providers.md)
- Behaviour spec (FR-5 graceful drain): [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../specs/features/tenant-job-runtime-overlay/spec.md)
- Decision record (Q4 rotation strategy locked): [ADR-017](../specs/decisions/017-tenant-scoped-job-runtime-overlay.md)

## Glossary

- **Graceful drain** — rotation strategy where in-flight runs keep
  their pinned `credentialVersion` snapshot while new enqueues resolve
  against the bumped version. See [ADR-017 Q4](../specs/decisions/017-tenant-scoped-job-runtime-overlay.md#q4--credential-rotation-strategy).
- **Force-invalidate** — break-glass: bump version AND signal worker
  host to drop in-flight runs against the old snapshot. Rate-limited.
- **Credential version** — monotonic per-tenant counter on the overlay
  row. Stamped onto every run at enqueue time.
- **Pointer / `credentialsSecretRef`** — opaque string (≤ 128 chars)
  into the operator's secret store. The platform never stores
  plaintext credentials.
