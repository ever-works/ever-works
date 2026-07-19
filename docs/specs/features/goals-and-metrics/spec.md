# Feature Specification: Goals & Metrics

> Behaviour-first spec for the Goals feature and its metrics foundation. PR-7 (this branch) ships the `metrics-provider` plugin capability + the first two providers; PR-8 ships the Goal entity and evaluation; PR-9 adds analytics providers + prompt integration. Captures the operator ruling from the domain-model review §23.4: **metrics collectors are plugins**, not built-in integrations.

**Feature ID**: `goals-and-metrics`
**Branch**: `feat/metrics-provider-capability` (PR-7 of the domain-model evolution)
**Status**: `Draft`
**Created**: 2026-07-19
**Last updated**: 2026-07-19
**Owner**: Product (Ruslan)

---

## 1. Overview

A user can attach measurable **Goals** to a Mission — targets like "$100/day balance" or "$1000/month income" — and have the platform evaluate them automatically against real business metrics (Stripe balance/income, an arbitrary HTTP endpoint, later PostHog/Google Analytics). Metric collection is **plugin-first**: every metric source is a `metrics-provider` plugin resolved through the standard capability registry, and every read is budget-guarded and metered like any other plugin call.

The rollout is split:

- **PR-7 (this spec's implemented scope)** — the read-only `metrics-provider` capability contract, the `MetricsFacadeService`, and two providers: `custom-http` and `stripe`.
- **PR-8** — the Goal entity family (`goals`, `goal_metric_samples`, `mission_goals`) and the evaluation dispatcher.
- **PR-9** — PostHog + Google Analytics providers and Goal-aware prompt integration.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** the Stripe plugin is enabled with a restricted (read-only) API key, **when** I list available metrics, **then** I see `balance` (point-in-time) and `income` (per day/week/month windows) with `usd` units.
- **Given** a Goal "income ≥ $1000/month via Stripe", **when** the evaluation dispatcher runs, **then** the platform reads the metric through the metrics facade, stores a sample, and updates the Goal's progress.
- **Given** the `custom-http` plugin pointed at my own metrics endpoint with a JSONPath-ish value extractor, **when** a Goal reads it, **then** the value is fetched with a GET request only, through the shared SSRF guard.
- **Given** multiple metrics providers enabled at once (e.g. Stripe + custom-http), **when** a Goal specifies its provider by plugin id, **then** exactly that provider serves the read — there is no single "active" metrics provider per scope.
- **Given** a metric crosses its target, **when** evaluation completes, **then** the Goal outcome may be auto-set to `achieved` (or `missed` at deadline) — and a human can override that outcome at any time.

### 2.2 Edge cases & failures

- **Given** the Work's monthly budget cap is reached, **when** a Goal evaluation triggers a metric read, **then** the read is blocked by the budget guard (`BudgetExceededException`, HTTP 402) before the provider is invoked.
- **Given** no metrics provider is enabled, **when** a read is attempted, **then** a typed `NoProviderError` surfaces (mapped to a 4xx by the facade exception filter — never an unmapped 500).
- **Given** a provider names a plugin id that is not an enabled `metrics-provider` plugin, **then** `ProviderNotFoundError`.
- **Given** the upstream API fails (rate limit, outage), **then** the failure is wrapped as a name-stable `MetricsFacadeError`; no usage event is recorded for the failed read.
- **Given** a `custom-http` target resolving to a private/internal address, **then** the SSRF guard rejects the request outright.

## 3. Functional Requirements

### 3.1 Metrics capability (PR-7 — implemented)

- **FR-1** The system MUST expose a `metrics-provider` plugin capability (registered in `PLUGIN_CAPABILITIES`) with a **read-only** contract:
    - `listMetrics(settings?) → MetricDescriptor[]` — enumerate served metrics (`id`, `label`, `unit`, `supportedWindows`, optional `paramsSchema`).
    - `getMetricValue(query, settings?) → MetricSample` — one value (`value`, `unit`, `at`) for a `MetricQuery` (`metricId`, `window`, optional `windowAnchor`/`params`).
    - Windows: `day` | `week` | `month` | `total` | `point`.
    - Optional `isAvailable(settings?)` probe and `getPricing()` cost declaration.
- **FR-2** Implementations MUST NOT mutate remote state (no POST/PUT/PATCH/DELETE side effects). Any write attempt is a contract violation.
- **FR-3** A `MetricsFacadeService` MUST route all platform metric reads through enabled `metrics-provider` plugins. **Multiple providers may be enabled simultaneously**; an explicit plugin id behaves as a provider override (`ProviderNotFoundError` if not an enabled loaded metrics provider), and an omitted id follows the standard resolution chain (override > work-active > default-for-capability > first enabled).
- **FR-4** `getMetricValue` MUST be budget-guarded (`BudgetGuardService.checkBudget`) **before** the provider call, under usage capability `metrics`.
- **FR-5** Every facade read MUST record a `plugin_usage_events` row with capability `metrics` (best-effort; a failed write never breaks the read; `metadata.operation` distinguishes `listMetrics` from `getMetricValue`; Agent/Task attribution propagated). Failed provider reads record nothing.
- **FR-6** The `custom-http` provider MUST be GET-only, MUST route every request through the shared SSRF guard (`@ever-works/plugin/helpers/ssrf-guard`), and MUST extract the value via a constrained JSONPath-ish expression from the response body.
- **FR-7** The Stripe provider MUST use the official `stripe` npm SDK (NN #22 — no hand-rolled REST) and serve at minimum: `balance` (point window) and `income` (day/week/month windows).
- **FR-8** Provider credentials MUST be declared via the standard plugin settings JSON Schema with `x-secret`/`x-envVar`, resolved through the 4-level settings hierarchy (Work > User > Admin > defaults), and never returned in API responses.

### 3.2 Goal entity & evaluation (PR-8 — planned)

- **FR-9** A `goals` table stores each Goal: target metric (provider plugin id + metric id + window), comparator + target value, deadline, status, and outcome.
- **FR-10** A `goal_metric_samples` table stores observed samples per Goal over time (feeding progress display and evaluation history).
- **FR-11** A `mission_goals` join table links Goals to Missions, with an `isPrimary` flag (at most one primary Goal per Mission).
- **FR-12** A `goal-evaluate-dispatcher` cron evaluates due Goals through the metrics facade. Per-Goal evaluation frequency is clamped to a **minimum interval of 15 minutes** regardless of configuration.
- **FR-13** Goal outcome MAY be auto-set from the metric (`achieved` when the target is met; `missed` when the deadline passes unmet). Auto-set outcomes MUST remain **human-overridable**.
- **FR-14** **Invariant I-4: Missions are NEVER auto-completed.** Goal evaluation updates Goal state only; completing a Mission is always an explicit human (or explicitly delegated agent) action, even when all its Goals are achieved.

### 3.3 Analytics providers & prompts (PR-9 — planned)

- **FR-15** PostHog and Google Analytics `metrics-provider` plugins (official SDKs), serving event/pageview-style metrics over the same contract.
- **FR-16** Goal context (targets + latest samples) injected into agent prompts where Mission context is already injected, so agents can reason about progress toward targets.

## 4. Non-Functional Requirements

- **Security**: read-only credentials recommended and documented per provider (e.g. Stripe restricted keys); `custom-http` is GET-only + SSRF-guarded; all secrets `x-secret`; every read metered and budget-guarded as capability `metrics`.
- **Reliability**: usage recording is best-effort and never breaks a read; provider failures map to typed facade errors (name-stable for the global `FacadeExceptionFilter` — no unmapped 500s).
- **Performance**: metric reads are single upstream calls; the ≥15-minute evaluation clamp bounds background load per Goal.
- **Compatibility**: additive only — new capability id, new `metrics` usage capability enum value (varchar column, no migration), new `metrics` plugin category. No existing surface removed or changed.

## 5. Key Entities & Domain Concepts

| Entity / concept           | Description                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `metrics-provider`         | Plugin capability id for read-only metric collectors (PR-7).                                 |
| `IMetricsProviderPlugin`   | The contract: `listMetrics` / `getMetricValue` (+ optional `isAvailable`, `getPricing`).     |
| `MetricsFacadeService`     | Agent-side facade routing reads; budget guard + usage metering; multi-provider by plugin id. |
| `custom-http` provider     | GET-only, SSRF-guarded, JSONPath-ish extraction from an operator-supplied endpoint (PR-7).   |
| `stripe` provider          | Official `stripe` SDK; `balance` (point) + `income` (day/week/month) (PR-7).                 |
| Goal                       | A measurable target on a Mission (comparator + value + window + deadline) — PR-8.            |
| `goal_metric_samples`      | Time series of observed values per Goal — PR-8.                                              |
| `mission_goals`            | Mission↔Goal join with `isPrimary` — PR-8.                                                   |
| `goal-evaluate-dispatcher` | Cron evaluating due Goals through the facade; ≥15 min clamp — PR-8.                          |
| Invariant I-4              | Missions are never auto-completed by Goal evaluation.                                        |

## 6. Out of Scope

- Writing anything to upstream systems (the capability is read-only by design).
- Auto-completing Missions from Goal state (invariant I-4).
- A single "active metrics provider" selection UX — multiple providers are first-class.
- Alerting/notification rules on metric thresholds (Goals + existing notification channels may compose later).
- PostHog / Google Analytics providers and prompt integration (PR-9, specced here but not built in PR-7/8).

## 7. Acceptance Criteria

### PR-7

- [x] `metrics-provider` capability contract + type guard exported from `@ever-works/plugin`.
- [x] `MetricsFacadeService` registered in `FacadesModule` and exported from the facades barrel.
- [x] Budget guard invoked before `getMetricValue`; `BudgetExceededException` passes through unwrapped.
- [x] `plugin_usage_events` rows recorded with capability `metrics` on successful reads only.
- [x] Facade unit tests cover resolution, budget gate, usage metering, and error mapping.
- [ ] `custom-http` plugin: GET-only, SSRF-guarded, JSONPath-ish extraction, Vitest-tested.
- [ ] `stripe` plugin: official SDK, `balance` + `income` windows, Vitest-tested.

### PR-8

- [ ] `goals`, `goal_metric_samples`, `mission_goals` tables + migrations (same PR).
- [ ] Dispatcher clamps evaluation frequency to ≥15 minutes.
- [ ] Auto-set outcomes overridable; Missions never auto-completed (test-pinned).

### PR-9

- [ ] PostHog + GA providers pass the same facade contract tests.
- [ ] Goal context appears in agent prompts behind the existing Mission context injection.

## 8. Open Questions

- `[NEEDS CLARIFICATION: Goal ownership scope — are Goals strictly Mission-scoped via mission_goals, or can a Goal exist unattached (org-level KPI) and be linked later? Default assumption: created standalone, attached via mission_goals.]`
- `[NEEDS CLARIFICATION: Sample retention — cap goal_metric_samples per Goal (e.g. rolling window) or keep full history?]`
- `[NEEDS CLARIFICATION: Does the PR-8 evaluation read as the Goal's creator (userId) for budget/settings resolution, or as a system principal with Work scope?]`

## 9. Constitution Gates

- [x] **Plugin-first (Principle I)** — every metric source is a plugin under `packages/plugins/*` (§23.4 operator ruling).
- [x] **Capability-driven resolution (Principle II)** — new `metrics-provider` capability resolved via the registry.
- [x] **Source-of-truth repos preserved (Principle III)** — no change to code/content-in-Git.
- [x] **Forward-only migrations (Principle V)** — PR-7 is migration-free (varchar enum value only); PR-8 ships its tables with migrations in the same PR.
- [x] **Tests accompany the change (Principle VI)** — facade unit tests in PR-7; provider Vitest suites with each plugin.
- [x] **Secrets per `x-secret` (Principle VII)** — all provider credentials `x-secret`/`x-envVar`.
- [x] **Behaviour-first (Principle IX)** — this spec describes behaviour; implementation detail stays in the PRs.
