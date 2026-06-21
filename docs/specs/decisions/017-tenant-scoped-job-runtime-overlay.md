# ADR-017: Tenant-Scoped Job-Runtime Configuration Overlay — Per-tenant runtime selection + BYO credentials on top of the instance-global engine swap

## Status

**Proposed** — Tracking implementation in [EW-742](https://evertech.atlassian.net/browse/EW-742). This ADR is forward-looking; **nothing changes today**. Until the overlay exists, every tenant on a deployment uses the deployment's instance-global runtime selection from [ADR-015](./015-job-runtime-provider-pluggability.md) / [EW-683](https://evertech.atlassian.net/browse/EW-683) — that path is preserved as `inherit` mode and remains the default for every tenant after this ADR ships, so single-tenant self-hosters see zero behaviour change.

## Date

- 2026-06-17 — Initial.

## Context

[ADR-015](./015-job-runtime-provider-pluggability.md) makes the background-job runtime a pluggable provider chosen by the operator at deploy time, via the instance-global selector `EVER_WORKS_JOB_RUNTIME`. That ADR's [`spec.md` §6 "Out of Scope"](../features/job-runtime-providers/spec.md) and [FR-3](../features/job-runtime-providers/spec.md) both pin v1 to **one active runtime per deployment** — no per-tenant routing, no per-work routing. That was the correct call for the engine-swap problem; it is no longer sufficient for the **multi-tenant** deployment story.

Two converging forces force the question now:

1. **Ever Works Cloud is multi-tenant by definition.** The hosted platform must let one tenant run Trigger.dev SaaS on the operator's account, another tenant bring its own Trigger.dev project, a third use Temporal Cloud on its own namespace, all on the same API process. Instance-global selection cannot express that — every tenant gets whichever runtime the operator picked.

2. **The directory-web-template demo→k8s-works cutover (June 2026) hit the gap in practice.** Eight Works belonging to a single tenant on `k8s-works` all needed their Trigger.dev wiring provisioned by hand: per-Work secret rows, per-Work env propagation, manual project creation in the operator's Trigger.dev SaaS dashboard. That work is wrong at the per-Work layer — **Works don't own credentials, tenants do**. Tenants own the billing relationship, the plugin entitlements, and the operator-of-record for whichever third-party SaaS the runtime points at. A Work is a deployed instance of generated content; it has no business holding a Trigger.dev secret.

The plugin settings system already separates `global` / `user` / `work` scopes and resolves them through a cascade ([`settings-system.md` §2 "The Three Tiers"](../architecture/settings-system.md), §9 "Setting Resolution API"). The `x-scope` JSON-Schema extension currently exists only as a UI hint — the spec describes it as "Hint to the UI; the actual scope is inferred from where the user clicks" ([`settings-system.md` §3](../architecture/settings-system.md)). There is **no `tenant` value enumerated** for `x-scope` today, no `tenant_plugins` table parallel to `user_plugins` / `work_plugins`, and no tier between `global` and `user` in the resolution cascade. Phase 1 of this initiative's first sub-story therefore must either confirm `tenant` as a first-class value of `x-scope` (and add the storage tier behind it) or flag the gap explicitly — see Implementation outline P1.

**Why per-tenant and not per-Work.** Tenants are the unit of billing, plugin entitlement, and operator-of-record. They are the unit that signs up for a Trigger.dev account, that holds a Temporal Cloud namespace, that pays for an Inngest seat. Works are derived: a Work belongs to a tenant; its background jobs run against the tenant's runtime, with the tenant's credentials. Per-Work routing creates N×M credential proliferation (N tenants × M works each) for zero credential authority gain. Per-Work routing remains **explicitly out of scope** and is still deferred from [EW-683 §6](../features/job-runtime-providers/spec.md).

**Why not a separate selector environment variable per tenant.** Env vars are deploy-time, instance-wide, and singular — they cannot express per-tenant choice without a tenant-aware indirection layer in front, at which point we have rebuilt this overlay in a worse form (no UI, no audit, no rotation). The settings system already gives us encrypted-at-rest storage, redaction in API responses, env-var fallback for un-overridden keys, and the three-tier resolver. Adding a tenant tier is strictly less work than building a parallel mechanism.

## Decision

The job runtime gains a **tenant-scoped configuration overlay** on top of [ADR-015](./015-job-runtime-provider-pluggability.md)'s instance-global selection. The overlay is expressed as a new resolution tier in the settings system and a new `tenant_job_runtime_config` row per opted-in tenant; the existing `EVER_WORKS_JOB_RUNTIME` env continues to be the deployment-wide fallback when a tenant has no overlay row.

### 1. Three-mode tenant trichotomy: INHERIT / BYO / OVERRIDE

Each tenant resolves to exactly one of three modes. The mode is stored on `tenant_job_runtime_config.mode`; absence of a row is equivalent to `inherit`.

- **`inherit`** (default for every tenant on overlay rollout) — the tenant uses the deployment's instance-global runtime selection from `EVER_WORKS_JOB_RUNTIME` and the deployment's instance-global provider credentials. Behaviour is byte-for-byte identical to pre-overlay; single-tenant self-hosters never leave this mode.
- **`byo`** — the tenant uses the **same provider** as the instance-global selection but supplies its **own credentials** (own Trigger.dev project token, own Temporal Cloud namespace + mTLS bundle, own Inngest event/signing keys, etc.). The dispatcher routes to the tenant's provider instance; the worker host subscribes to the tenant's queue/namespace/project as well.
- **`override`** — the tenant chooses a **different provider entirely** from the instance default, AND supplies its credentials. The chosen provider must be one of the instance's enabled `job-runtime` plugins (see point 4); the operator's plugin enable/disable list is the kill-switch.

`byo` and `override` differ only in whether the tenant's provider id matches the instance default; the credential storage, dispatcher routing, and worker subscription mechanics are the same.

### 2. Per-provider isolation choices (locked Q1–Q3; do not reopen)

These are the multi-tenant isolation models per provider, decided in the spec-kit Q&A pass and recorded here as authoritative:

- **Temporal — one namespace per tenant.** The Temporal plugin's tenant-scope settings schema supplies `temporalHost`, `namespace`, and either mTLS cert/key OR API key per tenant. Strong isolation (Temporal namespaces are the native multi-tenancy boundary), maps cleanly to Temporal Cloud's billing-per-namespace model, and lets a tenant move to its own Temporal Cloud account by changing the connection bundle. **Cost**: workers must subscribe per-namespace, so worker fleet sizing scales with active-tenant count under non-inherit modes — quantified in Consequences below.
- **pg-boss — one Postgres schema per tenant (`pgboss_tenant_<id>`).** Owned by the pg-boss plugin: the plugin creates the schema via its own migration on tenant onboarding, runs pg-boss `.start({ schema })` per tenant, and `DROP SCHEMA … CASCADE` on offboarding. Clean teardown story (no orphaned queue rows), per-tenant queue depth visibility via `pg_catalog`, and a clear boundary that satisfies "your jobs do not sit in a table next to another tenant's jobs."
- **Inngest — uniform inherit/BYO trichotomy with Trigger.dev. No instance-only mode.** Inherit-mode tenants share the operator's Inngest Cloud account (same event key, same signing key, same app id) — operator pays. BYO/override tenants paste their own keys AND get a per-tenant webhook path (`/api/inngest/tenant/<tenantId>`) so the per-tenant signing key validates only that tenant's traffic. We deliberately rejected an "instance-only Inngest" middle mode: it would force every tenant onto operator credentials with no exit ramp, contradicting the "you own everything" principle.

### 3. Credential rotation — graceful drain (locked Q4; do not reopen)

Credentials are versioned. A `tenant_job_runtime_credential` row carries a monotonic `version`. The behaviour at rotation:

- An enqueued run **captures the credential version** at enqueue time (stored on the run record / history row).
- Status polls, cancels, and retries for that run use the **captured version** until the run reaches a terminal state — even if a newer credential version has been written in the meantime. This is the "graceful drain" guarantee: rotating a credential never strands an in-flight run.
- New enqueues use the **latest** version. Once all runs captured under version N are terminal, version N can be garbage-collected (background job, not in this ADR's scope).

There is a **separate admin action** for compromised-key incidents: `force-invalidate <credential-version>`. This immediately fails any in-flight run that captured the invalidated version (status → `FAILED` with reason `credential_invalidated`), forcing manual re-enqueue with current creds. It is **explicitly NOT coupled to routine rotation** — operators rotate keys all the time for hygiene; failing live runs on every routine rotation would make rotation operationally expensive and discourage it. Force-invalidate is the break-glass path; routine rotation is graceful.

### 4. Platform-default for inherit-mode tenants — hybrid, operator-policy gated (locked Q5; do not reopen)

When a tenant is in `inherit` mode and the deployment's instance-global provider is `trigger`, the operator picks one of three policies (instance-global env `EVER_WORKS_JOB_RUNTIME_TRIGGER_INHERIT_POLICY`):

- **`shared`** (default) — all inherit-mode tenants route to **one platform Trigger.dev project** (the operator's). Simplest, cheapest, no signup-time provisioning latency. Acceptable for free tiers and for operators who don't want per-tenant Trigger.dev billing exposure.
- **`per-tenant`** — on tenant signup, the platform auto-provisions a Trigger.dev project via the Trigger.dev management API (`POST /api/v1/orgs/{orgId}/projects` using the operator's PAT) and stores the resulting project ref + key on the tenant. Strongest isolation under inherit mode, at the cost of **signup latency** (one round-trip to Trigger.dev's management API per new tenant) — see Consequences.
- **`tiered`** — free-plan tenants share (as `shared`); paid-plan tenants get auto-provisioned projects (as `per-tenant`). Plan→policy mapping is read from the billing tier metadata. Same provisioning-latency caveat applies on paid-tenant signup.

The same trichotomy generalises naturally to `inngest` (shared event key vs per-tenant app) but is in scope here only for `trigger`, since that is the only provider where we already programmatically create top-level account objects today.

**Q-followup (2026-06-21):** the `per-tenant` and `tiered` inherit-policy variants above were both premised on the platform auto-provisioning **one Trigger.dev project per tenant** via `POST /api/v1/orgs/{orgId}/projects`. That premise is **rejected** after EW-742 implementation review surfaced two countervailing facts:

1. Trigger.dev hard-caps [10 projects per organization across every pricing tier](https://trigger.dev/docs/limits#projects). There is no tier we can buy our way out of.
2. Trigger.dev's own [multi-tenant applications guide](https://trigger.dev/docs/deploy-environment-variables#multi-tenant-applications) explicitly calls per-tenant projects an anti-pattern and points operators at runtime-scoping inside a shared project instead.

The replacement design — already on `main` via the EW-742 P3.2 + T22 stack — uses a **single Trigger.dev project per account** with per-tenant routing via [`concurrencyKey: tenantId`](https://trigger.dev/docs/queue-concurrency#concurrency-keys-and-per-tenant-queuing) + `externalId: tenantId` + `metadata.tenantId` on every `tasks.trigger(...)` call, plus per-tenant credential resolution through the existing `TenantAwareRuntimeResolver` → `SecretStoreResolver` → `provider.bindToTenant(snapshot)` plumbing. Full design rationale + credential bag shape live in [`../features/tenant-job-runtime-overlay/providers.md` § Trigger.dev](../features/tenant-job-runtime-overlay/providers.md#triggerdev); task-level reframe in [`../features/tenant-job-runtime-overlay/tasks.md` § T25](../features/tenant-job-runtime-overlay/tasks.md). The three modes (`inherit` / `byo` / `override`) are unchanged at the data-model layer — only the inherit-mode implementation collapses from `shared` / `per-tenant` / `tiered` (Trigger.dev-specific) into a single "shared project + concurrency-key routing" path. Per-tenant queue isolation, per-tenant concurrency budget, and per-tenant observability slicing are all preserved by the new pattern; what's lost is the (never-shipped) "per-tenant billing account, transparently provisioned by the platform" promise, which the cap made impossible anyway.

### 5. Storage — `tenant_job_runtime_config` row in DB; env stays the fallback

The overlay lives in a new DB table:

```
tenant_job_runtime_config
  tenantId             uuid (pk)
  mode                 enum('inherit','byo','override')
  providerId           varchar  null  -- set when mode != 'inherit'
  inheritPolicyVariant enum('shared','per-tenant','tiered') null
  createdAt / updatedAt
```

Per-tenant credentials live in the existing settings-system encrypted column pattern (`secrets` jsonb, AES-256-GCM under `PLUGIN_SECRETS_ENCRYPTION_KEY`; see [`settings-system.md` §5 "Storage Layer"](../architecture/settings-system.md) and §7 "Secret Hygiene Boundary"). The provider plugin declares its tenant-scoped fields with `x-secret: true` and `x-scope: tenant`; the resolver routes those values into a new `tenant_plugins` storage row keyed by `(tenantId, pluginId)`. **The instance-global env `EVER_WORKS_JOB_RUNTIME` remains the fallback** for any tenant whose `tenant_job_runtime_config` row resolves to `inherit` or is absent.

The resolution cascade in [`settings-system.md` §2](../architecture/settings-system.md) gains a `tenant` tier between `user` and `admin (global)`:

```
work → user → tenant → admin (global) → env var → schema default
```

### 6. Plugin gating — tenant override picker only shows instance-enabled providers

A tenant in `override` mode can only choose from `job-runtime` plugins the operator has enabled at the instance level. The operator retains the kill-switch: disabling a plugin removes it from the tenant's override picker on the next render and causes any tenant currently in `override` mode against that plugin to fall back to `inherit` on next dispatch (with an operator-visible alert). This is the standard plugin-enablement guard, not a new mechanism.

### What does NOT change

- **Instance-global selection still works exactly as today.** A deployment with no tenant overlay rows behaves identically to ADR-015 v1; `EVER_WORKS_JOB_RUNTIME` is read at boot, bound to all dispatcher symbols, and serves every tenant via `inherit`.
- **Single-tenant self-host deployments are unaffected** — they have one tenant, `inherit` mode, no overlay rows. No UI surface, no migration impact beyond an additive table.
- **The [ADR-015](./015-job-runtime-provider-pluggability.md) dispatcher seam is unchanged.** This overlay plugs INTO the seam via a credential-resolver hook: the dispatcher factory now consults `tenant_job_runtime_config.resolve(tenantId)` before binding the provider's credential context to the call. Provider implementations themselves do not change shape — they receive a credential bundle as today, just resolved per-tenant.
- **Per-Work routing stays out of scope** — still deferred from [EW-683 §6](../features/job-runtime-providers/spec.md). Works inherit their tenant's runtime, period.
- **The agent business logic, the SuperJSON internal callback channel, and the pre-created `historyId` contract** are all unchanged from [ADR-015 "What does NOT change"](./015-job-runtime-provider-pluggability.md) — runtime credentials are the only new dimension.

### Out of scope for this ADR

- **Per-Work routing.** Still deferred, as above. A later ADR can address it if and when a real need appears (none today).
- **Live migration of in-flight runs across providers.** Switching a tenant from one provider to another is a tenant-admin action; the old provider drains existing runs to terminal state, new enqueues route to the new provider from the cutover moment. No mid-run handoff. Same posture as [ADR-015 §"Out of scope"](./015-job-runtime-provider-pluggability.md).
- **Self-serve Trigger.dev project provisioning from a tenant-facing UI.** Tenants in `byo`/`override` paste credentials they obtained themselves; the platform does not programmatically create Trigger.dev projects on the tenant's behalf. (The `per-tenant` inherit-policy auto-provisioning in §4 uses the **operator's** account, not the tenant's — different concern.) Self-serve provisioning could be a later UX layer; it is not load-bearing for this ADR.
- **Cross-tenant queue sharing optimisations.** Each tenant's BYO/override runtime is isolated by design; we do not attempt to multiplex tenants onto shared workers behind the scenes.
- **Choosing the runtime per-conversation, per-agent, per-skill.** Routing dimensions other than tenant are not addressed.

### Constitution note

No further amendment needed beyond [EW-685](https://evertech.atlassian.net/browse/EW-685)'s already-pending change to [Constitution Principle IV](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md). EW-685 generalises Principle IV from "Long-running work via Trigger.dev" to "Long-running work via the configured job-runtime provider." The new dimension this ADR introduces is **which tenant's** config resolves the runtime; the amended principle text already accommodates per-tenant resolution because it speaks to "the configured provider" without prescribing whose config configures it. The gate check in [`spec.md` §9](../features/job-runtime-providers/spec.md) inherits the same posture.

## Consequences

**Positive**

- **Multi-tenant SaaS becomes a first-class deployment model**, not a workaround. Ever Works Cloud can host tenants with conflicting runtime choices side-by-side without per-tenant deployments or per-Work credential hacks.
- **Tenants own their runtime spend and isolation.** A tenant moving to Temporal Cloud or a dedicated Trigger.dev project changes one settings page, not an operator ticket — strengthens the "you own everything, nothing locked in" promise at the tenant tier, not just the instance tier.
- **Operator kill-switch is preserved.** The instance-enabled plugin list bounds what tenants may choose; the operator never loses the ability to retire a provider deployment-wide.
- **Credential rotation no longer interrupts in-flight work.** Routine key hygiene becomes cheap, which makes it more likely to actually happen — a security win that compounds over time.
- **The directory-web-template cutover pattern stops being manual.** Per-tenant Trigger.dev wiring becomes a self-serve settings flow rather than per-Work secret provisioning.

**Negative**

- **Signup latency under `per-tenant` inherit policy (Q5).** Auto-provisioning a Trigger.dev project on tenant signup adds a synchronous round-trip to the Trigger.dev management API (~300–1500 ms typical). Mitigations: provision asynchronously after signup with a "background runtime ready" indicator; back off to `shared` if provisioning fails; clearly document the trade vs `shared` default.
- **Temporal Cloud namespace quota becomes a planning concern (Q1).** Each non-inherit Temporal tenant consumes a Temporal Cloud namespace, and namespace count is a billed dimension. Operators running large fleets on Temporal Cloud must plan capacity; the docs must surface this explicitly. Self-hosted Temporal has no equivalent hard limit but still pays in cluster ops.
- **Postgres catalog bloat under `pg-boss` (Q2).** One schema per tenant means `pg_catalog` grows linearly with tenant count — schemas, sequences, indexes, triggers per tenant. Manageable up to low thousands of tenants on a well-tuned Postgres; beyond that, planner overhead and `pg_dump` time become real concerns. Mitigations: documented upper bound, optional "shared schema with `tenant_id` column" provider variant as a future opt-in for very large fleets.
- **Worker fleet sizing under non-inherit modes.** Pull-model providers (Temporal, BullMQ, pg-boss) require a worker subscription per tenant queue/namespace. Worker count scales with active-tenant count, not just job volume. Sidecar/replica strategies are documented per provider in [`providers.md`](../features/job-runtime-providers/providers.md).
- **Force-invalidate is a footgun if misused.** Operators must understand it fails live runs; the admin UI must surface that consequence prominently and require a typed confirmation.

**Neutral**

- **Additive DB schema only.** New `tenant_job_runtime_config` table + new storage tier for the settings system. No existing column or row changes shape. Forward-only migration, no rollback risk for existing data (Principle V).
- **Per-tenant credentials reuse the existing `x-secret` boundary** ([`settings-system.md` §7](../architecture/settings-system.md)). Storage encryption, redaction, export masking, and MCP-response stripping all already apply — adding a tenant scope does not introduce a new secret-hygiene surface, only a new key dimension into the existing one.
- **Inngest's licensing posture (SSPL, [`providers.md`](../features/job-runtime-providers/providers.md#inngest)) is unchanged** — still SaaS-only, still inherit/BYO only. The trichotomy uniformity with Trigger.dev is a clarity win, not a licensing change.
- **Plugin SDK is forward-compatible.** Provider plugins that don't opt into tenant-scoped settings (e.g. a future provider authored before the tenant tier existed) keep working under `inherit` mode for every tenant — they simply do not expose a tenant-override path. Per Principle X.

## Implementation outline

Tracked in [EW-742](https://evertech.atlassian.net/browse/EW-742). Phasing mirrors [EW-683](https://evertech.atlassian.net/browse/EW-683)'s outline:

1. **P0 — Spec-Kit writeup** ([EW-743](https://evertech.atlassian.net/browse/EW-743), this PR). ADR-017 + the parallel `spec.md` / `plan.md` / `tasks.md` updates under [`features/job-runtime-providers/`](../features/job-runtime-providers/spec.md), cross-linking to ADR-015. Flag the `x-scope: tenant` gap in [`settings-system.md` §3](../architecture/settings-system.md) and either confirm or queue Phase 1's first sub-story to add the value.
2. **P1 — Data model + migration.** New `tenant_job_runtime_config` table; new `tenant_plugins` storage tier parallel to `user_plugins` / `work_plugins`; extend `PluginSettingsService.resolve` with the tenant tier; add `tenant` to `x-scope`'s accepted values + schema validator. Forward-only migration per Principle V.
3. **P2 — Admin UI.** Tenant-admin settings page: mode picker (inherit/BYO/override), provider picker bounded by instance-enabled plugins, per-provider credential form rendered from the plugin's `settingsSchema` filtered to `x-scope: tenant` fields. Audit-log entries on every change per Principle VII.
4. **P3 — Dispatcher routing.** Generalise the [ADR-015](./015-job-runtime-provider-pluggability.md) factory binding so each `*_DISPATCHER` symbol resolves to a tenant-aware delegate: at call time it reads the current `tenantId` from the call context, looks up `tenant_job_runtime_config`, and routes to the appropriate provider instance + credential version. Credential version captured onto the run/history row.
5. **P4 — Worker host.** Worker entrypoints subscribe per-tenant for pull-model providers (Temporal namespaces, BullMQ queues, pg-boss schemas); push-model providers (Trigger.dev, Inngest) wire per-tenant webhook paths or per-tenant project tokens at boot, reloading on tenant-config changes. Per-provider sidecar/replica strategy documented in [`providers.md`](../features/job-runtime-providers/providers.md).
6. **P5 — Plugin gating + inherit-policy enforcement.** Tenant override picker bounded by enabled plugins; instance env `EVER_WORKS_JOB_RUNTIME_TRIGGER_INHERIT_POLICY` enforced on inherit-mode tenants; auto-provisioning hook for `per-tenant` policy calls Trigger.dev management API via the operator's PAT.
7. **P6 — Multi-tenant conformance.** Extend [ADR-015](./015-job-runtime-provider-pluggability.md)'s shared conformance suite with a tenant-isolation axis: two tenants with different credentials on the same provider MUST NOT see each other's runs, status, or cancellations. Force-invalidate path covered. Graceful-drain rotation covered.
8. **P7 — Docs.** Per-provider tenant-onboarding guides; operator policy guide for the inherit-policy choice; security/rotation runbook; capacity-planning notes (Temporal namespace quotas, Postgres schema bloat thresholds).

## References

- [EW-742 — Tenant-scoped job-runtime configuration overlay (epic)](https://evertech.atlassian.net/browse/EW-742)
- [EW-743 — [EW-742 P0] Spec-Kit writeup](https://evertech.atlassian.net/browse/EW-743)
- [EW-683 — Job-runtime provider pluggability (parent epic)](https://evertech.atlassian.net/browse/EW-683)
- [EW-685 — Job-runtime provider pluggability P0 (constitution amendment + contract)](https://evertech.atlassian.net/browse/EW-685)
- [EW-686 — Job-runtime provider pluggability P1 (trigger plugin re-housing)](https://evertech.atlassian.net/browse/EW-686)
- [ADR-015 — Job-Runtime Provider Pluggability](./015-job-runtime-provider-pluggability.md) — the instance-global engine swap this ADR overlays.
- [ADR-005 — Cache and Lock Pluggability](./005-cache-and-lock-pluggability.md) — sibling pattern at the infra tier (env-selected backends); the tenant overlay is the same shape one level up.
- [`architecture/job-runtime-providers.md`](../architecture/job-runtime-providers.md) — the provider contract this overlay plugs INTO via the credential-resolver hook.
- [`architecture/settings-system.md`](../architecture/settings-system.md) — the resolution cascade and `x-secret` boundary the tenant tier extends.
- [`features/job-runtime-providers/spec.md`](../features/job-runtime-providers/spec.md) · [`plan.md`](../features/job-runtime-providers/plan.md) · [`tasks.md`](../features/job-runtime-providers/tasks.md) · [`providers.md`](../features/job-runtime-providers/providers.md) — parent EW-683 spec set; this ADR's Phase 1+ updates extend them.
- [Constitution Principle IV](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md) — amended under EW-685; this ADR relies on the amended text.
- Platform repo PR #1092 — EW-683 spec-kit reference (structural template for this initiative's PR shape).
