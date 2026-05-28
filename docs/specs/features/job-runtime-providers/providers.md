# Job-Runtime Providers — capability matrix & per-provider deep dive

**Feature ID**: `job-runtime-providers`
**Status**: `Draft`
**Last updated**: 2026-05-28
**Companion to**: [`spec.md`](./spec.md) · [`plan.md`](./plan.md) · [`tasks.md`](./tasks.md) · [`architecture/job-runtime-providers.md`](../../architecture/job-runtime-providers.md) · [ADR-015](../../decisions/015-job-runtime-provider-pluggability.md)

> This is the **research appendix**: what each runtime is, how it deploys (self-host / remote / SaaS), its licence, its official SDK, its worker-hosting model, and how it maps onto the `IJobRuntimeProvider` contract. Facts current as of 2026-05. Where a fact materially shapes scope (Inngest SSPL, BullMQ Redis-only) it is called out explicitly.

---

## 1. Capability matrix

| Dimension              | **Trigger.dev** (default)                                     | **Temporal**                                    | **BullMQ**                       | **pg-boss**                       | **Inngest**                               |
| ---------------------- | ------------------------------------------------------------- | ----------------------------------------------- | -------------------------------- | --------------------------------- | ----------------------------------------- |
| Primary store          | Trigger.dev cloud / self-host (Postgres+Redis under the hood) | Temporal Service (Cassandra/Postgres/MySQL)     | **Redis only**                   | **PostgreSQL only**               | Inngest cloud                             |
| Self-host?             | ✅ (k8s, heavy)                                               | ✅ (free, MIT)                                  | ✅ (you run Redis)               | ✅ (you run Postgres)             | ⚠️ technically yes, but **SSPL** — see §6 |
| Remote self-managed?   | ✅ (`TRIGGER_API_URL`)                                        | ✅ (any cluster)                                | ✅ (managed Redis)               | ✅ (managed Postgres)             | n/a                                       |
| SaaS / managed?        | ✅ (default today)                                            | ✅ (Temporal Cloud, mTLS)                       | via managed Redis only           | via managed Postgres only         | ✅ (the only supported mode)              |
| Licence (engine)       | Apache-2.0 (self-host components)                             | **MIT**                                         | MIT                              | MIT                               | **SSPL** → Apache-2.0 after 3y delay      |
| Official SDK (TS)      | `@trigger.dev/sdk`                                            | `@temporalio/{client,worker,workflow,activity}` | `bullmq`                         | `pg-boss`                         | `inngest`                                 |
| Worker model           | Tasks deployed to platform; platform runs them                | Long-running worker polls task queue            | Worker process consumes Redis    | In-process/sidecar polls Postgres | Functions served over HTTP; cloud invokes |
| Push or pull           | Push (platform invokes)                                       | Pull (worker polls)                             | Pull (worker polls)              | Pull (worker polls)               | Push (cloud invokes via HTTP)             |
| Native cron            | `schedules.task`                                              | Schedules API                                   | repeatable jobs / `JobScheduler` | `schedule()`                      | cron functions                            |
| Native cancel          | ✅ signal                                                     | ✅ signal                                       | cooperative (flag)               | cooperative (flag)                | `cancelOn` / events                       |
| Durable multi-hour run | ✅ (`maxDuration` 5h)                                         | ✅ (best-in-class)                              | ⚠️ tune lock renewal             | ⚠️ tune visibility timeout        | ⚠️ express as steps                       |
| Idempotency primitive  | `idempotencyKey`                                              | workflow id                                     | job id                           | job id / singleton key            | event idempotency id                      |
| "Just Postgres" deploy | ❌                                                            | ❌ (needs its DB)                               | ❌ (needs Redis)                 | ✅ **reuses platform DB**         | ❌                                        |
| Recommended for        | hosted SaaS (default)                                         | large self-host needing durability              | teams already on Redis           | minimal self-host, OSS distro     | hosted teams wanting Inngest              |

**Two headline corrections to the original request, carried from research:**

1. **"BullMQ with Redis or PostgreSQL if possible"** — BullMQ is **Redis-only**; it is built directly on Redis data structures and has no Postgres backend. The "PostgreSQL if possible" need is met by a **separate** provider, **pg-boss** (Postgres-native), per the decision in ADR-015. We ship both: BullMQ (Redis) and pg-boss (Postgres).
2. **Inngest "not allowed to self-host"** — Inngest _is_ technically self-hostable, but under **SSPL**, which is the real blocker for a commercial multi-tenant SaaS. We scope Inngest to **SaaS only** for that licensing reason (documented in §6), which matches the original intent on firmer grounds.

---

## 2. Trigger.dev (default — re-housed, no behaviour change)

**What it is.** The current runtime. Durable task queue with retries, cancellation, machines, and a run dashboard. The platform's tasks live in `packages/tasks/` (`@ever-works/trigger-tasks`) and deploy via `pnpm deploy:trigger`.

**Deployment modes.**

- **SaaS** (today): `api.trigger.dev`, project `proj_uevrbfmpvojzzazvhffy`.
- **Self-hosted**: Trigger.dev can run on Kubernetes (tracked separately in [EW-592](https://evertech.atlassian.net/browse/EW-592)); selected by pointing `TRIGGER_API_URL` at the self-hosted instance. This is "the trigger provider, self-hosted URL" — **not** a separate provider.

**Licence.** Self-host components Apache-2.0.

**Official SDK.** `@trigger.dev/sdk` (v4.x). Already a workspace dependency.

**Worker model.** _Push_: tasks are deployed to Trigger.dev; the platform runs them on its machines (`micro`…`large-2x`). Cron via `schedules.task`. The worker bootstraps a NestJS app context (`withWorkerContext`) and calls back to the API over the SuperJSON channel.

**Cancellation.** First-class: `runs.cancel(runId)` → `AbortSignal` into the task → orchestrator observes `signal.aborted` at checkpoints.

**Idempotency / concurrency.** `idempotencyKey` + `queue.concurrencyKey`. The pre-created `historyId` provides stable identity across retries.

**Mapping to contract.** `dispatchers` = the existing `TriggerService` methods; `registerSchedules` = the existing `schedules.task` definitions; `cancel` = `runs.cancel`; `startWorkerHost` = no-op (deploy-time). Effectively a re-housing: move `TriggerService` into `packages/plugins/job-runtime-trigger/` behind `IJobRuntimeProvider`.

**Fit.** Stays the default; lowest risk; no migration for any existing deployment.

---

## 3. Temporal (self-host / remote / Temporal Cloud)

**What it is.** A durable-execution engine. Workflows are deterministic, replayable functions; side effects run in Activities. Best-in-class for long, reliable, observable processes — a natural fit for the multi-hour generation pipeline.

**Deployment modes.**

- **Local/dev**: `temporal server start-dev` (Temporal CLI) runs a full service + Web UI (`:8233`) on an in-memory DB; gRPC on `:7233`. Ideal for the plugin's dev mode.
- **Self-hosted (prod)**: run the Temporal Service backed by Cassandra/PostgreSQL/MySQL, on k8s or VMs. **Free, MIT-licensed, no limits.**
- **Remote self-managed**: connect to an existing cluster via `TEMPORAL_ADDRESS`.
- **Temporal Cloud**: managed, connect over **mTLS** (cert/key), namespace-isolated; consumption pricing (~$25/M actions Standard; free Dev tier).

**Licence.** Temporal Server is **MIT** (`temporalio/temporal`). Self-host is free with no limits.

**Official SDK (TS).** `@temporalio/client` (enqueue/signal/cancel), `@temporalio/worker` (host workers), `@temporalio/workflow` (workflow code — sandboxed/deterministic), `@temporalio/activity` (side-effecting work).

**Worker model.** _Pull_: a long-running **Worker** process polls a **task queue** and executes Workflows + Activities. The platform runs ≥1 worker deployment/sidecar. The generation orchestrator becomes a **Workflow**; the actual agent work (AI calls, git, search) becomes **Activities** (activities may call back to the API over the existing SuperJSON channel, or run in-process given the worker hosts the agent module). Cron via the **Schedules** API.

**Cancellation.** First-class workflow cancellation; cancellation scopes propagate to activities → maps to the orchestrator `AbortSignal` checkpoints.

**Idempotency / concurrency.** **Workflow id** is the idempotency key (reuse `work:{workId}:{historyId}` to dedupe); workflow-id uniqueness gives concurrency control per key.

**Mapping to contract.** `dispatchers.*` → `client.workflow.start(..., { workflowId, taskQueue })`; `registerSchedules` → Schedules API; `cancel` → `handle.cancel()`; `startWorkerHost` → boot a `@temporalio/worker` Worker bound to the task queue.

**Gotchas.** Workflow code must be deterministic (no direct I/O — that's what Activities are for); the generation pipeline's I/O must sit in Activities. The biggest implementation lift of the five.

**Fit.** The recommended option for large self-hosters needing durability and deep observability.

---

## 4. BullMQ (Redis-backed)

**What it is.** A fast, robust Node.js queue built on Redis. Already a transitive dependency of `@ever-works/agent` (used today by the `agent-pipeline` plugin's internal worker pool — a _narrow_ use; this provider is a broader, platform-wide use).

**Deployment modes.** Needs a **Redis** (local, self-hosted, or managed — ElastiCache / Upstash / Redis Cloud). **No SaaS** of its own; "managed" means managed Redis.

**Licence.** MIT.

**Official SDK.** `bullmq` (v5.x). `Queue` (producer), `Worker` (consumer), `JobScheduler`/repeatable jobs (cron), `QueueEvents` (status), flows (parent/child).

**Worker model.** _Pull_: a `Worker` consumes jobs from Redis; run N replicas for throughput. Workers can run in-process in a dedicated worker app or as a sidecar. Cron via repeatable jobs.

**Cancellation.** No native cancel of a _running_ job. Implement **cooperative cancellation**: a Redis flag (or the existing DB cancellation flag) the orchestrator polls at each `throwIfGenerationCancelled` checkpoint. Pending (not-yet-started) jobs can be removed directly.

**Idempotency / concurrency.** Custom **job id** = idempotency key (duplicate id is ignored). Concurrency via worker `concurrency`, named groups, and rate limits; `concurrencyKey` maps to grouped queues / job-id namespacing.

**`maxDuration`.** No hard cap, but multi-hour jobs need **lock renewal** (`lockDuration` + `lockRenewTime`) tuned so the job isn't considered stalled. Documented in the deploy guide.

**Mapping to contract.** `dispatchers.*` → `queue.add(name, payload, { jobId, ... })`; `registerSchedules` → `queue.add` repeatable / `JobScheduler`; `cancel` → set cancel flag (+ remove if pending); `getRunStatus` → `Job.getState()`; `startWorkerHost` → boot `Worker`s.

**Fit.** Teams already running Redis; high-throughput, low-ceremony.

---

## 5. pg-boss (PostgreSQL-native) — the "just Postgres" answer

**What it is.** A queue built **entirely on PostgreSQL** (SKIP LOCKED), no extra infrastructure. This is the provider that satisfies the "runs on PostgreSQL" half of the original BullMQ request — because BullMQ itself cannot use Postgres.

**Deployment modes.** Needs only **PostgreSQL** — and can **reuse the platform's existing `DATABASE_URL`** (its own `pgboss` schema). A complete Ever Works deployment can then run on a single Postgres instance with **no Redis and no SaaS**, composing with ADR-005's Postgres cache/lock backends.

**Licence.** MIT.

**Official SDK.** `pg-boss` (v10.x). `boss.send(name, data, options)` (enqueue), `boss.work(name, handler)` (consume), `boss.schedule(name, cron, data)` (cron), singleton/throttle options.

**Worker model.** _Pull_: a pg-boss instance polls Postgres and dispatches to handlers; run in-process in a worker app or sidecar. Cron via `schedule()`.

**Cancellation.** Cooperative, same pattern as BullMQ (cancel flag polled at orchestrator checkpoints); `cancel(jobId)` removes pending jobs.

**Idempotency / concurrency.** Singleton keys + custom job id; `singletonKey`/`singletonSeconds` map `concurrencyKey`. Idempotency via deterministic job id.

**`maxDuration`.** Governed by `expireInHours` / visibility; tune for multi-hour jobs (set generous expiry + heartbeat-style re-fetch). Documented.

**Mapping to contract.** `dispatchers.*` → `boss.send(name, payload, { id, singletonKey })`; `registerSchedules` → `boss.schedule`; `cancel` → cancel flag + `boss.cancel(id)`; `getRunStatus` → `boss.getJobById`; `startWorkerHost` → `boss.start()` + register `boss.work(...)` handlers.

**Fit.** The default recommendation for minimal self-hosters and the OSS distribution — zero external dependencies beyond the database we already require.

---

## 6. Inngest (SaaS only — licensing-bounded)

**What it is.** Event-driven durable functions / step functions, strong for AI workflows and fan-out. Functions are defined in code and **served over HTTP**; Inngest invokes them.

**Why SaaS only.** Inngest's server + CLI are released under the **SSPL** (Server Side Public License), converting to Apache-2.0 only after a **3-year delay** (fair-source/DOSP model). SSPL's "offering the software as a service" clause makes **self-hosting Inngest inside a commercial multi-tenant SaaS legally fraught** — the same reason MongoDB's SSPL deters embedding in SaaS. Technically Inngest _can_ be self-hosted (single binary, dev server, air-gapped), but for Ever Works' hosted/commercial posture we deliberately scope Inngest to **Inngest Cloud only** and record the reason here. This matches the original "SaaS only" intent on a firmer (legal, not technical) basis. Self-hosting Inngest is therefore **explicitly out of scope** for this provider; operators who want a self-owned runtime use Temporal, BullMQ, or pg-boss.

**Deployment mode.** **Inngest Cloud** only. The platform serves functions at an HTTP endpoint (`serve()` handler, mounted in the API or a small service); Inngest Cloud calls that endpoint to run steps.

**Official SDK.** `inngest` (TS). `Inngest` client (send events), `createFunction` (define), `serve` (HTTP handler), steps (`step.run`, `step.sleep`, `step.waitForEvent`), `cancelOn`.

**Worker model.** _Push_: no long-running worker we operate; Inngest Cloud invokes our HTTP functions. Cron via cron functions. **The signing-key-authenticated webhook is the trust boundary** — analogous to (and reusing the posture of) the `x-trigger-secret` internal channel.

**Cancellation.** Via `cancelOn` events / the cancel API; map `cancel(runId)` to sending the cancel event or calling the REST cancel.

**Idempotency / concurrency.** Event **idempotency id** + function concurrency keys; map directly.

**`maxDuration`.** Long pipelines must be expressed as **multiple steps** (per-step limits apply) — the orchestrator may need step-boundary checkpoints when run under Inngest. Documented as an Inngest-specific constraint.

**Mapping to contract.** `dispatchers.*` → `inngest.send({ name, data, id })`; `registerSchedules` → cron functions; `cancel` → cancel event/REST; `startWorkerHost` → mount the `serve()` HTTP handler (no polling worker).

**Fit.** Hosted teams that specifically want Inngest's event/step model; opt-in, SaaS-bound.

---

## 7. Cross-provider notes

- **Official SDKs only.** Per the platform's official-SDK convention (root `CLAUDE.md` "Key Dependencies"; Workspace AGENTS.md NN #22), every provider uses the vendor's official SDK — never a hand-rolled REST client. Each SDK is a runtime dep of its own plugin package; `@ever-works/plugin` stays a peer dep.
- **The SuperJSON callback channel is provider-neutral.** Pull-model workers (Temporal/BullMQ/pg-boss) call back to `/internal/*` exactly like the Trigger.dev worker; push-model providers (Trigger.dev/Inngest) run our code that does the same. The internal secret may be generalised to `EVER_WORKS_INTERNAL_SECRET` with `TRIGGER_INTERNAL_SECRET` kept as an alias.
- **Secret hygiene.** All credentials (`TRIGGER_SECRET_KEY`, `TEMPORAL_TLS_KEY`, `BULLMQ_REDIS_URL` auth, `PGBOSS_DATABASE_URL`, `INNGEST_SIGNING_KEY`) are `x-secret: true` settings, resolved through the standard plugin settings hierarchy and never returned in API responses.
- **Conformance parity.** No provider is "supported" until green on the shared conformance suite (`architecture/job-runtime-providers.md` §7). Non-default providers ship `experimental` until then.

## 8. Sources

- Trigger.dev: <https://trigger.dev/docs>
- Temporal (MIT, self-host, CLI dev server, Cloud/mTLS): <https://docs.temporal.io/self-hosted-guide>, <https://docs.temporal.io/develop/typescript>, <https://github.com/temporalio/temporal/blob/main/LICENSE>
- BullMQ (Redis-only): <https://docs.bullmq.io/>, <https://github.com/taskforcesh/bullmq>
- pg-boss (Postgres-native): <https://github.com/timgit/pg-boss>
- Inngest (self-hosting + SSPL/DOSP): <https://www.inngest.com/docs/self-hosting>, <https://github.com/inngest/inngest>
