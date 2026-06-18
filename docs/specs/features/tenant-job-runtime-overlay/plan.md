# Implementation Plan: Tenant Job-Runtime Overlay

> Translates [`spec.md`](./spec.md) into architecture and tech choices for tenant-scoped overlays atop the instance-global job-runtime selection of [EW-683](https://evertech.atlassian.net/browse/EW-683). Behaviour lives in the spec; this owns the "how." Per-provider research stays in the parent feature's [`providers.md`](../job-runtime-providers/providers.md). Rationale: [ADR-017](../../decisions/017-tenant-scoped-job-runtime-overlay.md). Deep architecture (the seam this extends): [`architecture/job-runtime-providers.md`](../../architecture/job-runtime-providers.md).

**Feature ID**: `tenant-job-runtime-overlay`
**Spec**: `./spec.md`
**Tasks**: `./tasks.md`
**Status**: `Draft`
**Last updated**: 2026-06-18
**Epic**: [EW-742](https://evertech.atlassian.net/browse/EW-742) · **Spec-kit story**: [EW-743](https://evertech.atlassian.net/browse/EW-743) · **Parent (instance-global runtime)**: [EW-683](https://evertech.atlassian.net/browse/EW-683) · **Dispatcher seam**: [EW-685](https://evertech.atlassian.net/browse/EW-685) · **Worker host**: [EW-686](https://evertech.atlassian.net/browse/EW-686)

---

## 1. Architecture Summary

```mermaid
flowchart LR
	A[API dispatch call sites] -->|*_DISPATCHER symbols| R[TenantAwareRuntimeResolver]
	R -->|tenant override| TC[(tenant_job_runtime_config)]
	R -->|no override| G[Instance-global runtime\nEW-685 binding factory]
	R --> P[Active IJobRuntimeProvider\n+ tenant credentials]
	P -. inherit .-> SH[Shared platform deployment]
	P -. byo / override .-> BYO[Tenant-supplied creds\n(secret ref + version)]
	P --> W[Worker host\n(tenant-routed)]
	W -->|/internal/jobs/webhook/:tenantId/*| A
	W --> H[(WorkGenerationHistory\n+ runtime_credential_version)]
```

The instance-global seam built in [EW-683](https://evertech.atlassian.net/browse/EW-683) / [EW-685](https://evertech.atlassian.net/browse/EW-685) stays load-bearing. This feature inserts a `TenantAwareRuntimeResolver` in front of the existing binding factory: on every dispatch the resolver consults `tenant_job_runtime_config` for the tenant in scope; if a row exists and is `enabled`, its provider+credentials win; otherwise the call falls through to the instance-global provider with `mode = inherit`. Credential identity (`credential_version`) is captured into `WorkGenerationHistory` at enqueue so an in-flight run keeps using the credentials it started with, even if the tenant rotates them mid-run (Q4 graceful drain).

## 2. Tech Choices

| Concern                 | Choice                                                                                                                                                                                                                | Rationale                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Persistence             | TypeORM entity `TenantJobRuntimeConfig` + forward-only migration in `apps/api/src/migrations/`                                                                                                                        | Matches platform `database.md` rules; self-applied at API boot via `migrationsRun: true`                                                 |
| Secret storage          | `secret_ref` pointer into the existing AES-256-GCM `secrets` jsonb envelope used by plugin settings                                                                                                                   | Reuses `PLUGIN_SECRETS_ENCRYPTION_KEY` rotation envelope from [`settings-system.md`](../../architecture/settings-system.md) §5           |
| Settings scope          | NEW `x-scope: tenant` value in plugin schema extensions                                                                                                                                                               | First sub-story of P1; `x-scope` today is `global`/`user`/`work` only ([`settings-system.md`](../../architecture/settings-system.md) §3) |
| Resolver placement      | NestJS request-scoped service `TenantAwareRuntimeResolver` in `packages/agent/src/tasks/`                                                                                                                             | Sits in front of EW-685's binding factory; constructor-injected per dispatcher symbol                                                    |
| Tenant credential cache | In-memory LRU keyed by `(tenant_id, credential_version)`, TTL ≤ 60s                                                                                                                                                   | Avoids per-dispatch decrypt; version pinning makes invalidation deterministic                                                            |
| Temporal multi-tenancy  | One **namespace per tenant** (Q1 locked); namespace name derived from `tenant_id`                                                                                                                                     | Native isolation; control-plane quota risk tracked in §end                                                                               |
| pg-boss multi-tenancy   | One **schema per tenant** (Q2 locked); schema name `pgboss_<tenant_id>`                                                                                                                                               | Reuses tenant's existing Postgres; isolated migrations per schema                                                                        |
| Inngest tenancy mode    | Uniform inherit / BYO with Trigger.dev (Q3 locked)                                                                                                                                                                    | Both push-model SaaS; treated identically                                                                                                |
| Push-model webhooks     | Per-tenant routes `/api/jobs/webhook/:tenantId/...` (Trigger.dev, Inngest)                                                                                                                                            | Lets SaaS provider's webhook hit the right tenant context; signature verified per tenant signing key                                     |
| Pull-model workers      | Multiplexing worker reads `tenant_id` from job metadata + injects per-tenant credentials at handler entry (BullMQ, pg-boss). Temporal uses per-namespace pollers (one Worker per active namespace; cold-start lazily) | Multiplex avoids N worker processes for queue-based runtimes; Temporal SDK binds a Worker to one namespace by design                     |
| Inherit default mode    | Operator-gated `shared` / `per-tenant` / `tiered` (Q5 locked, env: `EVER_WORKS_INHERIT_DEFAULT_MODE`)                                                                                                                 | Lets ops trade signup latency vs blast-radius without code changes                                                                       |
| Plugin gating           | Reuse existing instance operator allow-list from EW-683                                                                                                                                                               | Per-tenant whitelist/blacklist deferred to v2 behind a flag                                                                              |

## 3. Data Model

### New entities

`TenantJobRuntimeConfig` (`apps/api/src/works/entities/tenant-job-runtime-config.entity.ts`):

| Column                   | Type                                        | Notes                                                                                            |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `tenant_id`              | `uuid` PRIMARY KEY                          | One row per tenant; FK to `tenants.id` ON DELETE CASCADE                                         |
| `provider_id`            | `varchar(64)` NOT NULL                      | Matches `IJobRuntimeProvider.runtimeId` (`trigger`/`temporal`/`bullmq`/`pgboss`/`inngest`)       |
| `credentials_secret_ref` | `varchar(128)` NULL                         | Pointer into the encrypted secrets store; NULL when `mode = inherit`                             |
| `credential_version`     | `integer` NOT NULL DEFAULT 1                | Bumped on every credential rotation; captured into `WorkGenerationHistory`                       |
| `mode`                   | `enum('inherit','byo','override')` NOT NULL | `inherit` = use instance defaults; `byo` = tenant-owned creds; `override` = ops-imposed override |
| `enabled`                | `boolean` NOT NULL DEFAULT true             | Soft-disable without losing config; resolver treats false as inherit                             |
| `created_by`             | `uuid` NULL                                 | FK to `users.id`; NULL for system-created rows                                                   |
| `created_at`             | `timestamptz` NOT NULL DEFAULT `now()`      |                                                                                                  |
| `updated_at`             | `timestamptz` NOT NULL DEFAULT `now()`      | Bumped by `@UpdateDateColumn`                                                                    |

Indexes: PK on `tenant_id`; partial index `WHERE enabled = true` on `(provider_id)` for ops dashboards.

### Extensions to existing entities

`WorkGenerationHistory` (and the other `*_history` tables that mirror it) gains:

| Column                       | Type               | Notes                                                                 |
| ---------------------------- | ------------------ | --------------------------------------------------------------------- |
| `runtime_provider_id`        | `varchar(64)` NULL | Provider that owned the enqueue; NULL = legacy/in-process             |
| `runtime_credential_version` | `integer` NULL     | Snapshot of `tenant_job_runtime_config.credential_version` at enqueue |
| `tenant_id`                  | `uuid` NULL        | Denormalised for fast tenant-filtered history queries                 |

### Migrations

- Generated via `pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/TenantJobRuntimeOverlay` per platform CLAUDE.md.
- **Forward-only, two-phase** for the `*_history` column adds (per `database.md` §6.2 + workstation NN #16): add columns nullable → backfill `runtime_provider_id` from existing rows (set to `trigger` for any row with non-null `triggerRunId`) → switch reads → leave nullable forever.
- Tenant-side provider schemas (Temporal namespaces, pg-boss schemas) are provisioned on first use by P4 worker code, **not** by a TypeORM migration — they live in the runtime's own control plane.

### DTOs / contracts

New types in `packages/plugin/src/contracts/capabilities/job-runtime-tenant.interface.ts` (sibling to the EW-685 P0 `job-runtime.interface.ts`; lands with P3 alongside the tenant-aware resolver):

```ts
export type TenantRuntimeMode = 'inherit' | 'byo' | 'override';

export interface TenantRuntimeBinding {
	tenantId: string;
	providerId: JobRuntimeId;
	mode: TenantRuntimeMode;
	credentialVersion: number;
	resolvedAt: Date;
}

export interface ITenantRuntimeResolver {
	resolve(tenantId: string): Promise<TenantRuntimeBinding>;
	invalidate(tenantId: string): Promise<void>;
}
```

`@ever-works/contracts` is unchanged for external API consumers.

## 4. API Surface

Internal callback channel from EW-683 gains a tenant-routed variant. Aliases preserved for in-flight runs during rollout.

| Method | Endpoint                                     | Description                                                           | Status   |
| ------ | -------------------------------------------- | --------------------------------------------------------------------- | -------- |
| `POST` | `/internal/jobs/webhook/:tenantId/:provider` | Push-model webhook ingress (Trigger.dev, Inngest); signature-verified | New      |
| `POST` | `/internal/jobs/remote/call`                 | SuperJSON RPC (existing; gains `tenantId` header)                     | Extended |
| `GET`  | `/internal/jobs/works/:id/context`           | Worker work/user/token context (existing; tenant-aware)               | Extended |

Tenant admin surface (under existing admin shell):

| Method   | Endpoint                                                    | Description                                                                                                  | Status |
| -------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| `GET`    | `/api/admin/tenants/:tenantId/job-runtime`                  | Read current overlay (secrets redacted per [`settings-system.md`](../../architecture/settings-system.md) §7) | New    |
| `PUT`    | `/api/admin/tenants/:tenantId/job-runtime`                  | Upsert overlay; validates against provider's tenant-scope JSON Schema                                        | New    |
| `POST`   | `/api/admin/tenants/:tenantId/job-runtime/rotate`           | Bump `credential_version` (graceful drain — Q4)                                                              | New    |
| `POST`   | `/api/admin/tenants/:tenantId/job-runtime/force-invalidate` | Hard credential kill switch; cancels in-flight runs (Q4)                                                     | New    |
| `DELETE` | `/api/admin/tenants/:tenantId/job-runtime`                  | Revert to `inherit` (preserves history)                                                                      | New    |

## 5. Plugin Surface

- **NEW schema extension** `x-scope: tenant` registered in `packages/plugin/src/settings/extensions.ts`; resolver step inserted between `work` and `user` in [`settings-system.md`](../../architecture/settings-system.md) §2 cascade.
- Every job-runtime provider plugin (`packages/plugins/job-runtime-{trigger,temporal,bullmq,pgboss,inngest}`) **ships a second JSON Schema** alongside its global one: `tenantSettingsSchema` describing the BYO credential shape. The admin shell renders this schema-driven form dynamically — no provider-specific React.
- Provider plugins gain two optional contract methods:
    - `provisionTenant(tenantId, settings): Promise<{ secretRef, version }>` — called on first BYO save; for Temporal creates a namespace, for pg-boss creates `pgboss_<tenant_id>`, for Trigger.dev/Inngest documents the dashboard-paste workaround.
    - `deprovisionTenant(tenantId): Promise<void>` — called on `DELETE` overlay if `mode = byo`.
- Binding factory `packages/agent/src/tasks/job-runtime.providers.ts` (from EW-685) is wrapped — not replaced — by `packages/agent/src/tasks/tenant-aware-runtime.resolver.ts`.

## 6. Web / CLI Surface

- **Web (admin)**: new page `apps/web/src/app/admin/tenants/[tenantId]/job-runtime/page.tsx`. Reuses the existing JSON-Schema settings renderer (`components/settings/SchemaForm.tsx`) — the only new UI primitive is the provider picker, which is a `Select` driven by the operator allow-list.
- **Web (tenant self-serve)**: deferred to v2 (admin-imposed first; tenant self-edit gated behind ops flag).
- **CLI / internal-cli**: new `tenant-job-runtime` diagnostic command — print resolved binding + version for a given tenant id. Mirrors EW-683's `job-runtime status`.
- **MCP**: none.

## 7. Background Jobs

This feature **does not introduce new recurring jobs**. Every existing schedule from EW-683 §7 (`schedule dispatcher`, `deploy-ready poller`, `agent heartbeat`, etc.) now routes through the tenant resolver. Two operational concerns drop out:

- **Per-tenant schedule registration**: when a tenant flips to `byo`/`override`, the worker calls `provider.registerSchedules(schedules, { tenantId })`. Each provider maps `tenantId` onto its native namespacing (Temporal namespace, pg-boss schema, BullMQ key prefix, Trigger.dev project, Inngest app id).
- **Drain job**: a one-shot internal task `tenant-runtime-drain` runs when `credential_version` bumps — it waits for all in-flight runs at the old version to terminate before deleting old credentials (Q4 graceful drain).

## 8. Security & Permissions

- Tenant credentials are `x-secret: true`, `x-scope: tenant`, stored in the encrypted envelope; never returned in API responses (same redactor as plugin settings).
- The admin overlay endpoints require `tenant.admin` role; tenant self-serve (deferred v2) will require `tenant.owner`.
- `/internal/jobs/webhook/:tenantId/*` validates the per-tenant signing key (Trigger.dev `TRIGGER_SECRET_KEY`, Inngest `INNGEST_SIGNING_KEY`) **bound to the tenant**, not the platform. Wrong signature for a tenant's webhook ⇒ 401, audit-logged.
- `force-invalidate` is rate-limited (≤1/min/tenant) and emits a critical activity-log entry.
- Air-gap providers (Temporal/BullMQ/pg-boss) MUST NOT contact any SaaS during tenant provisioning; verified by the air-gap compose profile test extended in P6.

## 9. Observability

- `WorkGenerationHistory` keeps being the canonical status surface, now carrying `runtime_provider_id` + `runtime_credential_version` + `tenant_id` so the admin UI can answer "which runtime ran this, on which credential version, for which tenant."
- Sentry breadcrumbs include `tenant_id` + `runtime_provider_id` as tags (NOT credential values; see [`settings-system.md`](../../architecture/settings-system.md) §7).
- PostHog event `tenant_runtime_overlay_changed` fires on every mutation (provider id, mode, who, when — no secrets).
- Startup log per worker enumerates: instance-global runtime + count of tenants on each provider + count by mode.

## 10. Phased Rollout

Phases map to the EW-742 description. Each phase is a candidate sub-PR (or sub-PR stack).

### P0 — Spec-Kit deliverables (this story, [EW-743](https://evertech.atlassian.net/browse/EW-743))

- **Scope**: ADR-017, `spec.md`, this `plan.md`, `tasks.md`, parent `providers.md` cross-link, architecture cross-link in [`architecture/job-runtime-providers.md`](../../architecture/job-runtime-providers.md).
- **Files touched**: `docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md`, `docs/specs/features/tenant-job-runtime-overlay/{spec,plan,tasks,providers}.md`, link in `docs/specs/architecture/job-runtime-providers.md`.
- **Tech choices**: docs only.
- **Test plan**: markdown lint + internal link check (existing CI).
- **Exit gate**: all five docs merged on one PR; ADR-017 status `Proposed`; Jira EW-743 closed.
- **Dependencies**: none.
- **Risks**: spec drifts from parent EW-683 architecture if reviewers don't read both — mitigate by cross-link blocks at top of every doc.

### P1 — Data model + migration

- **Sub-story P1.0 (conditional)**: if `x-scope: tenant` is not yet a recognised value in [`settings-system.md`](../../architecture/settings-system.md), this becomes the FIRST sub-story — extend the extension registry, update the resolver cascade docs, ship as its own PR. Confirmed needed: today `x-scope` is `global`/`user`/`work` only.
- **Scope**: `TenantJobRuntimeConfig` entity + migration + repository + service.
- **Files touched**:
    - `apps/api/src/works/entities/tenant-job-runtime-config.entity.ts`
    - `apps/api/src/works/repositories/tenant-job-runtime-config.repository.ts`
    - `apps/api/src/works/services/tenant-job-runtime-config.service.ts`
    - `apps/api/src/migrations/<timestamp>-TenantJobRuntimeOverlay.ts`
    - `packages/plugin/src/settings/extensions.ts` (add `tenant` to `x-scope`)
    - `packages/plugin/src/contracts/capabilities/job-runtime-tenant.interface.ts` (sibling to the EW-685 P0 `job-runtime.interface.ts`)
    - `apps/api/src/plugins/services/plugin-settings.service.ts` (extend cascade with `tenant` tier)
- **Tech choices**: TypeORM entity with `@PrimaryColumn('uuid')`, `@Column({type: 'enum'})` for `mode`; AES-256-GCM secret envelope reused via existing `SecretsService`.
- **Test plan**:
    - Entity tests in `apps/api/test/tenant-job-runtime-config.entity.spec.ts`.
    - Migration up/down test in `apps/api/test/migrations/tenant-job-runtime-overlay.spec.ts`.
    - Cascade resolver tests proving `work > user > tenant > global > env > default` precedence.
- **Exit gate**: migration runs idempotently on a fresh DB and on a prod-snapshot replica; cascade test green; plugin settings UI still renders global plugins unchanged.
- **Dependencies**: P0.
- **Risks**: cascade ordering ambiguity (does `tenant` win over `user` or vice versa?) — locked by ADR-017 §"Cascade Precedence"; covered by the cascade test matrix.

### P2 — Tenant admin UI (schema-driven)

- **Scope**: provider picker + dynamic credentials form in the admin shell.
- **Files touched**:
    - `apps/web/src/app/admin/tenants/[tenantId]/job-runtime/page.tsx`
    - `apps/web/src/app/admin/tenants/[tenantId]/job-runtime/RuntimePickerForm.tsx`
    - `apps/web/src/components/settings/SchemaForm.tsx` (reuse; pass `scope: 'tenant'`)
    - `apps/api/src/works/controllers/tenant-job-runtime.controller.ts` (REST surface from §4)
    - Each `packages/plugins/job-runtime-*/src/tenant-schema.ts` ships its tenant JSON Schema.
- **Tech choices**: NestJS controller + `@CurrentUser()` guard; Next.js server component for page shell, client component for form (`'use client'` only on `RuntimePickerForm.tsx`). Reuses Ajv validator from settings-system.
- **Test plan**:
    - Vitest schema-render tests per provider (form mounts, secret fields show "set"/"rotate", no plaintext leak).
    - Playwright e2e in `apps/web/e2e/admin/tenant-runtime.spec.ts` — pick provider, paste creds, save, verify masked redisplay.
    - API integration test: PUT with `mode=byo` requires a valid secret payload; PUT with `mode=inherit` clears `credentials_secret_ref`.
- **Exit gate**: admin can switch a test tenant from `inherit` to `byo` for every bundled provider; redacted on read; activity log entry written.
- **Dependencies**: P1 (storage + cascade).
- **Risks**: Ajv server/client schema drift — mitigate by sharing the schema export from the plugin package, not duplicating in `apps/web`.

### P3 — Dispatcher routing (tenant-aware resolver + credential version capture)

- **Scope**: wrap EW-685's binding factory; capture credential version at enqueue.
- **Files touched**:
    - `packages/agent/src/tasks/tenant-aware-runtime.resolver.ts` (NEW)
    - `packages/agent/src/tasks/job-runtime.providers.ts` (extend from EW-685 — resolver consulted before fallback)
    - `packages/agent/src/tasks/work-generation-dispatcher.ts` and the other 7 dispatcher impls — accept `{tenantId}` in payload, pass through
    - `apps/api/src/works/services/work-generation.service.ts` (and siblings) — capture `runtime_provider_id` + `runtime_credential_version` into history row before `dispatch()`
- **Tech choices**: request-scoped NestJS provider for the resolver (per-request tenant context already exists via `@CurrentUser()` + tenant guard). LRU cache: `lru-cache` package, max 10k entries, TTL 60s.
- **Test plan**:
    - Unit: resolver returns global binding when no overlay; returns overlay binding when present + enabled; returns global when overlay exists but `enabled=false`.
    - Unit: enqueue path writes `runtime_credential_version` matching the resolver snapshot.
    - Integration: rotate credentials mid-test → in-flight run keeps old version; new enqueue picks new version.
- **Exit gate**: every dispatcher call site exercises the resolver in a parameterised test across 3 tenants × 5 providers.
- **Dependencies**: P1, P2.
- **Risks**: resolver-cache staleness allowing a window where new dispatches use revoked credentials — mitigate by `invalidate(tenantId)` on every mutation endpoint + 60s hard TTL.

### P4 — Worker host (multi-tenant credential injection)

- **Scope**: extend EW-686 worker host to accept tenant context and inject the right credentials per job.
- **Push-model providers (Trigger.dev, Inngest)**: per-tenant webhook routing `/api/jobs/webhook/:tenantId/...`. SaaS provider's webhook signature is verified against the tenant's signing key; tenant context attached before handing to the orchestrator.
- **Pull-model providers**:
    - **BullMQ** + **pg-boss** — single multiplexing worker per provider, reads `tenant_id` from job metadata, fetches the binding via the resolver, injects credentials at handler entry. Avoids N processes for N tenants.
    - **Temporal** — Temporal SDK binds a `Worker` to a single namespace, so we run **one Worker per active namespace**, lazily cold-started on first job. Worker registry tracks active namespaces; idle namespaces drop their Worker after 30 min.
- **Files touched**:
    - `packages/tasks/src/worker/tenant-worker-router.ts` (NEW)
    - `packages/tasks/src/worker/multiplex-worker.ts` (NEW; used by BullMQ + pg-boss)
    - `packages/tasks/src/worker/temporal-worker-registry.ts` (NEW)
    - `apps/api/src/works/controllers/internal-jobs-webhook.controller.ts` (NEW)
    - `packages/plugins/job-runtime-{trigger,inngest}/src/webhook.ts` — signature verification helpers
- **Tech choices**: vendor SDKs only (NN #17): `@trigger.dev/sdk`, `@temporalio/{client,worker}`, `bullmq`, `pg-boss`, `inngest`. No hand-rolled REST.
- **Test plan**:
    - Per-provider integration test: enqueue from tenant A and tenant B; verify each handler sees its own credentials.
    - Webhook signature-mismatch returns 401 + audit log entry.
    - Temporal: lazy-start a Worker for a previously unseen namespace; idle-evict after the configured TTL.
    - Multiplex: pg-boss + BullMQ workers correctly route 100 interleaved jobs across 5 tenants.
- **Exit gate**: end-to-end run on every provider, for ≥2 tenants in parallel, with distinct credentials, with run history correctly attributing each run.
- **Dependencies**: P3.
- **Risks**: Trigger.dev REST API can't read prod secret keys nor delete projects (documented in §end) — `per-tenant` mode requires worker self-registration OR a dashboard manual-paste workflow; doc this in the admin runbook P7.

### P5 — Plugin gating

- **Scope**: instance operator's plugin allow-list filters the tenant picker.
- **Files touched**:
    - `apps/api/src/works/services/tenant-job-runtime-config.service.ts` (filter `availableProviders()` against `PluginRegistryService` enablement)
    - `apps/web/src/app/admin/tenants/[tenantId]/job-runtime/RuntimePickerForm.tsx` (consume `availableProviders`)
- **Tech choices**: default = bundled-and-not-explicitly-disabled is available; per-tenant whitelist/blacklist deferred to v2 behind feature flag `EVER_WORKS_TENANT_RUNTIME_PER_TENANT_GATING`.
- **Test plan**:
    - Disable `temporal` instance-globally → tenant picker no longer offers it; existing tenants on `temporal` retain config but get a warning banner.
    - v2 flag off ⇒ no per-tenant whitelist UI rendered.
- **Exit gate**: admin can disable a provider and verify tenant pickers update without redeploy.
- **Dependencies**: P2, P4.
- **Risks**: in-flight tenant on a now-disabled provider — banner + read-only edit; force-revert requires explicit ops action.

### P6 — Multi-tenant conformance

- **Scope**: extend EW-683's shared conformance suite with a per-tenant variant parameterised across N tenants × M providers. Add graceful-drain + force-invalidate cases.
- **Files touched**:
    - `packages/plugin/src/contracts/__tests__/job-runtime.conformance.spec.ts` (parameterise existing cases over `tenantId`; the runtime conformance suite — sibling of the type-level `job-runtime.spec.ts` shipped in EW-685 P0 — lands with EW-686 P1 once there's a provider to run it against)
    - `packages/plugin/src/contracts/__tests__/job-runtime-tenant.conformance.spec.ts` (NEW — drain + force-invalidate + version capture)
    - CI matrix in `.github/workflows/ci.yml` — add axis `TENANT_COUNT={1,3}` against existing `JOB_RUNTIME={trigger,pgboss,bullmq,temporal,inngest}`.
- **Tech choices**: Vitest parameterised `describe.each`; per-tenant fixtures created in `beforeAll` via the provider's `provisionTenant()` hook; teardown via `deprovisionTenant()`.
- **Test plan**:
    - All existing EW-683 conformance cases run green with N=3 tenants on every provider.
    - Graceful drain: rotate credentials while a 30-s job is in-flight → job completes on old credentials → new enqueue uses new credentials.
    - Force-invalidate: trigger admin force-invalidate → in-flight runs cancelled within 5 s → fresh runs use new credentials.
- **Exit gate**: CI matrix green; conformance suite covers ≥95% of resolver branches.
- **Dependencies**: P3, P4, P5.
- **Risks**: CI cost balloons (N×M); mitigate by sharding the matrix and only running full matrix on `develop`/`stage`/`main` cascades, not feature branches.

### P7 — Docs + admin runbook + migration guide

- **Scope**: ops-facing runbooks + migration guide for existing tenants.
- **Files touched**:
    - `docs/devops/tenant-job-runtime-overlay.md` (NEW — admin runbook)
    - `docs/devops/migration-tenant-runtime-byo.md` (NEW — opt-in-without-losing-in-flight-work guide)
    - `docs/environment-variables.md` — add `EVER_WORKS_INHERIT_DEFAULT_MODE`, `EVER_WORKS_TENANT_RUNTIME_PER_TENANT_GATING`
    - `docs/plugin-system/built-in-plugins.md` — note `tenantSettingsSchema` on each job-runtime plugin
    - `docs/specs/architecture/job-runtime-providers.md` — append tenant-overlay section linking back here
- **Tech choices**: docs only.
- **Test plan**: markdown lint + Docusaurus build (CI).
- **Exit gate**: runbook reviewed by an operator who is not the author; migration guide validates on a staging tenant.
- **Dependencies**: P6.
- **Risks**: doc rot — owner assigned per file in `docs/internal/ownership.md`.

### Dependency overview

- P0 blocks everything (specs/ADR drive the rest).
- P1 blocks every post-P1 phase.
- P2 depends on P1; P3 depends on P1 (resolver needs the entity).
- P4 depends on P3; P5 depends on P2 + P4; P6 depends on P3 + P4 + P5; P7 trails P6.
- P2 and P3 can parallelise once P1 lands.

## 11. Cross-Cutting Risks

| Risk                                                                                        | Likelihood | Impact | Mitigation                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-tenant Temporal namespace ops (control-plane quota)                                     | Med        | High   | Hybrid `shared`/`per-tenant`/`tiered` default (Q5) lets ops keep small tenants on shared namespace; quota alerts in Temporal Cloud dashboard.                                                                                      |
| Per-tenant pg-boss schema migration ops (N schemas to migrate on pg-boss version bump)      | High       | Med    | `MultiSchemaMigrator` utility iterates `pgboss_*` schemas on platform boot; rate-limited to avoid lock storms; explicit runbook step in `docs/devops/`.                                                                            |
| Secret-encryption key rotation across N tenants × M providers                               | Med        | High   | Reuses existing AES-256-GCM `keyId`-tagged envelope from [`settings-system.md`](../../architecture/settings-system.md) §5; rotation is read-old-write-new; covered by P6 conformance.                                              |
| Multi-tenant test isolation in CI (cross-tenant credential bleed during parallel runs)      | Med        | High   | Vitest fixtures use `crypto.randomUUID()` tenant ids per test file; conformance suite asserts handler sees only its tenant's creds (negative test).                                                                                |
| Signup latency from per-tenant Trigger.dev provisioning under Q5 `per-tenant` mode          | High       | Med    | Lazy provisioning (first-job-triggers-provision) + async warmup queue; ops can flip to `shared` if latency budget breached.                                                                                                        |
| Trigger.dev REST limitations: PAT cannot read prod secret keys nor delete projects via REST | High       | Med    | Document workaround in `docs/devops/tenant-job-runtime-overlay.md`: either worker self-registration via Trigger.dev project-token bootstrap, OR dashboard manual paste; `deprovisionTenant` for Trigger.dev no-ops with a warning. |
| Inngest signing-key bound to platform, not tenant — wrong key ⇒ webhook 401                 | Med        | Med    | Per-tenant `INNGEST_SIGNING_KEY` stored in `credentials_secret_ref`; webhook handler picks tenant from URL path THEN verifies signature; mismatched tenant gets audit-logged + 401.                                                |
| Resolver cache staleness window (≤60 s) lets a revoked credential enqueue one more job      | Low        | Med    | `invalidate(tenantId)` on every mutation endpoint; force-invalidate path also flushes the cache cluster-wide via pub/sub.                                                                                                          |
| EW-683 binding factory churn during P3 wrap                                                 | Low        | Med    | Resolver wraps factory rather than replacing it; existing instance-global tests run unchanged as a regression gate.                                                                                                                |

## 12. Constitution Reconciliation

- **I Plugin-first** — tenant overlay is consumed by the same plugin contracts; no new platform-special-case. ✓
- **II Capability-driven** — `job-runtime` capability gains a tenant scope; resolution unchanged in shape. ✓
- **III Source-of-truth repos** — tenant overlay is platform-side metadata, not work content. ✓
- **IV Long-running work via configured job-runtime provider** — already amended by [ADR-015](../../decisions/015-job-runtime-provider-pluggability.md); ADR-017 adds the tenant overlay clause. ✓
- **V Forward-only migrations** — entity additive; `*_history` column adds two-phase. ✓
- **VI Tests** — multi-tenant conformance extends EW-683's suite. ✓
- **VII Secrets** — tenant credentials reuse the existing encrypted envelope + redactor. ✓
- **VIII Plugin-count canonical doc** — no new plugins; existing job-runtime plugins gain `tenantSettingsSchema`. ✓
- **IX Behaviour-first** — behaviour in `spec.md`; impl here. ✓
- **X Backwards-compatible** — tenants without an overlay row inherit instance-global; zero behaviour change. ✓

## 13. References

- Spec: [`./spec.md`](./spec.md) · Tasks: [`./tasks.md`](./tasks.md) · Providers: [`./providers.md`](./providers.md)
- ADRs: [ADR-017](../../decisions/017-tenant-scoped-job-runtime-overlay.md), [ADR-015](../../decisions/015-job-runtime-provider-pluggability.md), [ADR-005](../../decisions/005-cache-and-lock-pluggability.md)
- Architecture: [`job-runtime-providers.md`](../../architecture/job-runtime-providers.md), [`settings-system.md`](../../architecture/settings-system.md), [`database.md`](../../architecture/database.md)
- Parent feature: [`features/job-runtime-providers/plan.md`](../job-runtime-providers/plan.md) · [`tasks.md`](../job-runtime-providers/tasks.md) · [`providers.md`](../job-runtime-providers/providers.md)
- Jira: [EW-742 (epic)](https://evertech.atlassian.net/browse/EW-742) · [EW-743 (this story)](https://evertech.atlassian.net/browse/EW-743) · [EW-683 (parent epic)](https://evertech.atlassian.net/browse/EW-683) · [EW-685 (dispatcher seam)](https://evertech.atlassian.net/browse/EW-685) · [EW-686 (worker host)](https://evertech.atlassian.net/browse/EW-686)
