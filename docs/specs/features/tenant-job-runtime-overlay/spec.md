# Feature Specification: Tenant-Scoped Job-Runtime Overlay

> Behaviour-first spec. Describes **what** the system does once each tenant can inherit, BYO, or override the platform's background-job runtime — not how it's wired. Implementation lives in [`plan.md`](./plan.md); rationale in [ADR-017](../../decisions/017-tenant-scoped-job-runtime-overlay.md); the instance-global baseline this overlays sits in [`../job-runtime-providers/spec.md`](../job-runtime-providers/spec.md) ([ADR-015](../../decisions/015-job-runtime-provider-pluggability.md)).

**Feature ID**: `tenant-job-runtime-overlay`
**Branch**: `feat/tenant-job-runtime-overlay`
**Status**: `Draft`
**Created**: 2026-06-17
**Last updated**: 2026-06-17
**Owner**: Ever Works Team
**Epic**: [EW-742](https://evertech.atlassian.net/browse/EW-742)

---

## 1. Overview

EW-683 made the background-job runtime a deployment-wide selectable provider (`EVER_WORKS_JOB_RUNTIME`). This feature adds a **tenant-scoped overlay** on top of that selector so a single Ever Works instance can serve many tenants whose jobs land in different runtimes, different credentials, or both — without operators having to spin up an instance per tenant. Every tenant resolves to one of three modes: **inherit** (use the instance default exactly as today), **BYO** (same provider as the instance default, but the tenant supplies their own credentials so runs land in their own SaaS dashboard or self-hosted cluster), or **override** (the tenant picks a different provider from the operator-curated allow-list and supplies its credentials).

The feature draws three role boundaries clearly: the **operator** (deployment owner) sets the instance default, the allow-list of pickable providers, and the platform-default policy (`shared` / `per-tenant` / `tiered` — see Q5); the **tenant admin** chooses inherit / BYO / override and manages their credentials; the **end user** notices nothing — work generation, cancellation, scheduling, and status behave identically regardless of which runtime or credentials a given run executes against. Isolation between tenants is **provider-owned and uniform per provider**: one Temporal namespace per tenant (Q1), one Postgres schema per tenant for pg-boss (Q2), uniform inherit/BYO trichotomy across all five providers including Inngest (Q3). Credentials rotate via graceful drain by default, with a separate `force-invalidate` admin action for compromised-key incidents (Q4).

## 2. User Scenarios

The "user" splits three ways: the **operator** configuring the instance, the **tenant admin** configuring their tenant, and the **end user** triggering work — who should notice nothing.

### 2.1 Primary scenarios

- **Given** a tenant has no job-runtime config row, **when** any of its jobs are enqueued, **then** the platform routes them through the instance-global `EVER_WORKS_JOB_RUNTIME` provider using the operator's platform-default credentials — i.e. today's exact behaviour, zero-config (the inherit mode).
- **Given** the instance default is `trigger` and a tenant admin pastes their own Trigger.dev project keys, **when** they save the BYO config, **then** subsequent runs for that tenant appear in **their** Trigger.dev dashboard while other tenants on the same instance keep landing in the platform-default project.
- **Given** the instance default is `trigger` and a tenant picks `temporal` with their own namespace + mTLS certs, **when** that tenant enqueues a job, **then** the run executes against their Temporal cluster while all inherit-mode tenants on the same instance continue using the Trigger.dev SaaS default.
- **Given** an operator narrows the allow-list to `{trigger, pgboss}`, **when** any tenant opens the runtime picker, **then** only `trigger` and `pgboss` are selectable — even if the plugin for `temporal` is installed on the instance.
- **Given** an operator changes the instance-global default from `trigger` to `pgboss`, **when** the API rolls out, **then** every inherit-mode tenant's new jobs flow to pg-boss automatically while override-mode tenants stay on their chosen provider with their own credentials.
- **Given** a tenant rotates its credentials, **when** the rotation is saved, **then** in-flight runs continue to completion using the cached credential **version** they captured at enqueue time and only newly enqueued runs see the new credentials (graceful drain — Q4).
- **Given** an operator triggers `force-invalidate` on a compromised credential, **when** the action commits, **then** in-flight runs holding the old version are marked `FAILED` with a `CREDENTIAL_REVOKED` reason and new enqueues are blocked for that tenant until the tenant admin re-saves valid credentials.
- **Given** the operator has chosen `per-tenant` as the platform-default policy (Q5), **when** a brand-new tenant finishes signup in inherit mode, **then** the platform auto-provisions a dedicated Trigger.dev project for that tenant via the Trigger.dev PAT REST API and stores the resulting project keys as the tenant's effective credentials.

### 2.2 Edge cases & failures

- **Given** a tenant saves BYO credentials that don't authenticate, **when** the first enqueue attempt runs, **then** it fails fast with a friendly "credentials invalid — see tenant admin settings" message rather than a 500 and the failure surfaces in the tenant admin UI alongside the offending config.
- **Given** a tenant's BYO provider becomes unreachable mid-run, **when** the run's heartbeats time out, **then** the run transitions to `FAILED` with provider-error context (HTTP code / SDK error class) and the tenant admin can replay it once their provider recovers — the platform never silently swallows or retries indefinitely.
- **Given** a tenant is on `temporal` and the operator removes `temporal` from the allow-list, **when** the next enqueue arrives, **then** the tenant's config row is retained (not deleted) and surfaces a "provider disabled by operator" warning in the tenant admin UI, while new enqueues fall back to the instance default until the tenant picks an allowed provider.
- **Given** two inherit-mode tenants share one platform Trigger.dev project under the `shared` platform-default policy, **when** their runs interleave, **then** per-tenant tags (`tenantId`, `tenantSlug`) attached to every run's metadata let the operator filter the Trigger.dev dashboard by tenant.
- **Given** a tenant is offboarded, **when** the offboarding completes, **then** the per-tenant pg-boss schema (`pgboss_tenant_<id>`) is dropped, the per-tenant Temporal namespace is deleted, and (under `per-tenant` mode only) the auto-provisioned Trigger.dev project is archived — leaving no orphan tenant artefacts in any provider.
- **Given** the operator has selected `per-tenant` mode and Trigger.dev PAT REST cannot fetch the prod secret key for the freshly-provisioned project (a documented REST limitation), **when** signup runs, **then** the platform either (a) flags the tenant as `pending_prod_key` and requires the tenant admin to paste the prod key once after auto-provision, or (b) performs a worker-self-registration workaround — the chosen tradeoff is recorded in this spec's open questions and `plan.md`.

## 3. Functional Requirements

- **FR-1** The system MUST resolve a tenant's effective job-runtime config in this order: tenant overlay row → instance-global `EVER_WORKS_JOB_RUNTIME` fallback. Absent a tenant overlay row, behaviour MUST be byte-identical to the EW-683 instance-global path.
- **FR-2** The system MUST expose three explicit modes per tenant: `inherit`, `byo`, `override`. `inherit` means "use the instance default provider AND the platform-default credentials"; `byo` means "use the instance default provider with tenant-supplied credentials"; `override` means "use a tenant-chosen provider from the allow-list with tenant-supplied credentials."
- **FR-3** The system MUST restrict the tenant runtime picker to the operator-controlled allow-list — providers installed but not allow-listed MUST NOT appear in tenant admin UI and MUST be rejected if requested via API.
- **FR-4** Tenant credentials MUST be declared via the standard plugin settings schema with `x-secret` + `x-scope: tenant`, stored encrypted at rest, and never returned in API responses (only their presence + last-rotated timestamp is readable).
- **FR-5** Every credential write MUST bump a monotonic `credential_version` on the tenant's config row; every enqueue MUST capture the current version into the run record and the worker MUST use the credentials matching that version for the lifetime of the run (graceful drain — Q4).
- **FR-6** The system MUST expose a separate operator-only `force-invalidate` admin action that marks a `credential_version` as `REVOKED`, fails in-flight runs holding that version with reason `CREDENTIAL_REVOKED`, and blocks new enqueues for that tenant until valid credentials are re-saved.
- **FR-7** The system MUST support three operator-gated platform-default policies for inherit-mode tenants (Q5): `shared` (all inherit-mode tenants share one platform-owned credential set; default), `per-tenant` (each new tenant gets an auto-provisioned per-tenant credential set), and `tiered` (the policy looks up the tenant's subscription tier to choose shared vs per-tenant). The operator selects exactly one policy at the instance level.
- **FR-8** When the platform-default policy is `per-tenant`, the system MUST auto-provision the per-tenant credentials at tenant signup using the provider's native provisioning API (e.g. Trigger.dev PAT REST), MUST persist the resulting credentials as the tenant's effective credentials, and MUST archive/delete those resources on tenant offboarding.
- **FR-9** Temporal isolation MUST be **one namespace per tenant** (Q1), created/managed by the Temporal provider plugin via the Temporal admin SDK; the platform MUST NOT share a namespace across tenants.
- **FR-10** pg-boss isolation MUST be **one Postgres schema per tenant** named `pgboss_tenant_<id>` (Q2), created/migrated/dropped by the pg-boss provider plugin; the platform MUST NOT share a schema across tenants.
- **FR-11** The inherit/BYO/override trichotomy MUST be uniform across all five providers (Q3) — including Inngest. The system MUST NOT introduce an Inngest-only "instance-only" mode.
- **FR-12** Every run MUST carry per-tenant tags (`tenantId`, `tenantSlug`) in its native run metadata so the operator can filter the provider's native dashboard by tenant (especially relevant under the `shared` policy).
- **FR-13** Every tenant config change (mode switch, allow-list refusal, credential rotation, force-invalidate) MUST be written to the per-tenant audit log with actor (operator vs tenant admin), before/after state (credential values masked), and timestamp.
- **FR-14** Telemetry (Sentry events, PostHog metrics, structured logs) MUST tag every run/error with `tenantId` so per-tenant blast-radius and per-tenant error rates are queryable.
- **FR-15** The system MUST allow per-tenant retention overrides where the provider supports it (Trigger.dev run retention, Temporal namespace retention) and MUST silently no-op (with a documented warning in tenant admin UI) where it does not (BullMQ, pg-boss, Inngest).
- **FR-16** Credential reads at enqueue time MUST be cached with a short TTL (15–30 s) to keep enqueue latency within the NFR budget; cache invalidation MUST happen on the same API replica that wrote the rotation and propagate to peers within the eventual-consistency window (see NFR).
- **FR-17** Tenant offboarding MUST be a single idempotent operation that drops/archives all per-tenant runtime artefacts (Postgres schema, Temporal namespace, auto-provisioned Trigger.dev project under `per-tenant` mode) and MUST be safe to re-run on a partially-offboarded tenant.
- **FR-18** The system MUST NOT regress any EW-683 acceptance criterion — every existing instance-global behaviour (e.g. `EVER_WORKS_JOB_RUNTIME=pgboss` on a single-tenant instance) MUST continue to pass unchanged.
- **FR-19** Provider plugins MUST own their tenant lifecycle hooks (`onTenantCreated`, `onTenantOffboarded`, `onCredentialRotated`, `onCredentialForceInvalidated`) via the `job-runtime` capability — the platform MUST NOT hard-code per-provider tenant logic.
- **FR-20** The system MUST surface a tenant-scoped "runtime health" status (last successful enqueue, last failure, in-flight run count, credential version, credential age) in the tenant admin UI so tenant admins can self-diagnose without operator intervention.

## 4. Non-Functional Requirements

- **Performance**: enqueue overhead from the tenant-overlay layer (config resolution + credential lookup) MUST be < 5 ms p95 vs. the EW-683 instance-global baseline. Credential reads MUST be cached for 15–30 s to amortise DB hits.
- **Reliability**: credential rotation MUST be eventually consistent across all API replicas within N seconds (target: 30 s; configurable). Graceful-drain runs MUST complete using the captured credential version even if rotation or force-invalidate fires mid-run, with the single exception of `force-invalidate` which intentionally aborts in-flight runs (FR-6).
- **Isolation**: per-tenant blast-radius MUST be bounded by the chosen isolation mechanism — a Temporal-tenant outage MUST NOT affect a pg-boss-tenant; a tenant exhausting their own Trigger.dev quota MUST NOT affect inherit-mode tenants; a poison job in `pgboss_tenant_A` MUST NOT block `pgboss_tenant_B`.
- **Security & privacy**: all tenant credentials are `x-secret` and `x-scope: tenant`, encrypted at rest, never returned in API responses, never logged in plaintext, and never crossed between tenants. `force-invalidate` MUST be operator-only (no tenant-admin route). Audit logs MUST be tamper-evident (append-only).
- **Observability**: every run, error, log line, Sentry event, and PostHog metric MUST carry `tenantId`. Operator dashboards MUST be able to filter "all runs for tenant X" across all providers without per-provider custom code.
- **Compatibility**: zero-config tenants (no overlay row, no platform-default policy change) MUST behave byte-identically to EW-683. Adding the overlay table MUST be a forward-only migration. Existing single-tenant operators MUST be unaffected.

## 5. Key Entities & Domain Concepts

| Entity / concept                | Description                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_job_runtime_config`     | The per-tenant overlay row: `(tenantId, mode, providerId, credentialBlob, credentialVersion, status, createdAt, updatedAt)`.                               |
| Mode                            | Enum `inherit | byo | override` — the three resolution paths a tenant can take against the instance default.                                              |
| Plugin allow-list               | Operator-controlled list of provider IDs that are pickable by tenant admins; subset of the providers actually installed on the instance.                   |
| Platform-default policy         | Operator-chosen policy for inherit-mode tenants: `shared` (one platform cred set, default) / `per-tenant` (auto-provision per tenant) / `tiered` (by sub). |
| `credential_version`            | Monotonic per-tenant integer bumped on every credential write; captured at enqueue and used for the run's lifetime (graceful drain — Q4).                  |
| Credential status               | Enum `active | draining | revoked` — `revoked` is set by the operator-only `force-invalidate` action and blocks new enqueues until re-saved.               |
| Per-tenant isolation primitive  | The provider-owned unit of isolation: Temporal namespace per tenant (Q1), Postgres schema per tenant for pg-boss (Q2), separate project for Trigger.dev.   |
| Tenant lifecycle hook           | Provider-plugin callback (`onTenantCreated`, `onTenantOffboarded`, `onCredentialRotated`, `onCredentialForceInvalidated`) the platform invokes uniformly.  |
| Run tenant tags                 | `tenantId` + `tenantSlug` attached to every run's native metadata so provider dashboards stay tenant-filterable under the `shared` policy.                 |

## 6. Out of Scope

- **Per-Work routing** to different runtimes (still deferred per [`../job-runtime-providers/spec.md`](../job-runtime-providers/spec.md#6-out-of-scope) §6) — overlay resolution is per-tenant, not per-work.
- **Live migration of in-flight runs** across providers when a tenant switches mode/provider — switch is "new runs use the new config; old runs drain on the old config."
- **Self-serve Trigger.dev project provisioning from a tenant UI button** — `per-tenant` mode (Q5) is an operator-set policy that auto-provisions at signup; tenant admins do not initiate provisioning themselves.
- **Cross-region routing of tenant credentials** — if a tenant's BYO Temporal Cloud lives in a different region from the API, latency is the operator's problem in v1 (see open question on cross-region worker fleets).
- **Per-tenant choice of cache/lock backend** — that's [ADR-005](../../decisions/005-cache-and-lock-pluggability.md)'s concern; this feature is scoped to the job-runtime overlay only.
- **A user-facing UI for end users** to see which runtime ran their job — runtime is operator/tenant-admin concern, not end-user surface.

## 7. Acceptance Criteria

- [ ] With no `tenant_job_runtime_config` rows and no platform-default policy change, every EW-683 acceptance criterion MUST continue to pass unchanged ([`../job-runtime-providers/spec.md`](../job-runtime-providers/spec.md#7-acceptance-criteria) §7 is the baseline).
- [ ] **inherit / trigger**: a tenant with no overlay row runs against the instance-default Trigger.dev exactly as today.
- [ ] **inherit / temporal**, **inherit / bullmq**, **inherit / pgboss**, **inherit / inngest**: a tenant with no overlay row runs against whichever instance-default the operator has set; all five providers behave identically from the tenant POV.
- [ ] **byo / trigger**: a tenant supplies their own Trigger.dev project keys; runs land in their dashboard; the inherit-mode tenant on the same instance is unaffected.
- [ ] **byo / temporal**, **byo / bullmq**, **byo / pgboss**, **byo / inngest**: same as above for the other four providers, with each provider's isolation primitive (namespace, schema, project) created on first enqueue.
- [ ] **override / trigger→temporal** (instance default `trigger`, tenant picks `temporal`): tenant's runs execute against their Temporal namespace; instance default unchanged.
- [ ] **override** for every (instance-default × tenant-chosen) pair where tenant-chosen ≠ instance-default and tenant-chosen is in the allow-list.
- [ ] **Allow-list enforcement**: tenant admin UI hides non-allow-listed providers; API rejects them with 403.
- [ ] **Platform-default `shared`**: two inherit-mode tenants share one platform Trigger.dev project; runs are tenant-tag-filterable in the Trigger.dev dashboard.
- [ ] **Platform-default `per-tenant`**: new tenant signup auto-provisions a Trigger.dev project; tenant offboarding archives it.
- [ ] **Platform-default `tiered`**: tenant in tier `free` lands on shared; tenant in tier `pro` lands on per-tenant.
- [ ] **Credential rotation**: in-flight run completes on captured version; next enqueue uses new version; cache invalidates within the configured window.
- [ ] **`force-invalidate`**: in-flight runs holding the revoked version fail with `CREDENTIAL_REVOKED`; new enqueues blocked until tenant re-saves.
- [ ] **Tenant offboarding**: per-tenant Postgres schema dropped; Temporal namespace deleted; per-tenant Trigger.dev project archived (where applicable); operation is idempotent on partial state.
- [ ] **NFR-Perf**: enqueue overhead < 5 ms p95 vs EW-683 baseline.
- [ ] **NFR-Isolation**: poison job in tenant A's pg-boss schema does not block tenant B's pg-boss schema.
- [ ] All FRs have a passing test (unit, conformance, or e2e).

## 8. Open Questions

- `[NEEDS CLARIFICATION: Tenant credential encryption — KMS (AWS/GCP/Vault) vs Postgres-native pgcrypto? KMS gives operator key-rotation hooks and audit trails out of the box; pgcrypto keeps the deploy single-binary and self-host-friendly. Proposal: support both via an `x-encryption-backend` setting and default to pgcrypto for OSS parity.]`
- `[NEEDS CLARIFICATION: Cross-region — when a tenant BYOs Temporal Cloud in eu-west-1 and the API runs in us-east-1, do we accept the cross-region latency, require a per-region worker fleet, or reject the config? v1 proposal: accept the latency and document it; per-region worker fleets are a v2 question tied to the multi-region API roadmap.]`
- `[NEEDS CLARIFICATION: BullMQ and pg-boss tenant onboarding latency budget — creating a Postgres schema + running pg-boss migrations on first enqueue can add seconds. Do we eagerly provision the schema at tenant-create time or lazily on first enqueue? Eager = faster first job, more wasted resources for tenants who never enqueue; lazy = the inverse.]`
- `[NEEDS CLARIFICATION: \`force-invalidate\` UI ergonomics — single-click in the operator admin (fastest for true incident response) vs require type-to-confirm + reason text (safer against fat-finger / misuse). Proposal: type-to-confirm with reason, captured into the audit log.]`
- `[NEEDS CLARIFICATION: Under \`per-tenant\` mode for Trigger.dev, when PAT REST cannot retrieve the freshly-provisioned project's prod secret key (documented Trigger.dev REST limitation), do we (a) require the tenant admin to paste the prod key after auto-provision, or (b) run a worker-self-registration step that exchanges PAT for a usable runtime key? (a) is simpler; (b) is fully zero-touch but adds a moving part.]`

## 9. Constitution Gates

- [x] **Plugin-first (Principle I)** — tenant lifecycle hooks are owned by each `job-runtime-*` provider plugin; the platform owns only the overlay table + resolver.
- [x] **Capability-driven resolution (Principle II)** — overlay extends the existing `job-runtime` capability resolver from EW-683; no new capability category.
- [x] **Source-of-truth repos preserved (Principle III)** — no change to code/content-in-Git semantics.
- [x] **Long-running work via Trigger.dev (Principle IV)** — covered by [EW-685](https://evertech.atlassian.net/browse/EW-685)'s pending amendment ("via the configured job-runtime provider") from [`../job-runtime-providers/spec.md`](../job-runtime-providers/spec.md#9-constitution-gates) §9; **no additional amendment required** by this feature.
- [x] **Forward-only migrations (Principle V)** — overlay table is additive; per-tenant Postgres schemas are created (never altering platform schema destructively).
- [x] **Tests accompany the change (Principle VI)** — per-mode × per-provider matrix in the conformance suite + e2e for rotation / force-invalidate / offboarding.
- [x] **Secrets per `x-secret` (Principle VII)** — all tenant creds `x-secret` + `x-scope: tenant`; never returned by the API.
- [x] **Plugin counts touch canonical doc only (Principle VIII)** — no new plugins added by this feature; the existing five `job-runtime-*` plugins grow tenant-lifecycle hooks.
- [x] **Behaviour-first (Principle IX)** — this spec describes behaviour; implementation in `plan.md`.
- [x] **Backwards-compatible (Principle X)** — zero-config tenants behave byte-identically to EW-683; overlay is purely additive.

## 10. References

- ADR: [ADR-017](../../decisions/017-tenant-scoped-job-runtime-overlay.md) (this feature), [ADR-015](../../decisions/015-job-runtime-provider-pluggability.md) (instance-global baseline)
- Architecture: [`../../architecture/job-runtime-providers.md`](../../architecture/job-runtime-providers.md), [`../../architecture/settings-system.md`](../../architecture/settings-system.md)
- Baseline feature: [`../job-runtime-providers/spec.md`](../job-runtime-providers/spec.md)
- Related ADRs: [ADR-005](../../decisions/005-cache-and-lock-pluggability.md) (composes — cache/lock pluggability is orthogonal to runtime overlay)
- Related features: [`../tenants-and-organizations`](../tenants-and-organizations/), [`../plugin-system`](../plugin-system/), [`../scheduled-updates/spec.md`](../scheduled-updates/spec.md), [`../generation-cancellation/spec.md`](../generation-cancellation/spec.md)
- Jira: [EW-742](https://evertech.atlassian.net/browse/EW-742) (epic), [EW-743](https://evertech.atlassian.net/browse/EW-743) (this story), [EW-683](https://evertech.atlassian.net/browse/EW-683) (instance-global runtime selector — prereq), [EW-685](https://evertech.atlassian.net/browse/EW-685) (Principle IV amendment — prereq), [EW-686](https://evertech.atlassian.net/browse/EW-686) (prereq)
