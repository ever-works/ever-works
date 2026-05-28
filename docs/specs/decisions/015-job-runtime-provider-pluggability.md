# ADR-015: Job-Runtime Provider Pluggability — Keep Trigger.dev default, make the background-job runtime a swappable provider (Temporal / BullMQ / pg-boss / Inngest)

## Status

**Proposed** — Tracking implementation in [EW-683](https://evertech.atlassian.net/browse/EW-683). This ADR is forward-looking; **nothing changes today**. Trigger.dev (SaaS) stays the default background-job runtime and remains fully supported. No deployment is forced to change anything.

## Date

- 2026-05-28 — Initial.

## Context

Every long-running operation on the platform — work generation, work import, onboarding, scheduled dispatch, KB embedding, webhook delivery, agent heartbeats, the deploy-ready poller, mission ticks — runs on **Trigger.dev**, today exclusively against the Trigger.dev **SaaS cloud** (`api.trigger.dev`, project `proj_uevrbfmpvojzzazvhffy`). See [`architecture/trigger-integration.md`](../architecture/trigger-integration.md) and [`architecture/trigger-worker.md`](../architecture/trigger-worker.md).

The integration is already cleanly layered (this is the key enabling fact for this ADR):

- The **agent package owns dispatcher interfaces** — `WorkGenerationDispatcher`, `WorkImportDispatcher`, `TemplateCustomizationDispatcher`, `WebhookDeliveryDispatcher`, the four KB dispatchers, the agent dispatchers — each a small interface + a DI `Symbol` (`packages/agent/src/tasks/*.dispatcher.ts`). The API depends only on these symbols and **never imports `@trigger.dev/sdk` directly**.
- The **tasks package implements them** — `TriggerService` (`packages/tasks/src/trigger/trigger.service.ts`) implements all dispatcher interfaces, lazy-configures `@trigger.dev/sdk`, and returns `null` when Trigger.dev is disabled so the API can fall back to in-process execution.
- Business logic lives in `@ever-works/agent`, orthogonal to the runtime. Tasks are thin orchestration; the worker calls back to the API over a narrow SuperJSON RPC channel (`/internal/trigger/*`). The runtime only owns **enqueue, schedule, retry, cancel, run status, and worker hosting** — not the work itself.

This was built deliberately as a "Background Job Manager Abstraction Layer" ([EW-169](https://evertech.atlassian.net/browse/EW-169), Done, under [EW-168](https://evertech.atlassian.net/browse/EW-168) "Conditional Trigger.dev Support"). The dispatcher seam is exactly the right place to make the runtime swappable.

**Why make the runtime pluggable now?** Ever Works is an **open-source, self-hostable** product as much as a hosted SaaS ("runs on your machine, your cloud, or ours"). The single hard dependency on Trigger.dev SaaS is the one piece of the long-running-work story that a self-hoster cannot fully own:

1. **Self-hosting / data residency / air-gap.** Operators running the OSS distribution in their own cloud (or fully offline) want a runtime they control end-to-end, without sending payloads to a third-party SaaS. Trigger.dev *can* be self-hosted on Kubernetes ([EW-592](https://evertech.atlassian.net/browse/EW-592)), but it is operationally heavy, and some operators would rather use a runtime they already run.
2. **Reuse existing infrastructure investments.** Operators who already run **Temporal**, a **Redis + BullMQ** tier, or just **PostgreSQL** want to point Ever Works at what they have rather than stand up Trigger.dev.
3. **"Just PostgreSQL" deployments.** Mirroring [ADR-005](./005-cache-and-lock-pluggability.md) (cache/lock pluggability), a small self-hoster should be able to run the whole platform on a single PostgreSQL instance with **no Redis and no external SaaS** — which means a Postgres-native queue option (pg-boss) for background jobs.
4. **Durability / workflow semantics at scale.** Larger deployments may want Temporal's durable-execution and long-history guarantees for the multi-hour generation pipeline.
5. **Avoid lock-in as a product principle.** "You own everything, nothing is locked in" is a load-bearing brand claim. Locking the runtime to one SaaS undercuts it.

The question is not "Trigger.dev vs X" — it is whether we **lock the runtime to one option** or make it a **selectable provider** so each deployment chooses, exactly as we decided for cache/lock in ADR-005.

## Decision

The background-job runtime becomes a **pluggable provider** selected at deployment time, expressed through the platform's existing **plugin system** (a new `job-runtime` capability) and selected by environment, **defaulting to Trigger.dev**. Concretely:

1. **Introduce a `job-runtime` capability + `IJobRuntimeProvider` contract** in `packages/plugin/`. A job-runtime provider supplies: enqueue (one provider object implementing all agent dispatcher interfaces), scheduling (cron/recurring), cancellation, run-status reporting back to the API, and a worker-hosting model. See [`architecture/job-runtime-providers.md`](../architecture/job-runtime-providers.md) for the full contract.

2. **Refactor the current Trigger.dev integration into the first provider** — `@ever-works/plugin-job-runtime-trigger` — by moving `TriggerService` behind `IJobRuntimeProvider`. **No behaviour change** for existing deployments; this is a pure re-housing of working code.

3. **Add four sibling providers**, each enable/disable-able and configurable through the standard plugin settings system (`x-secret`, `x-envVar`, JSON-Schema), and each documenting its self-host vs SaaS story:
   - **Temporal** (`@ever-works/plugin-job-runtime-temporal`) — self-hosted (the platform stands up / connects to a Temporal Service) **or** remote self-managed cluster **or** Temporal Cloud (mTLS). Server is MIT-licensed and free to self-host.
   - **BullMQ** (`@ever-works/plugin-job-runtime-bullmq`) — Redis-backed queue. Connects to a local, remote, or managed Redis (ElastiCache / Upstash / Redis Cloud). BullMQ is **Redis-only** by design.
   - **pg-boss** (`@ever-works/plugin-job-runtime-pgboss`) — **PostgreSQL-native** queue. Reuses the platform's existing PostgreSQL with no Redis and no SaaS. This is the "just Postgres" answer to the "BullMQ with Redis *or* PostgreSQL" requirement (BullMQ cannot use Postgres; pg-boss is the Postgres path).
   - **Inngest** (`@ever-works/plugin-job-runtime-inngest`) — **SaaS only** (Inngest Cloud). Inngest *is* technically self-hostable, but its server + CLI ship under the **SSPL** (converting to Apache-2.0 only after a 3-year delay), which is legally incompatible with offering it inside a commercial multi-tenant SaaS. We therefore scope Inngest to its managed cloud and document the licensing rationale rather than the technical one. See [`features/job-runtime-providers/providers.md`](../features/job-runtime-providers/providers.md#inngest).

4. **Selection is instance-global, env-driven, with exactly one active runtime per deployment** — a new `EVER_WORKS_JOB_RUNTIME={trigger,temporal,bullmq,pgboss,inngest}` (default `trigger`), mirroring ADR-005's `EVER_WORKS_CACHE_BACKEND` / `EVER_WORKS_LOCK_BACKEND`. Unlike AI/search/deployment plugins (which resolve per-user/per-work), the job runtime is **deployment infrastructure**: one active provider, chosen by the operator, scoped global/admin — like the cache and lock backends, and like the `k8s` deployment plugin's admin-only config.

5. **All providers pass one shared conformance suite.** A provider-agnostic contract test (enqueue → run → status → cancel → schedule → retry/idempotency) runs against every provider; a provider is not "done" until it passes identically. Mirrors ADR-005's shared `LockProvider` contract suite.

### What does NOT change

- **Trigger.dev (SaaS) remains the default and is fully supported.** Existing dev/stage/prod deployments need **zero** config change — absent `EVER_WORKS_JOB_RUNTIME`, the platform behaves exactly as today.
- The dispatcher interfaces (`packages/agent/src/tasks/*.dispatcher.ts`), the SuperJSON internal callback channel, the pre-created `historyId` contract, the in-process dev fallback, and the agent business logic all stay as-is. They become **provider-neutral** rather than Trigger.dev-specific.
- Self-hosted **Trigger.dev** on Kubernetes ([EW-592](https://evertech.atlassian.net/browse/EW-592)) remains a valid path — it is just "the Trigger.dev provider pointed at a self-hosted `TRIGGER_API_URL`," now one option among several.

### Out of scope for this ADR

- Running **multiple** job runtimes simultaneously / per-work runtime routing. v1 is one active runtime per deployment. A later ADR can add routing if a real need appears.
- Replacing cache/lock backends — that is [ADR-005](./005-cache-and-lock-pluggability.md)'s concern. (The two compose: a "just Postgres" deployment = pg-boss runtime + TypeORM cache + Postgres lock.)
- Migrating *in-flight* runs between providers. Switching runtime is a deploy-time decision; in-flight runs drain on the old runtime or are re-enqueued.
- Changing what the tasks *do*. Business logic in `@ever-works/agent` is untouched.

### Constitution note

[Constitution](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md) **Principle IV** currently reads "Long-running work via Trigger.dev." This ADR generalises it to "Long-running work via the **configured job-runtime provider** (Trigger.dev default)." That is a constitution amendment and must land as part of this initiative's first PR (Principle IV text + this ADR cross-link). Flagged here so the gate check in the feature spec (`spec.md` §9 / `plan.md` §12) is honest rather than silently in conflict.

## Consequences

**Positive**

- Self-hosters and air-gapped operators get a runtime they fully own (Temporal self-host, BullMQ-on-own-Redis, or pure pg-boss-on-Postgres) — strengthens the "you own everything, nothing locked in" promise.
- "Just PostgreSQL" deployments become possible end-to-end (pg-boss runtime + ADR-005 Postgres cache/lock = zero external dependencies).
- The hosted SaaS keeps Trigger.dev with no disruption; large operators can opt into Temporal for durable-execution semantics.
- The dispatcher seam gets a real second (third, fourth, fifth) implementation, which validates and hardens the abstraction that EW-169 introduced.

**Negative**

- Five runtime providers to keep at feature parity in the conformance suite, docs, and CI. Mitigated by: (a) the shared contract test, (b) staging providers behind "experimental" flags until they pass, (c) only Trigger.dev being a supported-default — others are opt-in and best-effort until proven.
- Each provider has a genuinely different **worker-hosting** model (Trigger.dev deploys tasks to its cloud; Temporal runs polling workers; BullMQ/pg-boss run in-process or sidecar workers; Inngest serves functions over HTTP that Inngest invokes). This is the hard part and is the bulk of the implementation effort — see [`architecture/job-runtime-providers.md`](../architecture/job-runtime-providers.md) §"Worker-hosting models."
- Operators choosing a non-default runtime pick up its operational concerns (Redis persistence/eviction, Temporal cluster ops, etc.) — their explicit choice.

**Neutral**

- No new dependency on the default path. Each non-Trigger provider's SDK is isolated in its own optional plugin package (`peerDependencies` for `@ever-works/plugin`, runtime deps for the vendor SDK), installed only when that provider is enabled. Per workstation Non-Negotiable #22 and CLAUDE.md, each provider uses the **official vendor SDK** (`@trigger.dev/sdk`, `@temporalio/*`, `bullmq`, `pg-boss`, `inngest`) — never a hand-rolled client.

## Implementation outline

Tracked in [EW-683](https://evertech.atlassian.net/browse/EW-683). Full detail in the feature spec set under [`features/job-runtime-providers/`](../features/job-runtime-providers/spec.md). High-level shape:

1. Define the `job-runtime` capability + `IJobRuntimeProvider` contract in `packages/plugin/src/job-runtime/`.
2. Generalise the dispatcher wiring so the active provider is bound to all `*_DISPATCHER` symbols via a factory that reads `EVER_WORKS_JOB_RUNTIME`.
3. Re-house the current Trigger.dev integration as the `trigger` provider (no behaviour change) and prove the conformance suite green against it.
4. Build the provider conformance test harness (`packages/plugin/src/job-runtime/testing/`).
5. Implement Temporal, BullMQ, pg-boss, Inngest providers behind experimental flags, each green on the conformance suite.
6. Worker-hosting: define how each provider hosts the worker that runs `@ever-works/agent` orchestrators (Docker/compose + k8s manifests + `pnpm` scripts per provider).
7. Docs: provider matrix, per-provider deploy guides, `EVER_WORKS_JOB_RUNTIME` env, and amend Principle IV in the constitution.

## References

- [EW-683 — Job-runtime provider pluggability (epic)](https://evertech.atlassian.net/browse/EW-683)
- [`architecture/job-runtime-providers.md`](../architecture/job-runtime-providers.md) — the provider contract + worker-hosting models.
- [`features/job-runtime-providers/spec.md`](../features/job-runtime-providers/spec.md) · [`plan.md`](../features/job-runtime-providers/plan.md) · [`tasks.md`](../features/job-runtime-providers/tasks.md) · [`providers.md`](../features/job-runtime-providers/providers.md)
- [ADR-005 — Cache and Lock Pluggability](./005-cache-and-lock-pluggability.md) — the sibling pattern this ADR mirrors (env-selected, Postgres-default, additive).
- [ADR-002 — Trigger worker callback channel](./002-trigger-worker-callback-channel.md) — the SuperJSON RPC seam that every provider must preserve.
- [`architecture/trigger-integration.md`](../architecture/trigger-integration.md) · [`architecture/trigger-worker.md`](../architecture/trigger-worker.md) — current integration this ADR generalises.
- [EW-168](https://evertech.atlassian.net/browse/EW-168) / [EW-169](https://evertech.atlassian.net/browse/EW-169) — original conditional-Trigger.dev + background-job abstraction layer (Done) this builds on.
- [EW-592](https://evertech.atlassian.net/browse/EW-592) — self-hosted Trigger.dev on Kubernetes (subsumed as "the trigger provider, self-hosted URL").
- [EW-475](https://evertech.atlassian.net/browse/EW-475) — Ever Works Plugin System (the host for the new capability).
