# Task Breakdown: Job-Runtime Provider Pluggability

**Feature ID**: `job-runtime-providers`
**Status**: `Draft` (not started)
**Last updated**: 2026-05-28
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md) · **Providers**: [`./providers.md`](./providers.md) · **Epic**: [EW-683](https://evertech.atlassian.net/browse/EW-683)

> Ordered, granular tasks with explicit paths. Phases map to `plan.md` §10. Each phase is a candidate sub-PR. Mark `[x]` as landed. Suggested Jira child-issue grouping noted per phase (e.g. `[EW-683 T1–T6]`).

---

## Phase 0 — Contract & seam (no behaviour change) · `[EW-683 P0]`

T1 + T2 ✅ Done in [#1354](https://github.com/ever-works/ever-works/pull/1354). T3 + T4 remain (factory + selector env var). T5 + T6 trail.

- [x] **T1.** Define the `job-runtime` capability via `IJobRuntimeProvider` exported from `packages/plugin/src/contracts/capabilities/job-runtime.interface.ts` (the existing capabilities barrel was the natural home alongside the other 25+ capability contracts; no separate `job-runtime.category.ts` file needed since capability strings are declared in JSDoc on the interface itself, matching how `dns.interface.ts` handles it).
- [x] **T2.** Defined `IJobRuntimeProvider`, `JobRunStatus`, `ScheduleSpec`, `JobEnqueueOptions`, `JobRuntimeDispatchers` (plus `JobRuntimeId`, `WorkerHostOptions`, `WorkerHostHandle`) in `packages/plugin/src/contracts/capabilities/job-runtime.interface.ts`. Run id naming: kept opaque `string` (was originally going to decide `triggerRunId` vs `runtimeRunId` — punted, both shipping providers will produce strings that fit the existing `triggerRunId` column without rename).
- [ ] **T3.** Add `EVER_WORKS_JOB_RUNTIME` to config (`packages/agent/src/config/index.ts`): `getJobRuntime()` default `'trigger'`, validated enum.
- [ ] **T4.** Binding factory `packages/agent/src/tasks/job-runtime.providers.ts`: resolve active provider from registry by `EVER_WORKS_JOB_RUNTIME`, bind all `*_DISPATCHER` symbols to `provider.dispatchers`. Bound to `trigger` by default.
- [ ] **T5.** Amend Constitution Principle IV (`.specify/memory/constitution.md`) → "via the configured job-runtime provider (Trigger.dev default)"; cross-link [ADR-015](../../decisions/015-job-runtime-provider-pluggability.md). (Lands in this phase's PR.)
- [ ] **T6.** Startup log: active runtime id + `experimental` warning when non-default & not yet conformance-green.

## Phase 1 — Re-house Trigger.dev as the `trigger` provider · `[EW-683 P1]`

- [ ] **T7.** Scaffold `packages/plugins/job-runtime-trigger/` (package.json `everworks.plugin` category `job-runtime`, tsup, vitest).
- [ ] **T8.** Move `TriggerService` (`packages/tasks/src/trigger/trigger.service.ts`) behind `IJobRuntimeProvider` in the new plugin (or adapter that wraps it). `dispatchers` = existing methods; `cancel` = `runs.cancel`; `registerSchedules` = existing `schedules.task`; `startWorkerHost` = no-op.
- [ ] **T9.** Keep `packages/tasks/` as the trigger worker package; wire it to the provider. Generalise `/internal/trigger/*` → `/internal/jobs/*` with alias routes; `x-trigger-secret` → `x-internal-secret` with alias.
- [ ] **T10.** **Gate:** existing Trigger.dev e2e suite (`apps/web/e2e/*` trigger/worker tests) passes unchanged. No behaviour diff.

## Phase 2 — Conformance harness · `[EW-683 P2]`

- [ ] **T11.** Provider-agnostic runtime conformance suite, e.g. at `packages/plugin/src/contracts/__tests__/job-runtime.conformance.spec.ts` (parallel to the type-level shape spec at `job-runtime.spec.ts` already shipped in EW-685 P0): enqueue→run→status, idempotency (same key → one logical run), concurrency (same key serialises), cancel (in-flight aborts → `CANCELLED`), schedule fires, disabled→`null`+in-process fallback.
- [ ] **T12.** Run harness green against `trigger`. Add a CI matrix axis `JOB_RUNTIME={trigger}` (extend per provider in later phases).

## Phase 3 — pg-boss provider (Postgres-native, GA-track) · `[EW-683 P3]`

- [ ] **T13.** Scaffold `packages/plugins/job-runtime-pgboss/`; runtime dep `pg-boss`; settings: `PGBOSS_DATABASE_URL` (defaults to platform `DATABASE_URL`), `PGBOSS_SCHEMA` (`pgboss`).
- [ ] **T14.** Implement `dispatchers.*` via `boss.send(name, payload, { id, singletonKey })`; `cancel` = cancel-flag + `boss.cancel`; `getRunStatus` = `boss.getJobById`; `registerSchedules` = `boss.schedule(cron)`.
- [ ] **T15.** Worker host: `boss.start()` + `boss.work(name, handler)` running the agent orchestrator; worker entrypoint + `pnpm` script.
- [ ] **T16.** Cooperative cancel: reuse `throwIfGenerationCancelled` checkpoints against a cancel flag; tune `expireInHours` for multi-hour jobs.
- [ ] **T17.** Compose profile `pgboss` (no Redis, no SaaS); CI matrix axis `JOB_RUNTIME=pgboss`; conformance green. Mark GA-track.

## Phase 4 — BullMQ provider (Redis) · `[EW-683 P4]`

- [ ] **T18.** Scaffold `packages/plugins/job-runtime-bullmq/`; runtime dep `bullmq`; settings: `BULLMQ_REDIS_URL`, `BULLMQ_PREFIX`, `BULLMQ_CONCURRENCY`.
- [ ] **T19.** Implement `dispatchers.*` via `queue.add(name, payload, { jobId })`; `registerSchedules` via repeatable jobs / `JobScheduler`; `getRunStatus` via `Job.getState()`; `cancel` via cancel-flag (+ remove if pending).
- [ ] **T20.** Worker host: `Worker(name, handler, { concurrency, lockDuration, lockRenewTime })` running the orchestrator; replicas; tune lock renewal for multi-hour jobs.
- [ ] **T21.** Compose profile `bullmq` (+ Redis service); CI matrix `JOB_RUNTIME=bullmq`; conformance green. Experimental→GA.

## Phase 5 — Temporal provider (self-host / remote / Cloud) · `[EW-683 P5]`

- [ ] **T22.** Scaffold `packages/plugins/job-runtime-temporal/`; runtime deps `@temporalio/{client,worker,workflow,activity}`; settings: `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`, `TEMPORAL_TLS_CERT`/`TEMPORAL_TLS_KEY` (Cloud mTLS, `x-secret`).
- [ ] **T23.** Express the generation/import orchestrators as **Workflows**; agent I/O (AI/search/git) as **Activities** (calling back over SuperJSON or in-process). Keep workflow code deterministic.
- [ ] **T24.** `dispatchers.*` → `client.workflow.start(..., { workflowId, taskQueue })`; `cancel` → `handle.cancel()`; `registerSchedules` → Schedules API; `getRunStatus` → `DescribeWorkflowExecution`.
- [ ] **T25.** Worker host: `@temporalio/worker` Worker bound to the task queue; deployment/sidecar + `pnpm` script.
- [ ] **T26.** CI: `temporal server start-dev` service; matrix `JOB_RUNTIME=temporal`; conformance green. Experimental→GA.

## Phase 6 — Inngest provider (SaaS only) · `[EW-683 P6]`

- [ ] **T27.** Scaffold `packages/plugins/job-runtime-inngest/`; runtime dep `inngest`; settings: `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` (`x-secret`), `INNGEST_APP_ID`. **No self-host path** — doc SSPL rationale in plugin README + [`providers.md`](./providers.md#6-inngest-saas-only--licensing-bounded).
- [ ] **T28.** Define functions with `createFunction`; mount `serve()` HTTP handler (in API or small service) with signing-key verification; `dispatchers.*` → `inngest.send({ name, data, id })`; cron functions for schedules; `cancel` via `cancelOn`/REST.
- [ ] **T29.** Address per-step limits: express long pipeline as steps where needed; document. CI with Inngest dev/mocked; conformance (push-model variant) green. Experimental.

## Phase 7 — Docs, matrix & cleanup · `[EW-683 P7]`

- [ ] **T30.** Provider deploy guides under `docs/devops/` (one per provider: env, worker host, compose/k8s, switch-runtime runbook + in-flight-drain note).
- [ ] **T31.** Env reference: add `EVER_WORKS_JOB_RUNTIME` + per-provider vars to `docs/environment-variables.md`.
- [ ] **T32.** Update canonical plugin count/category doc (`docs/plugin-system/built-in-plugins.md` / `plugin-categories.md`) with the `job-runtime` category + 5 providers (Principle VIII).
- [ ] **T33.** k8s manifests: parameterise the worker deployment per active runtime (`.deploy/k8s/k8s-manifest.{dev,stage,prod}.yaml`).
- [ ] **T34.** Finalise GA vs experimental labels per `plan.md` §10; flip CI gates accordingly.

## Dependency notes

- T1–T6 block everything (the contract).
- T7–T10 (re-house trigger) block T11–T12 (conformance needs a reference provider).
- T11–T12 block every provider phase (each must pass the suite).
- Phases 3–6 are independent of each other and can parallelise after Phase 2.
- T30–T34 (docs/matrix) trail each provider as it lands.
