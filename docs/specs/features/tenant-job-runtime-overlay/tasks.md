# Task Breakdown: Tenant-Scoped Job-Runtime Overlay

**Feature ID**: `tenant-job-runtime-overlay`
**Status**: `Draft` (not started)
**Last updated**: 2026-06-18
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md) · **Providers**: [`./providers.md`](./providers.md) · **Epic**: [EW-742](https://evertech.atlassian.net/browse/EW-742) · **Story**: [EW-743](https://evertech.atlassian.net/browse/EW-743) · **ADR**: [ADR-017](../../decisions/017-tenant-scoped-job-runtime-overlay.md)

> Ordered, granular tasks with explicit paths. Phases map to `plan.md` §10. Each phase is a candidate sub-PR. Mark `[x]` as landed. Suggested Jira child-issue grouping noted per phase (e.g. `[EW-742 P1]`). Builds on EW-683's instance-level job-runtime contract; nothing here re-opens [ADR-017 Q1–Q5](../../decisions/017-tenant-scoped-job-runtime-overlay.md) (Temporal namespace-per-tenant, pg-boss schema-per-tenant, Inngest inherit/BYO uniform with Trigger.dev, credential rotation via graceful drain + separate `force-invalidate`, hybrid operator-gated platform-default `shared`/`per-tenant`/`tiered`).

---

## Phase 0 — Spec-Kit (this PR, EW-743) · `[EW-743 P0]`

- [ ] **T1.** Write [ADR-017](../../decisions/017-tenant-scoped-job-runtime-overlay.md) at `docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md` capturing Q1–Q5 locked decisions and the inherit/BYO overlay rationale on top of EW-683.
- [ ] **T2.** Write `docs/specs/features/tenant-job-runtime-overlay/spec.md` — behaviour-first user stories (tenant picks provider, operator gates allow-list, graceful drain on rotation, force-invalidate path) with no implementation detail.
- [ ] **T3.** Write `docs/specs/features/tenant-job-runtime-overlay/plan.md` — architecture, data model, API surface, phased rollout, constitution reconciliation; mirrors structure of [`job-runtime-providers/plan.md`](../job-runtime-providers/plan.md).
- [ ] **T4.** Write `docs/specs/features/tenant-job-runtime-overlay/tasks.md` (this file) — numbered T1..TN per phase with file paths.
- [ ] **T5.** Write `docs/specs/features/tenant-job-runtime-overlay/providers.md` — per-provider tenant-isolation matrix (Temporal namespace, pg-boss schema, BullMQ prefix, Trigger.dev project, Inngest app) and inherit-vs-BYO knob per provider.
- [ ] **T6.** Cross-link from `docs/specs/architecture/job-runtime-providers.md` to the tenant-overlay docs by adding a "Tenant-scoped overlay" see-also section pointing at `spec.md`, `plan.md`, and [ADR-017](../../decisions/017-tenant-scoped-job-runtime-overlay.md).
- [ ] **T7.** Verify constitution gates against `.specify/memory/constitution.md` — confirm Principle IV ("via the configured job-runtime provider") already covers tenant overlay; no new amendment required, document the verification in `plan.md` §Constitution Reconciliation.

## Phase 1 — Data model + migration · `[EW-742 P1]`

- [ ] **T8.** Audit `docs/specs/architecture/settings-system.md` for `x-scope: tenant`; if missing, add it to the scope taxonomy alongside `x-scope: global` (verify in worktree before writing — this is a prerequisite for tenant-scoped credentials).
- [ ] **T9.** Define TypeORM entity `TenantJobRuntimeConfig` in `apps/api/src/works/entities/tenant-job-runtime-config.entity.ts` — columns: `tenantId` (PK), `providerId`, `mode` (`inherit` | `byo` | `override`), `credentialsSecretRef`, `credentialVersion`, `enabled`, `createdBy`, `createdAt`, `updatedAt`.
- [ ] **T10.** Write TypeORM migration `apps/api/src/migrations/<timestamp>-AddTenantJobRuntimeConfig.ts` for the new table plus indexes on `tenantId` and `providerId`; forward-only per `docs/specs/architecture/database-migrations.md`.
- [ ] **T11.** Implement `CredentialVersionService` for graceful drain (Q4) in `packages/agent/src/tasks/credential-version.service.ts` — issues monotonic per-tenant version ids and resolves a snapshot for a given `(tenantId, version)` tuple so in-flight runs keep their original credentials.
- [ ] **T12.** Add audit-log table + entity for tenant runtime config changes in `apps/api/src/works/entities/tenant-job-runtime-audit.entity.ts` plus matching migration; records `(tenantId, actorUserId, action, before, after, credentialVersion, occurredAt)`.
- [ ] **T13.** Repository + unit tests under `apps/api/src/works/__tests__/tenant-job-runtime-config.repository.spec.ts` covering insert, update, version bump, audit-row emission, and tenant isolation (one tenant cannot read another's row).

## Phase 2 — Admin UI · `[EW-742 P2]`

- [ ] **T14.** API endpoints `GET /api/account/job-runtime/config` and `PUT /api/account/job-runtime/config` in `apps/api/src/account/job-runtime.controller.ts` — guarded by tenant-admin role, returns redacted credentials on GET, accepts `{ providerId, mode, credentials }` on PUT and writes through the repository + audit log.
- [ ] **T15.** Tenant settings page in `apps/web/src/app/(account)/settings/job-runtime/page.tsx` — server component that loads current config and renders the picker + credentials form.
- [ ] **T16.** Provider picker component in `apps/web/src/components/job-runtime/provider-picker.tsx` — radio list of operator-enabled providers with `inherit` vs `BYO` vs `override` mode toggle per provider.
- [ ] **T17.** Schema-driven credentials form component in `apps/web/src/components/job-runtime/credentials-form.tsx` reusing the existing settings-system JSON-Schema renderer (`x-secret`, `x-widget`, `x-envVar`) so no per-provider bespoke form is needed.
- [ ] **T18.** Validation + error surfacing — show "provider disabled by operator", "credentials rejected by provider reachability probe", and "force-invalidate in progress" states via toast + inline field errors; reachability probe lives in `apps/api/src/account/job-runtime.controller.ts`.
- [ ] **T19.** Playwright e2e test for the tenant config flow at `apps/web/e2e/tenant-job-runtime.spec.ts` — covers picker selection, BYO credential save, inherit fallback, validation error surfacing, and audit-row verification via API.

## Phase 3 — Dispatcher routing · `[EW-742 P3]`

- [ ] **T20.** Extend EW-685's binding factory (`packages/agent/src/tasks/job-runtime.providers.ts`) with a tenant-aware resolver that takes `(tenantId, jobName)` and returns the active `IJobRuntimeProvider` bound to that tenant's overlay credentials (or the inherited instance default).
- [ ] **T21.** Credential cache with 15–60s TTL in `packages/agent/src/tasks/tenant-credential.cache.ts` — keyed by `(tenantId, providerId, credentialVersion)`, in-process LRU with explicit invalidate on version bump or force-invalidate.
- [ ] **T22.** Credential version capture at every enqueue (Q4) — extend dispatch call sites to read the current `(tenantId, providerId)` version from `CredentialVersionService` and stamp `credentialVersion` into the run record so the worker host resolves the same snapshot when the job runs.
- [ ] **T23.** Fallback path to instance-global default when a tenant has no overlay row — resolver returns the EW-683 instance binding unchanged; tests in T24 prove zero-overhead for tenants that never opt in.
- [ ] **T24.** Unit tests for the resolver under `packages/agent/src/tasks/__tests__/tenant-job-runtime.resolver.spec.ts` covering inherit fallback, BYO overlay, cache hit/miss, version-snapshot resolution, and cache invalidation on rotation.

## Phase 4 — Worker host · `[EW-742 P4]`

- [ ] **T25.** Per-tenant webhook routing for Trigger.dev in `packages/tasks/src/trigger/tenant-webhook.handler.ts` — dispatches incoming Trigger.dev webhook events to the tenant whose `triggerRunId` matches the run, validating signing key against the tenant's BYO credential snapshot.
- [ ] **T26.** Per-tenant webhook routing for Inngest in `packages/plugins/job-runtime-inngest/src/tenant-webhook.handler.ts` — analogous to T25, validates Inngest signing key per tenant; doc cross-link to [`./providers.md`](./providers.md) for the SaaS-only constraint.
- [ ] **T27.** Per-tenant namespace polling for Temporal in `packages/plugins/job-runtime-temporal/src/tenant-worker-host.ts` — one worker per `(tenantId, namespace)` (Q1: namespace-per-tenant) bound to the task queue resolved from the tenant overlay.
- [ ] **T28.** Per-tenant queue polling for BullMQ in `packages/plugins/job-runtime-bullmq/src/tenant-worker-host.ts` — one worker per `(tenantId, queueName)` with BullMQ `prefix` set to the tenant id; reuses `lockDuration`/`lockRenewTime` from EW-683's host config.
- [ ] **T29.** Per-tenant schema polling for pg-boss in `packages/plugins/job-runtime-pgboss/src/tenant-worker-host.ts` — one `boss` instance per `(tenantId, schema)` (Q2: schema-per-tenant), reusing the platform `DATABASE_URL` by default.
- [ ] **T30.** Multiplexing worker option (config flag) in each provider's worker host — one worker process polls all tenants and routes per `tenant_id` in job metadata; selected via `EVER_WORKS_JOB_RUNTIME_HOSTING={per-tenant|shared|tiered}` matching Q5's operator-gated platform-default.
- [ ] **T31.** Tenant-id propagation in run metadata for all providers — extend `JobEnqueueOptions` in `packages/plugin/src/job-runtime/job-runtime.contract.ts` with a `tenantId` field and ensure every provider's dispatcher stamps it (Trigger `metadata`, Inngest `data`, Temporal `searchAttributes`, BullMQ `opts.tenantId`, pg-boss payload field).
- [ ] **T32.** Integration tests per provider × per-tenant scenario under each plugin's `__tests__/tenant-isolation.spec.ts` — two tenants on the same provider, verify no cross-tenant run leakage and that webhook/poller routing lands on the correct tenant.

## Phase 5 — Plugin gating · `[EW-742 P5]`

- [ ] **T33.** Instance plugin allow-list config in `apps/api/src/config/plugins.config.ts` — operator-controlled list of `job-runtime.*` plugin ids exposed to tenants, plus the Q5 platform-default mode (`shared`/`per-tenant`/`tiered`); resolved through the settings hierarchy with `x-scope: global`.
- [ ] **T34.** Picker filter in tenant admin UI — `apps/web/src/components/job-runtime/provider-picker.tsx` only renders providers that appear in the operator allow-list resolved from a new `GET /api/account/job-runtime/available-providers` endpoint.
- [ ] **T35.** Audit-log entry on operator disable/enable — emit a `tenant_job_runtime_audit` row with `action='operator_allowlist_change'` for every tenant whose current provider becomes disabled, surfacing a banner in the tenant settings page on next load.

## Phase 6 — Conformance · `[EW-742 P6]`

- [ ] **T36.** Per-tenant test harness extending EW-683's conformance suite under `packages/plugin/src/job-runtime/testing/tenant-conformance.ts` — parameterised by `(providerId, tenantA, tenantB)`, reuses the base contract suite then layers tenant-isolation, rotation, and force-invalidate assertions.
- [ ] **T37.** Parameterised per-tenant conformance run per provider in CI — extend the existing `JOB_RUNTIME={trigger|temporal|bullmq|pgboss|inngest}` matrix in `.github/workflows/` with a `TENANT_OVERLAY={off|on}` axis; both axes must be green per provider.
- [ ] **T38.** Graceful drain test (Q4) in `packages/plugin/src/job-runtime/testing/tenant-conformance.ts` — enqueue run with credential version N, rotate to N+1 mid-run, verify the in-flight run completes with N's credential snapshot and a newly enqueued run uses N+1.
- [ ] **T39.** Force-invalidate test in `packages/plugin/src/job-runtime/testing/tenant-conformance.ts` — invoke the admin `POST /api/account/job-runtime/force-invalidate` action, verify in-flight runs are marked `FAILED` (with `reason='credential_force_invalidated'`) and new enqueues are blocked until a new credential is saved.
- [ ] **T40.** Cross-provider isolation test in `packages/plugin/src/job-runtime/testing/tenant-conformance.ts` — tenant A on `pgboss`, tenant B on `temporal`; concurrent enqueues, verify zero cross-talk in run records, webhooks, and worker logs.

## Phase 7 — Docs · `[EW-742 P7]`

- [ ] **T41.** Tenant admin runbook in `docs/runbooks/tenant-job-runtime.md` — how to pick a provider, enter BYO credentials, rotate, and read the audit log; cross-link `spec.md` and `providers.md`.
- [ ] **T42.** Operator runbook in `docs/runbooks/operator-job-runtime-overlay.md` — covers Q5 modes (`shared` / `per-tenant` / `tiered`), allow-list gating, force-invalidate procedure with on-call checklist, and rollback to inherit-only.
- [ ] **T43.** Per-provider tenant-config docs — add a "Tenant overlay" section to each provider plugin README (`packages/plugins/job-runtime-{trigger,temporal,bullmq,pgboss,inngest}/README.md`) and cross-link [`./providers.md`](./providers.md).
- [ ] **T44.** Migration guide for existing tenants in `docs/runbooks/tenant-job-runtime-migration.md` — how to opt into BYO without losing in-flight work (graceful drain procedure, version-pinning checklist, fallback to inherit if BYO probe fails).

## Dependency notes

- T1–T7 (spec-kit) block everything else; this PR ships only Phase 0.
- T8 (`x-scope: tenant`) blocks T9–T13 (data model needs the scope token).
- T9–T13 (data model) block T14–T19 (admin UI writes through the repository) and T20–T24 (resolver reads from the repository).
- T20–T24 (dispatcher) block T25–T32 (worker host needs the tenant-aware resolver to know which credentials a run belongs to).
- T31 (`tenantId` in `JobEnqueueOptions`) blocks T25–T30 (all per-tenant routing depends on the metadata field).
- T33–T35 (gating) can land in parallel with Phase 4 but must precede T19 going green (e2e validates the operator-gated picker).
- T36–T40 (conformance) trail each provider's worker-host task (T27/T28/T29 for self-host, T25/T26 for SaaS).
- T41–T44 (docs) trail each phase as it lands.
