# Tenant job-runtime overlay — tenant admin runbook (EW-742)

> Companion to [`docs/specs/features/tenant-job-runtime-overlay/`](../specs/features/tenant-job-runtime-overlay/).
> ADR: [ADR-017](../specs/decisions/017-tenant-scoped-job-runtime-overlay.md).
> Provider matrix: [`providers.md`](../specs/features/tenant-job-runtime-overlay/providers.md).
> Operator counterpart: [`OPERATOR_JOB_RUNTIME_OVERLAY.md`](OPERATOR_JOB_RUNTIME_OVERLAY.md).

This runbook covers what a tenant admin can do today from the in-product
**Settings → Job Runtime** page (P0–P2.1 + P5 on `main`). It is the
canonical "how do I do X" for tenants who want to pick a different
background-jobs provider than the platform default, bring their own
credentials, or rotate them.

What is _not_ here yet:

- **Per-tenant credential injection** (EW-742 P3 byo/override modes).
  The tenant-aware resolver (PR #1380, in flight) reads the overlay
  row and returns the instance default as a conservative stopgap; the
  credential-binding API needed to actually swap the active provider's
  credentials per tenant is EW-686 P2 territory and lands separately.
  Until then, BYO/override is a configuration-only knob: the platform
  records the choice + version + audit row, but every run still
  executes against the instance default. The in-app banner says this
  explicitly when you opt in.
- **Worker-host per-tenant routing** (P4) — webhooks, namespace
  pollers, queue prefixing. Depends on P3 + EW-686 P2 landing first.
- Schema-driven per-provider credentials form (P2.2). The current UI
  collects an opaque `credentialsSecretRef` pointer; per-provider
  fields (e.g. Temporal namespace + address + cert) come in the next
  UI sub-phase.

What _has_ landed since this runbook was first written:

- **EW-685 P0 — fully shipped** (T1–T6): `IJobRuntimeProvider`
  capability contract, `EVER_WORKS_JOB_RUNTIME` env selector + the
  `isExperimentalProvider()` config check, the binding factory at
  `packages/agent/src/tasks/job-runtime.providers.ts`, the
  Constitution Principle IV amendment, and the boot-time log line
  that prints the active runtime id on API startup.
- **EW-686 P1** — `TriggerService` now structurally implements
  `IJobRuntimeProvider` (PR #1372 on main). The existing direct
  `useExisting: TriggerService` DI bindings still ship, so call
  sites haven't moved; the registry-driven factory is wired but
  the cutover-PR to flip the bindings is a separate follow-up.
- **EW-742 P3 minimal subset** (PR #1380, in flight) — the
  `TenantAwareRuntimeResolver` reads the overlay row and resolves
  to the active provider with the inherit / fallback path proven by
  tests; the byo/override credential-injection part is the deferred
  piece described above.
- **EW-742 P3.1 T21** (PR #1381, in flight) — `TenantCredentialCache`
  ships as a standalone class for the resolver and the future P4
  worker host to layer in without coupling.

## When to use this

Three concrete scenarios:

1. **You want to keep using the platform default** — do nothing. The
   row defaults to `mode: inherit`. The picker on the Settings page
   shows a banner ("currently inheriting from the instance default").
2. **You want to bring your own Trigger.dev / Temporal / etc.** — pick
   `mode: byo`, select a provider, save a `credentialsSecretRef`
   pointing at your secret-store entry (Vault / k8s Secret / 1Password
   reference depending on the operator's secrets layer).
3. **You want to fully override the platform's choice of provider** —
   pick `mode: override`. Semantically identical to BYO at the API
   level today; the distinction exists so the platform can later
   gate certain providers to "operator must explicitly approve" vs
   "self-serve allowed" (a P5.1 follow-up — currently both modes
   resolve the same way).

## What you'll see on the Settings page

Navigate to **Dashboard → Settings → Job Runtime** (`/[locale]/dashboard/settings/job-runtime`).

The page renders four read-only state badges at the top:

| Badge                | What it means                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `Mode`               | `inherit` / `byo` / `override` — current overlay row                                     |
| `Provider`           | One of the operator-allowed providers (or `—` when `mode: inherit`)                      |
| `Credential version` | Monotonic per-tenant counter; bumps on every credential change, rotate, force-invalidate |
| `Last updated`       | `updatedAt` of the overlay row (defaults to row creation if never touched)               |

Below the badges, an editable form:

- **Provider picker** — a `Select` populated from `GET /api/account/job-runtime/available-providers`.
  Only providers the instance operator has allow-listed via
  `EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS` appear here.
  See [Why is provider X missing?](#why-is-provider-x-missing).
- **Mode picker** — `inherit | byo | override`.
- **Enabled switch** — soft kill-switch for the overlay row without
  deleting it. `enabled: false` + `mode: byo` means "the overlay is
  saved but the resolver should skip me and inherit instead". Useful
  for debugging.
- **Credentials block** (only when `mode != inherit`):
    - `credentialsSecretRef` — opaque pointer (string ≤ 128 chars) into
      the operator's secret store. Examples: `vault:secret/tenants/acme/temporal`,
      `k8s:tenant-acme-temporal-credentials`, `env:TENANT_ACME_TEMPORAL`,
      `infisical:<workspaceId>/prod/tenants/acme`,
      `doppler:ever-works/prod/TENANT_ACME_TEMPORAL`. The platform never
      stores plaintext credentials — only this pointer + the encrypted
      version stamped against the resolved snapshot when a run is enqueued.
      Which schemes work depends on which `SecretStoreResolver` your
      operator has wired (the default ships with `inline:` + `env:`).
    - `credentialsJson` (textarea) — collected by the UI today but **not
      yet POSTed** to the API. P2.2 will replace this with per-provider
      schema-driven fields (Temporal namespace + address, Inngest event
      key + signing key, BullMQ Redis URL, etc.) parsed from each
      provider's JSON Schema export.

## Action buttons

### Save

Persists the current form state via `PUT /api/account/job-runtime/config`.
Backend behaviour:

1. Static enum check on `providerId` (rejects anything outside the
   bundled `trigger | temporal | bullmq | pgboss | inngest` set).
2. Dynamic operator allow-list check (rejects providers the operator
   has restricted via `EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS`).
   Skipped when `mode: inherit` because inherit ignores `providerId`
   entirely.
3. Upserts the `tenant_job_runtime_config` row (PK `tenantId`).
4. If `credentialsSecretRef` changed, `credentialVersion` bumps by 1
   via `CredentialVersionService`.
5. Emits a `tenant_job_runtime_audit` row decorated with
   `operatorAllowedProviders` snapshot so the active allow-list at
   write time is preserved for the audit trail.

The button is disabled when the JSON textarea contains invalid JSON
(client-side check) or when `credentialsSecretRef` is empty in a
non-inherit mode.

### Rotate

Bumps `credentialVersion` without changing any other field. Use this
when you've rotated the underlying secret in your secret store and
want to force runs enqueued from this moment forward to resolve
against the new version. Calls `POST /api/account/job-runtime/rotate`.

In-flight runs that already captured the previous version continue
running against their pinned snapshot — this is the **graceful drain**
behaviour locked in [ADR-017 Q4](../specs/decisions/017-tenant-scoped-job-runtime-overlay.md#q4--credential-rotation-strategy).
A worker host that has been spun up against version N stays on N
until the run completes; the dispatcher resolves new enqueues against
N+1.

### Force-invalidate

The break-glass version of rotate. Bumps `credentialVersion`, emits a
`force_invalidate` audit row, and signals worker hosts to drop their
in-flight runs against the old version (`reason='credential_force_invalidated'`).

Rate-limited by the controller to ≤ 1 / min / tenant to prevent
operator footguns. The button surfaces the throttle response inline
("force-invalidate rate-limited — try again in 47 s").

Use force-invalidate only when:

- You suspect credentials are compromised (e.g. a contractor with
  access left, the secret leaked into a screenshot, etc.).
- You're testing the rotation path and want to verify worker hosts
  drop the old snapshot cleanly.

Use Rotate (not force-invalidate) for routine rotation — force-invalidate
deliberately drops in-flight work.

### Revert to inherit

Calls `DELETE /api/account/job-runtime/config`. Leaves the row in
place (so the audit trail stays intact) but sets `mode = inherit`,
clears `credentialsSecretRef`, and bumps `credentialVersion`. After
this completes, the resolver behaves identically to "no overlay row
at all" — the instance default takes over for every subsequent
enqueue.

This is the safe rollback when:

- A BYO credential blew up and you want to fall back fast.
- The operator just disabled the provider you were on (see the next
  section) and you need to disengage before re-picking.

## Why is provider X missing?

If the picker doesn't show a provider you expected (e.g. only
`trigger` and `temporal` appear when you expected all 5):

The operator has allow-listed only a subset via the
`EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS` env var. Talk to your
operator if you need a provider added. They flip the env var and
redeploy — there's no per-tenant override today (deferred to P5.1
behind a feature flag).

If you were previously on a provider that the operator has since
removed from the allow-list, the Settings page shows a warning banner:

> The provider currently saved for your tenant (`inngest`) is no longer
> enabled by the operator. New runs will continue against your saved
> snapshot, but you cannot save a new configuration for this provider.
> Revert to `inherit` or pick a different provider.

The overlay row stays in place; the API blocks new `PUT /config`
writes that target the disabled provider with
`400 BadRequestException: provider 'inngest' is disabled by the
operator. Allowed providers: trigger, temporal`.

## API quick reference

| Method   | Path                                           | Purpose                                                         |
| -------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `GET`    | `/api/account/job-runtime/config`              | Load current overlay row (redacted) or synthetic `mode:inherit` |
| `PUT`    | `/api/account/job-runtime/config`              | Upsert overlay row                                              |
| `POST`   | `/api/account/job-runtime/rotate`              | Bump `credentialVersion`                                        |
| `POST`   | `/api/account/job-runtime/force-invalidate`    | Bump + drop in-flight (rate-limited)                            |
| `DELETE` | `/api/account/job-runtime/config`              | Revert to inherit (bumps version)                               |
| `GET`    | `/api/account/job-runtime/available-providers` | Returns the operator allow-list                                 |

All routes require an authenticated request from a user attached to
exactly one tenant (the 1 User : 1 Tenant model). There is no
`:tenantId` path parameter — the tenant is resolved from the auth
session. Cross-tenant reads / writes return `403 ForbiddenException`.

## Trigger.dev modes

Trigger.dev is the platform default, and it has its own quirks worth
calling out because the provider's tenancy model is the inverse of
what the runbook above implies.

There are three modes you can pick when Trigger.dev is your runtime:

1. **`inherit`** (default) — your tenant uses the platform's shared
   Trigger.dev project. The platform handles billing + project
   ownership. Per-tenant isolation inside the shared project is
   provided by Trigger.dev's [concurrency-keys][trigger-concurrency]
   (each tenant gets its own per-task concurrency budget) and the
   `externalId: <tenantId>` tag (so dashboard / observability slices
   cleanly by tenant). You see nothing — credentials are not stored
   on your tenant row in this mode.

2. **`byo`** — you bring your own Trigger.dev account and project,
   and the platform routes all your runs through your project's
   credentials. The platform never sees your workload data plane on
   Trigger.dev (only the dispatch metadata + the webhook callback).
   Use this when you want full billing isolation, geo locality, or
   contractual data-residency control.

3. **`override`** — mechanically identical to `byo` (same credential
   bag, same routing). The difference is intent: `override` says
   "the platform default is Trigger.dev too, and I'm switching to
   my own infra anyway." Kept as a distinct mode so future operator
   policy can gate `override` separately from `byo` (e.g. require
   operator approval) without touching the BYO flow.

### Why `byo` / `override` instead of "one project per tenant"

The original design assumed the platform could provision one
Trigger.dev project per tenant. It can't — Trigger.dev hard-caps
[projects at 10 per organization][trigger-limits] across every
pricing tier, and Trigger.dev's own
[multi-tenant guidance][trigger-multitenant] explicitly tells
operators not to use one project per tenant. The vendor pattern
(and ours) is one Trigger.dev project per **account**, with
per-tenant routing via `concurrencyKey` + `externalId` inside that
project. `byo` / `override` then lets your tenant own its **own
account**, which gives the strong-isolation outcome the per-project
plan was originally chasing.

[trigger-limits]: https://trigger.dev/docs/limits#projects
[trigger-multitenant]: https://trigger.dev/docs/deploy-environment-variables#multi-tenant-applications
[trigger-concurrency]: https://trigger.dev/docs/queue-concurrency#concurrency-keys-and-per-tenant-queuing

### What the credential form asks for

When you pick `byo` or `override`, the credentials form collects:

| Field         | Required | Notes                                                                                                  |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `accessToken` | yes      | Trigger.dev personal/management access token (`tr_pat_*`); used by the SDK at dispatch.                |
| `secretKey`   | yes      | Server-side env secret (`tr_prod_*` for prod env, `tr_dev_*` for dev); pairs with `projectRef`.        |
| `projectRef`  | yes      | Trigger.dev project reference (`proj_*`) shown on the Trigger.dev dashboard's project settings page.   |
| `apiUrl`      | optional | Defaults to `https://api.trigger.dev` (Trigger.dev Cloud). Override **only** for self-hosted instances. |

All four values come from the Trigger.dev dashboard, not from a
platform-side API call. There is no programmatic project creation
exposed in our runtime — see the next section for the click flow.

### How do I provision a project in my own Trigger.dev account?

1. Sign in (or sign up) at [trigger.dev](https://trigger.dev/).
2. Create an organization if you don't already have one.
3. Inside the org, click **Create new project**. Pick a name; the
   dashboard generates the `projectRef` (a `proj_*` string).
4. Open the project's **API Keys** page in the Trigger.dev dashboard.
   Copy the server-side **secret key** (`tr_prod_*` for the prod
   environment, `tr_dev_*` for dev). Treat this like a password.
5. Open your user settings in the Trigger.dev dashboard and create
   (or reuse) a **personal access token** (`tr_pat_*`).
6. In Ever Works, navigate to **Dashboard → Settings → Job Runtime**,
   pick `trigger` as the provider, pick `byo` or `override` as the
   mode, paste the three values (plus `apiUrl` if you're on a
   self-hosted Trigger.dev), and **Save**.

The platform runs a conformance probe (enqueue → status → cancel of
a no-op task) against your credentials before persisting. If the
probe fails, the form surfaces the error and your tenant row is not
updated.

> Note for self-hosters: if your Trigger.dev instance is behind an
> auth proxy or a non-default port, set `apiUrl` to the full base
> URL including the scheme + port. The default
> `https://api.trigger.dev` is only correct for Trigger.dev Cloud.

## Audit log

Every overlay-row mutation writes a row to `tenant_job_runtime_audit`
with columns `(id, tenantId, actorUserId, action, before, after,
credentialVersion, occurredAt)`. `before` / `after` JSON blobs carry
the redacted row state (no plaintext credentials — only the pointer +
version) plus the `operatorAllowedProviders` snapshot active at write
time.

Reading the audit log surface from the UI is a future story; today
the rows are inspectable via direct DB query for operators and via
the upcoming admin runbook. Self-serve tenant access to the audit
log is part of the schema-driven admin UI follow-up (P2.2+).

## Glossary

- **Inherit** — the tenant overlay row delegates to the instance
  default. Identical to "no overlay row exists" from the resolver's
  point of view.
- **BYO** — Bring Your Own credentials. The tenant supplies a secret
  pointer; the operator hasn't pre-provisioned the credentials. Most
  common mode.
- **Override** — Tenant explicitly chooses a different provider than
  the operator's default. Semantically the same as BYO today; the
  distinction lets future policy gate certain providers as
  "operator-must-approve".
- **Credential version** — monotonic per-tenant counter on the overlay
  row. Stamped onto every run at enqueue time so worker hosts resolve
  the same snapshot the dispatcher saw.
- **Graceful drain** — rotation strategy where in-flight runs keep
  their pinned snapshot while new enqueues resolve against the new
  version. Implemented by `CredentialVersionService`. See
  [ADR-017 Q4](../specs/decisions/017-tenant-scoped-job-runtime-overlay.md#q4--credential-rotation-strategy).
- **Force-invalidate** — break-glass: bump version AND drop in-flight
  runs against the old snapshot. Rate-limited.
