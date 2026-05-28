# Feature Specification: Job-Runtime Provider Pluggability

> Behaviour-first spec. Describes **what** the system does once the background-job runtime is a swappable provider — not how it's wired. Implementation lives in [`plan.md`](./plan.md); provider detail in [`providers.md`](./providers.md); rationale in [ADR-015](../../decisions/015-job-runtime-provider-pluggability.md).

**Feature ID**: `job-runtime-providers`
**Branch**: `feat/job-runtime-providers`
**Status**: `Draft`
**Created**: 2026-05-28
**Last updated**: 2026-05-28
**Owner**: Ever Works Team
**Epic**: [EW-683](https://evertech.atlassian.net/browse/EW-683)

---

## 1. Overview

An operator can choose **which background-job runtime** powers all long-running work (generation, import, onboarding, scheduled dispatch, KB embedding, webhook delivery, agent jobs) on their deployment, by setting a single environment selector. Trigger.dev (SaaS) remains the default and behaves exactly as today; operators may instead select **Trigger.dev self-hosted**, **Temporal** (self-hosted, remote, or Temporal Cloud), **BullMQ** (on Redis), **pg-boss** (on PostgreSQL — no Redis, no SaaS), or **Inngest** (SaaS only). The choice is invisible to users of the platform: a work generates, cancels, schedules, and reports status identically regardless of runtime.

## 2. User Scenarios

The "user" here is primarily the **operator** deploying Ever Works, plus the **end user** whose work runs (who should notice nothing).

### 2.1 Primary scenarios

- **Given** I deploy Ever Works with no runtime config, **when** the API starts, **then** it uses Trigger.dev SaaS exactly as today (zero config change vs. the current release).
- **Given** I set `EVER_WORKS_JOB_RUNTIME=pgboss` and a `DATABASE_URL`, **when** I start the API and a worker with no Redis and no external SaaS, **then** work generation runs end-to-end on PostgreSQL alone.
- **Given** I set `EVER_WORKS_JOB_RUNTIME=temporal` pointing at my Temporal cluster, **when** a user generates a work, **then** the run executes on my Temporal workers and the user sees the same status/logs UI as on Trigger.dev.
- **Given** I select `bullmq` with a Redis URL, **when** a user triggers generation, **then** the job runs on a BullMQ worker and is visible in the same `WorkGenerationHistory` UI.
- **Given** I select `inngest` with Inngest Cloud keys, **when** scheduled updates are due, **then** an Inngest cron function dispatches them.
- **Given** any runtime, **when** a user clicks "Cancel" mid-generation, **then** the in-flight run aborts and the work transitions to `CANCELLED`.

### 2.2 Edge cases & failures

- **Given** the selected runtime is misconfigured/unreachable, **when** the API tries to enqueue, **then** dispatch returns `null` and (in dev) the work runs in-process, or (in prod) surfaces a friendly "background runtime unavailable" error — never a 500 with a stack trace.
- **Given** a run is retried by the runtime, **when** it re-executes, **then** it writes to the **same** `WorkGenerationHistory` row (stable `historyId`/idempotency) rather than creating a duplicate.
- **Given** two scheduled-dispatcher ticks overlap, **when** both try to claim the same due schedule, **then** exactly one wins (the CAS claim is runtime-neutral) regardless of provider.
- **Given** an operator switches `EVER_WORKS_JOB_RUNTIME` between deploys, **when** runs were in-flight on the old runtime, **then** those drain on the old runtime (or are safely re-enqueued); no run is silently lost or double-executed.
- **Given** a non-default provider is still `experimental`, **when** an operator selects it, **then** startup logs a clear "experimental runtime" warning.
- **Given** Inngest, **when** an operator tries to self-host it, **then** the docs explicitly state Inngest is SaaS-only here and why (SSPL), pointing them to Temporal/BullMQ/pg-boss for self-owned runtimes.

## 3. Functional Requirements

- **FR-1** The system MUST select the active job runtime from `EVER_WORKS_JOB_RUNTIME` ∈ {`trigger`,`temporal`,`bullmq`,`pgboss`,`inngest`}, defaulting to `trigger` when unset.
- **FR-2** The system MUST expose every background job through the existing agent **dispatcher interfaces**; call sites MUST NOT depend on any specific runtime SDK.
- **FR-3** The system MUST run exactly **one** active runtime per deployment (no per-work runtime routing in v1).
- **FR-4** Each runtime provider MUST implement enqueue, schedule (cron), cancel, and run-status reporting for all dispatched job types.
- **FR-5** The system MUST preserve idempotency: a retried run MUST reuse the pre-created `historyId` and write to the same history row.
- **FR-6** The system MUST preserve concurrency keys currently in use (KB mirror/embed per `workId`, org overlay per `organizationId`).
- **FR-7** Cancellation MUST propagate an abort to the running orchestrator so in-flight AI/search/git work stops (native signal where available; cooperative cancel flag otherwise).
- **FR-8** Provider credentials/options MUST be declared via the standard plugin settings schema with `x-secret`/`x-envVar`/`x-scope: global`, resolved through the existing settings hierarchy, and never returned in API responses.
- **FR-9** The Trigger.dev provider MUST be a behaviour-preserving re-housing of the current `TriggerService` — no observable change for existing deployments.
- **FR-10** Every provider MUST pass one shared **conformance suite** (enqueue → run → status → cancel → schedule → idempotency) before being marked supported.
- **FR-11** The system MUST keep the in-process dev fallback when the runtime is disabled/unreachable (dispatch returns `null`).
- **FR-12** The pg-boss provider MUST be able to reuse the platform's existing PostgreSQL (`DATABASE_URL`), requiring no Redis and no external SaaS.
- **FR-13** The Inngest provider MUST be SaaS-only; the system MUST NOT ship a self-host path for Inngest, and docs MUST state the SSPL rationale.
- **FR-14** Each provider MUST use the **official vendor SDK** (`@trigger.dev/sdk`, `@temporalio/*`, `bullmq`, `pg-boss`, `inngest`); hand-rolled REST clients are forbidden (NN #22).
- **FR-15** Non-default providers MUST ship behind an `experimental` flag and log a warning on selection until they pass the conformance suite in CI.
- **FR-16** The system SHOULD preserve the SuperJSON internal callback channel as provider-neutral (`/internal/*`), so any pull-model worker reads/writes DB state through the API.
- **FR-17** The system MUST NOT remove or weaken self-hosted Trigger.dev support — it remains "the trigger provider with a self-hosted `TRIGGER_API_URL`."

## 4. Non-Functional Requirements

- **Performance**: enqueue latency overhead from the abstraction layer MUST be negligible (< 5 ms p95 vs. direct SDK call). Schedule-dispatch cadence accuracy unchanged.
- **Reliability**: switching providers MUST NOT lose or duplicate runs; idempotency + the CAS schedule claim guarantee at-most-once logical execution per due schedule.
- **Security & privacy**: all runtime credentials are `x-secret`; the internal callback channel stays authenticated; self-host/air-gap modes must not phone home to any SaaS.
- **Observability**: run status continues to flow to `WorkGenerationHistory`; each provider surfaces run logs to its native dashboard (Trigger.dev UI / Temporal Web / BullMQ board / pg-boss table / Inngest dashboard) and to the platform's existing Sentry/PostHog.
- **Compatibility**: default path unchanged; requires `@ever-works/plugin` ≥ the version introducing the `job-runtime` capability; each provider plugin is independently installable.

## 5. Key Entities & Domain Concepts

| Entity / concept | Description |
| --- | --- |
| `job-runtime` capability | New plugin capability category for background-job runtimes. |
| `IJobRuntimeProvider` | Contract a runtime plugin implements: dispatchers + schedule + cancel + status + worker host. |
| Job-runtime provider | A plugin (`trigger`/`temporal`/`bullmq`/`pgboss`/`inngest`) implementing the contract. |
| Active runtime | The single provider selected by `EVER_WORKS_JOB_RUNTIME` for a deployment. |
| Dispatcher | Existing per-job-type interface (`WorkGenerationDispatcher`, …) the active provider fulfils. |
| Worker host | The process/model that executes agent orchestrators for a given runtime (push vs. pull). |
| Conformance suite | Provider-agnostic test all providers must pass to be "supported." |

## 6. Out of Scope

- Running multiple runtimes at once or routing jobs per-work to different runtimes (possible later ADR).
- Live migration of in-flight runs between runtimes (switch is deploy-time).
- Changing what any job does (agent business logic untouched).
- Cache/lock backend selection — that's [ADR-005](../../decisions/005-cache-and-lock-pluggability.md) (composes with this, separate work).
- Self-hosting Inngest (deliberately excluded — SSPL; see [`providers.md`](./providers.md#6-inngest-saas-only--licensing-bounded)).
- A UI for picking the runtime — selection is an operator/env concern, not an end-user setting.

## 7. Acceptance Criteria

- [ ] With no new env, behaviour is identical to the current release (Trigger.dev SaaS), proven by the existing trigger e2e suite passing unchanged.
- [ ] `EVER_WORKS_JOB_RUNTIME=pgboss` runs work generation end-to-end on PostgreSQL only (no Redis, no SaaS) in a compose profile.
- [ ] `EVER_WORKS_JOB_RUNTIME=temporal` runs generation against a `temporal server start-dev` instance in CI.
- [ ] `EVER_WORKS_JOB_RUNTIME=bullmq` runs generation against a Redis service in CI.
- [ ] `EVER_WORKS_JOB_RUNTIME=inngest` dispatches via Inngest (mocked/dev) and is documented SaaS-only.
- [ ] Cancellation aborts an in-flight run and writes `CANCELLED` on every provider.
- [ ] A retried run reuses its `WorkGenerationHistory` row on every provider.
- [ ] The shared conformance suite passes for every provider marked non-experimental.
- [ ] All FRs have a passing test (unit, conformance, or e2e).
- [ ] Constitution Principle IV amended to reference the configured runtime (Trigger.dev default).

## 8. Open Questions

- `[NEEDS CLARIFICATION: Should the pull-model workers (Temporal/BullMQ/pg-boss) call back to the API over the SuperJSON channel like the Trigger.dev worker, or run the agent module fully in-process against the DB? Trade-off: callback = one source of truth + audit hooks (today's invariant); in-process = fewer hops. Default assumption: keep the callback channel for parity.]`
- `[NEEDS CLARIFICATION: For Inngest's per-step limits, does the generation pipeline need explicit step boundaries, or is a single long function acceptable within Inngest limits for our p95 generation duration?]`
- `[NEEDS CLARIFICATION: Do we generalise TRIGGER_INTERNAL_SECRET → EVER_WORKS_INTERNAL_SECRET now (with alias) or defer?]`
- `[NEEDS CLARIFICATION: Which providers ship in the first GA cut vs. stay experimental — proposal: trigger GA; pgboss GA next; temporal/bullmq/inngest experimental first.]`

## 9. Constitution Gates

- [x] **Plugin-first (Principle I)** — every runtime is a plugin under `packages/plugins/job-runtime-*`.
- [x] **Capability-driven resolution (Principle II)** — new `job-runtime` capability; active provider resolved from the registry.
- [x] **Source-of-truth repos preserved (Principle III)** — no change to code/content-in-Git.
- [ ] **Long-running work via Trigger.dev (Principle IV)** — **AMENDMENT REQUIRED**: generalise to "via the configured job-runtime provider (Trigger.dev default)." Must land in the first PR. See [ADR-015](../../decisions/015-job-runtime-provider-pluggability.md) §Constitution note.
- [x] **Forward-only migrations (Principle V)** — pg-boss creates its own schema; no destructive platform-schema change.
- [x] **Tests accompany the change (Principle VI)** — shared conformance suite + per-provider e2e.
- [x] **Secrets per `x-secret` (Principle VII)** — all runtime creds `x-secret`.
- [x] **Plugin counts touch canonical doc only (Principle VIII)** — update the canonical plugin count/category doc when providers land.
- [x] **Behaviour-first (Principle IX)** — this spec describes behaviour; implementation in `plan.md`.
- [x] **Backwards-compatible (Principle X)** — default path unchanged; additive capability + optional plugins.

## 10. References

- ADR: [ADR-015](../../decisions/015-job-runtime-provider-pluggability.md)
- Architecture: [`job-runtime-providers.md`](../../architecture/job-runtime-providers.md), [`trigger-integration.md`](../../architecture/trigger-integration.md), [`trigger-worker.md`](../../architecture/trigger-worker.md), [`plugin-sdk.md`](../../architecture/plugin-sdk.md)
- Provider detail: [`providers.md`](./providers.md)
- Related ADRs: [ADR-005](../../decisions/005-cache-and-lock-pluggability.md), [ADR-002](../../decisions/002-trigger-worker-callback-channel.md)
- Related features: [`scheduled-updates`](../scheduled-updates/spec.md), [`generation-cancellation`](../generation-cancellation/spec.md), [`plugin-system`](../plugin-system/spec.md)
- Jira: [EW-683](https://evertech.atlassian.net/browse/EW-683) (epic), [EW-168](https://evertech.atlassian.net/browse/EW-168)/[EW-169](https://evertech.atlassian.net/browse/EW-169) (prior abstraction), [EW-592](https://evertech.atlassian.net/browse/EW-592) (self-hosted Trigger.dev)
