# EW-742 tenant job-runtime overlay — remaining blockers + scope

**Status as of 2026-06-19**: most of the platform-side overlay is on `main`.
What's left splits cleanly into three buckets — _blocked on missing plugin
packages_, _blocked on design decisions_, and _in-flight or large-mechanical_.

This doc captures the open work as Jira-ready ticket sketches so the
remaining items don't get lost between sessions.

---

## What's on `main` (snapshot)

| Phase                  | Story  | PR chain (last hop)                                                |
| ---------------------- | ------ | ------------------------------------------------------------------ |
| P0 spec-kit            | EW-743 | [#1332](https://github.com/ever-works/ever-works/pull/1332) → main |
| P1.0 x-scope tenant    | EW-744 | [#1335](https://github.com/ever-works/ever-works/pull/1335) → main |
| P1 data model          | EW-745 | [#1338](https://github.com/ever-works/ever-works/pull/1338) → main |
| P2.0 admin REST API    | EW-746 | [#1341](https://github.com/ever-works/ever-works/pull/1341) → main |
| P2.1 admin UI          | EW-746 | [#1347](https://github.com/ever-works/ever-works/pull/1347) → main |
| P3 resolver            | EW-747 | [#1380](https://github.com/ever-works/ever-works/pull/1380) → main |
| P3.1 cache             | —      | [#1381](https://github.com/ever-works/ever-works/pull/1381) → main |
| P3.1 stamper helper    | —      | [#1390](https://github.com/ever-works/ever-works/pull/1390) → main |
| P3.2 resolver bind     | —      | [#1397](https://github.com/ever-works/ever-works/pull/1397) → main |
| P3.2 Vault resolver    | —      | [#1400](https://github.com/ever-works/ever-works/pull/1400) → main |
| P3.2 K8s resolver      | —      | [#1401](https://github.com/ever-works/ever-works/pull/1401) → main |
| P4 T31 contract        | EW-748 | [#1394](https://github.com/ever-works/ever-works/pull/1394) → main |
| P5 operator gating     | EW-749 | [#1350](https://github.com/ever-works/ever-works/pull/1350) → main |
| P7 runbooks T41/T42    | EW-751 | [#1352](https://github.com/ever-works/ever-works/pull/1352) → main |
| P7 migration guide T44 | —      | [#1391](https://github.com/ever-works/ever-works/pull/1391) → main |
| EW-686 P1 trigger      | EW-686 | [#1372](https://github.com/ever-works/ever-works/pull/1372) → main |
| EW-686 P2 bindToTenant | EW-686 | [#1387](https://github.com/ever-works/ever-works/pull/1387) → main |

---

## Bucket 1 — Blocked on missing plugin packages

The platform contract on main supports five providers (`trigger | temporal |
bullmq | pgboss | inngest`) but only the Trigger.dev binding (carved out as
`TriggerJobRuntimeProvider` via EW-686 P1) currently exists as a working
implementation. Items below need their respective plugin packages under
`packages/plugins/job-runtime-*` to exist before the actual work can happen.

### T26 — Inngest per-tenant webhook routing

**What**: validate Inngest signing key per tenant; dispatch incoming webhook
events to the tenant whose run id matches.

**Blocked**: no `packages/plugins/job-runtime-inngest/` package exists.

**Unblocker**: EW-686 P3+ — carve out an Inngest plugin package mirroring the
Trigger.dev carve-out. Once that lands, T26 becomes a self-contained file at
`packages/plugins/job-runtime-inngest/src/tenant-webhook.handler.ts`.

**Acceptance criteria**:

- Webhook handler verifies the Inngest signature against the tenant's BYO
  signing key (resolved via `SecretStoreResolver` + tenant overlay row).
- Cross-tenant webhook misrouting (tenant A's run id, tenant B's signing key)
  is rejected with `401` and audit-logged.
- Doc cross-link to [`providers.md`](../specs/features/tenant-job-runtime-overlay/providers.md)
  noting Inngest is SaaS-only (no self-host worker host).

**Estimated size**: ~250 LoC + tests. Single PR.

### T27 — Temporal per-tenant namespace polling

**What**: spin up one worker per `(tenantId, namespace)` bound to the tenant's
Temporal task queue (ADR-017 Q1 — namespace-per-tenant).

**Blocked**: no `packages/plugins/job-runtime-temporal/` package exists.

**Unblocker**: EW-686 P3+. After the Temporal package exists, T27 lives at
`packages/plugins/job-runtime-temporal/src/tenant-worker-host.ts`.

**Acceptance criteria**:

- One `Worker` instance per tenant overlay row in `byo` / `override` mode.
- Workers shut down cleanly when the tenant deletes / disables their overlay.
- mTLS cert loaded per tenant from `SecretStoreResolver`.
- Conformance test (T32 below) proves zero cross-tenant workflow execution.

**Estimated size**: ~400 LoC + tests. Single PR.

### T28 — BullMQ per-tenant queue polling

**What**: one worker per `(tenantId, queueName)` with the BullMQ `prefix` set
to the tenant id; reuses `lockDuration` / `lockRenewTime` from EW-683's host
config.

**Blocked**: no `packages/plugins/job-runtime-bullmq/` package exists.

**Unblocker**: EW-686 P3+.

**Acceptance criteria**:

- Per-tenant Redis prefix isolates queues at the Redis namespace level.
- Worker count per tenant honours the `EVER_WORKS_JOB_RUNTIME_HOSTING` knob
  (Q5 — `per-tenant` / `shared` / `tiered`).
- Connection string resolved per tenant via `SecretStoreResolver`.

**Estimated size**: ~300 LoC + tests. Single PR.

### T29 — pg-boss per-tenant schema polling

**What**: one `boss` instance per `(tenantId, schema)` (ADR-017 Q2 —
schema-per-tenant), reusing the platform `DATABASE_URL` by default.

**Blocked**: no `packages/plugins/job-runtime-pgboss/` package exists.

**Unblocker**: EW-686 P3+.

**Acceptance criteria**:

- Per-tenant schema is created on first overlay save if absent (idempotent).
- Workers shut down + schema is left in place on overlay disable (operator
  decides when to drop).
- Connection string is per-tenant (BYO `DATABASE_URL`) or platform default,
  picked by `mode = 'override'` vs `mode = 'byo'`.

**Estimated size**: ~350 LoC + tests. Single PR.

### T32 — per-provider isolation tests

**What**: two-tenant isolation scenarios per provider in
`packages/plugins/job-runtime-*/src/__tests__/tenant-isolation.spec.ts`.

**Blocked**: needs T26–T29 to have something to test.

**Acceptance criteria**:

- Tenant A on `pgboss` and tenant B on `temporal` run concurrent enqueues
  with zero cross-talk in run records, webhooks, worker logs.
- Force-invalidate on tenant A's snapshot doesn't drop tenant B's in-flight
  runs.
- Rotation on tenant A bumps `credentialVersion`; in-flight runs keep their
  pinned snapshot.

**Estimated size**: ~500 LoC. Single PR (or one per provider, your call).

### T43 — per-provider plugin READMEs

**What**: add a "Tenant overlay" section to each provider plugin README
documenting the tenant-isolation knob, credential shape, and migration path
from instance-default → BYO.

**Blocked**: no provider plugin packages exist yet (one README per missing
package).

**Estimated size**: ~50 LoC each × 4 (trigger/temporal/bullmq/pgboss already
exists for trigger, others need carve-out first).

---

## Bucket 2 — Blocked on design decisions

### Trigger.dev per-tenant project routing

**What**: today the platform uses ONE Trigger.dev project for all tenants;
per-tenant BYO routes through `metadata.tenantId` stamping but credentials
are still the platform-level ones. Per-tenant project routing would let each
tenant point at their own Trigger.dev project (different access token,
different `triggerRunId` namespace).

**Why blocked**: requires a multi-client SDK refactor of `TriggerService`.
The Trigger.dev SDK initialises against `TRIGGER_SECRET_KEY` from env, so
swapping per call means either (a) per-tenant SDK client instances cached in
the wrapper provider, or (b) request-scoped env var swap (race-condition
nightmare in concurrent code).

**Options**:

| Option                                                                  | Pros                                                                                 | Cons                                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| **(a) Keep single project + `metadata.tenantId`**                       | Zero refactor; works today; tenants share the platform's Trigger.dev project credit. | No real per-tenant credential isolation; one bad tenant token = one bad Trigger.dev project. |
| **(b) Per-tenant SDK client cached by `(tenantId, credentialVersion)`** | True isolation; tenant pays for own Trigger.dev project.                             | Multi-client refactor of `TriggerService`; needs SDK clear-cache hooks on rotation.          |
| **(c) Hybrid — operator-gated**                                         | Best of both; operator picks.                                                        | Most code.                                                                                   |

**Recommendation**: **(a) for now** (matches what `bindToTenant` returns
today — a wrapper that stamps metadata only). File **(b)** as a separate
ticket once a real tenant asks for it.

**Who needs to weigh in**: product / user — tenant pricing model decides
whether (b) is worth the engineering cost.

### T31 — per-provider stamping interface ripple

**What**: actually adopt `JobEnqueueOptions.tenantId` (contract on main) into
every dispatcher's call site so the platform stamps the carrier on enqueue.

**Why blocked**: adding `JobEnqueueOptions` as a second param to each of the
12 dispatcher interfaces ripples to every caller AND every implementation.
That's a coordinated bus-stop PR — exactly the thing we deliberately avoided
with the helper-based T22 + stamper pattern.

**Options**:

| Option                                                                             | Pros                                                      | Cons                                                    |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| **(a) Add `opts?: JobEnqueueOptions` as optional second param to each dispatcher** | Backwards-compatible — existing callers don't change.     | 12 interfaces × N callers; signature change still wide. |
| **(b) Envelope: `dispatch({ payload, opts })` everywhere**                         | Forward-extensible.                                       | Even wider breaking change.                             |
| **(c) Per-call helper that wraps `tasks.trigger(...)`**                            | No interface change; each provider implements internally. | Spreads the convention across providers.                |

**Recommendation**: **(a)** with `?` so it's additive. Adopt one dispatcher
at a time (KB-embed first as proof) to avoid the bus stop.

**Who needs to weigh in**: nobody — the call is yours / mine. Just hasn't
been picked yet.

### P6 conformance suite design

**What**: parametric per-tenant conformance harness (`(providerId, tenantA,
tenantB)`) layered on top of EW-683's contract suite.

**Why blocked**: needs P3 (done) + P4 (T25–T30 — most still blocked on
plugin packages). Also needs design clarity on what conformance means for
push-model (webhook) vs pull-model (worker host) providers — they
fundamentally test different things.

**Acceptance criteria for the design phase**:

- Single test-runner shape that works for both push and pull providers.
- Clear distinction between "platform contract" tests (must pass for every
  provider) and "provider-specific" tests (e.g. Temporal namespace
  semantics).
- CI matrix design (`(providerId × tenant-on/off)` axis is already in the
  task spec; this confirms whether one matrix step per pair or grouped).

**Estimated size**: design 1-2 days, harness ~300 LoC + per-provider
integration ~200 LoC each.

---

## Bucket 3 — In-flight / parallel sessions / large-mechanical

### P5.1 — per-tenant whitelist (EW-752)

**What**: per-tenant overlay on top of the operator allow-list, gated by
`EVER_WORKS_TENANT_RUNTIME_PER_TENANT_GATING` flag. `instance_plugin_allowlist`
table keyed by `(tenantId, providerId)`; resolver merges global ∩ tenant-specific.

**Status**: a parallel session is in-flight on `session/1516-ew752-p5-1-per-tenant-whitelist`
with ~12 uncommitted files. **Don't touch** from this session.

### T22 per-dispatcher wiring (12 PRs)

**What**: incremental adoption of `RuntimeBindingStamperService.stamp(tenantId)`
at each of the 12 dispatcher call sites in `_tasks-symbols.ts`. Each enqueue
captures `(providerId, credentialVersion)` onto the run record so the worker
host (P4) can resolve THAT snapshot at run-time.

**Why not done yet**: needs the per-dispatcher decision on where to persist
the captured tuple — most dispatchers don't have a per-run history row to
extend; each needs a small schema decision.

**Acceptance criteria (per dispatcher)**:

- `await stamper.stamp(tenantId)` called before the dispatch.
- Result persisted (either to a new `tenant_job_run_capture` table or to an
  existing dispatcher-specific history row that gets two new columns).
- Worker host resolves the snapshot via
  `CredentialVersionService.resolveSnapshot` keyed by the captured tuple.

**Estimated size**: ~12 PRs, each ~100–200 LoC. Largest single in-flight
shippable batch on EW-742.

### Additional `SecretStoreResolver` schemes

**What**: implementations for additional secret-store schemes on top of
the `SecretStoreResolver` contract.

**Status on `main` today**:

| Scheme       | Class                          | Where it ships                                     |
| ------------ | ------------------------------ | -------------------------------------------------- |
| `inline:`    | `InProcessSecretStoreResolver` | Default (no DI override needed)                    |
| `env:`       | `InProcessSecretStoreResolver` | Default (no DI override needed)                    |
| `vault:`     | `VaultSecretStoreResolver`     | Opt-in via `SECRET_STORE_RESOLVER` binding (#1400) |
| `k8s:`       | `K8sSecretStoreResolver`       | Opt-in via `SECRET_STORE_RESOLVER` binding (#1401) |
| `infisical:` | (planned)                      | Opt-in; OSS-friendly secrets platform              |
| `doppler:`   | (planned)                      | Opt-in; freemium                                   |
| `aws-sm:`    | (planned)                      | Opt-in; AWS deployers                              |
| `gcp-sm:`    | (planned)                      | Opt-in; GCP deployers                              |
| `azure-kv:`  | (planned)                      | Opt-in; Azure deployers                            |

**Deliberately not on the roadmap**: 1Password (`op://`). Closed-source
vendor SDK + commercial licence makes it a poor fit for an OSS project;
operators who need it can ship a private `OnePasswordSecretStoreResolver`
in their own DI module without us bundling it.

**Acceptance criteria (per resolver)**:

- Implements `SecretStoreResolver.resolve` for the chosen scheme.
- Fail-open per contract (null + `Logger.warn` on every failure path).
- Opt-in via DI binding override; not registered in the default module
  (the `inline:` + `env:` defaults stay zero-dep).
- Test suite covers every failure branch + happy path.

**Estimated size**: ~200–400 LoC each, single PR per scheme.

---

## Cross-references

- Epic: [EW-742](https://evertech.atlassian.net/browse/EW-742)
- ADR: [ADR-017](../specs/decisions/017-tenant-scoped-job-runtime-overlay.md)
- Spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../specs/features/tenant-job-runtime-overlay/spec.md)
- Plan: [`docs/specs/features/tenant-job-runtime-overlay/plan.md`](../specs/features/tenant-job-runtime-overlay/plan.md)
- Tasks: [`docs/specs/features/tenant-job-runtime-overlay/tasks.md`](../specs/features/tenant-job-runtime-overlay/tasks.md)
- Sibling EW-683 (instance-level pluggability): [`docs/specs/features/job-runtime-providers/`](../specs/features/job-runtime-providers/)
- Tenant runbook: [`docs/runbooks/TENANT_JOB_RUNTIME.md`](../runbooks/TENANT_JOB_RUNTIME.md)
- Tenant migration guide: [`docs/runbooks/TENANT_JOB_RUNTIME_MIGRATION.md`](../runbooks/TENANT_JOB_RUNTIME_MIGRATION.md)
- Operator runbook: [`docs/runbooks/OPERATOR_JOB_RUNTIME_OVERLAY.md`](../runbooks/OPERATOR_JOB_RUNTIME_OVERLAY.md)
