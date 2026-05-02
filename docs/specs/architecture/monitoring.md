# Architecture: Monitoring & Observability

**Status**: `Active`
**Last updated**: 2026-05-02
**Audience**: AI agents and engineers debugging production issues,
adding new metrics, configuring alert rules, or extending the
observability surface.

---

## 1. Purpose

The platform's observability surface is **two providers wrapped in one
NestJS module**:

- **Sentry** — error tracking, traces, breadcrumbs, performance
  profiling.
- **PostHog** — product analytics, feature flags, session replay
  metadata.

The `@ever-works/monitoring` package is the single integration point
both apps and packages depend on. Plugins never import Sentry or
PostHog SDKs directly; they emit events that flow through the
monitoring module's interceptors and helpers, so swapping providers
or turning the whole thing off is a config change rather than a code
change.

This spec covers the **module composition**, **interceptor model**,
**event taxonomy**, **secret hygiene at the observability boundary**,
and the **disabled-by-default** behaviour for self-hosted deploys.

## 2. Module Layout

```
packages/monitoring/src/
├── index.ts
├── monitoring.module.ts          # Top-level NestJS module
├── interceptors/                 # Request-scoped wrappers
│   ├── sentry.interceptor.ts     # Wraps every controller in a Sentry span
│   ├── posthog.interceptor.ts    # Captures structured events post-handler
│   └── index.ts
├── sentry/
│   ├── sentry.module.ts          # Sentry NestJS provider
│   ├── sentry.config.ts          # DSN, environment, sample rates, integrations
│   └── index.ts
├── posthog/
│   ├── posthog.module.ts
│   ├── posthog.config.ts         # Project key, host, batching
│   └── index.ts
├── services/                     # Helpers consumed by domain code
└── types/                        # Shared event-shape types
```

`monitoring.module.ts` composes both providers into a single import:

```ts
@Module({
	imports: [SentryModule.forRoot(), PostHogModule.forRoot()],
	providers: [SentryInterceptor, PostHogInterceptor],
	exports: [SentryInterceptor, PostHogInterceptor]
})
export class MonitoringModule {}
```

Apps register `MonitoringModule` once at the root; the global
interceptor list (`APP_INTERCEPTOR`) wires both interceptors so every
controller is covered without per-route opt-in.

## 3. Configuration & Disabled-by-Default

Monitoring providers are **off** unless their respective env vars are
set:

| Provider | Required env vars                     | Disabled behaviour                                              |
| -------- | ------------------------------------- | --------------------------------------------------------------- |
| Sentry   | `SENTRY_DSN`                          | `SentryInterceptor` becomes a no-op pass-through                |
| PostHog  | `POSTHOG_PROJECT_KEY`, `POSTHOG_HOST` | `PostHogInterceptor` and `ActivityLogAnalyticsDispatcher` no-op |

`sentry.config.ts` and `posthog.config.ts` validate env at startup and
emit a clear log line on each startup (`Sentry enabled: dsn=...
environment=production` or `Sentry disabled: SENTRY_DSN not set`) so
ops can tell at a glance whether the deploy is reporting.

This matches the [`subscriptions`](./subscriptions.md) "self-hosted
single-tenant" pattern — a fresh deploy works without external
provider accounts.

## 4. Sentry Integration

### 4.1 What Sentry captures

| Surface              | What                                                                     |
| -------------------- | ------------------------------------------------------------------------ |
| Unhandled exceptions | Full stack traces with TypeScript source-maps                            |
| HTTP request errors  | Captured by `SentryInterceptor` with operation name + user context       |
| Trigger.dev tasks    | Wrapped at the worker level; failures attach the task id and run id      |
| Pipeline step errors | Step-name + step-state context attached as Sentry tags                   |
| Performance traces   | Sampled requests + Trigger.dev runs; sample rate per environment         |
| Breadcrumbs          | Manually-added context (cache hits/misses, facade calls, plugin lookups) |

### 4.2 Tags & context

The interceptor sets these on every event automatically:

| Tag            | Source                                                   |
| -------------- | -------------------------------------------------------- |
| `app`          | `ever-works-api` / `ever-works-mcp` / `trigger-worker`   |
| `userId`       | `req.user.userId` if authenticated                       |
| `directoryId`  | Route param when present                                 |
| `pluginId`     | Set by facade interceptors when routing through a plugin |
| `pipelineStep` | Set by the pipeline executor on step events              |
| `triggerRunId` | Set by the Trigger.dev task wrapper                      |
| `release`      | Git SHA of the deployed build                            |
| `environment`  | `production` / `staging` / `development`                 |

### 4.3 Sample rates

| Environment   | Trace sample rate | Profiler sample rate |
| ------------- | ----------------- | -------------------- |
| `production`  | 0.1 (10%)         | 0.05 (5%)            |
| `staging`     | 0.5 (50%)         | 0.25 (25%)           |
| `development` | 1.0 (100%)        | 1.0 (100%)           |

Configurable via `SENTRY_TRACES_SAMPLE_RATE` and
`SENTRY_PROFILES_SAMPLE_RATE` env vars.

### 4.4 Integration list

Sentry is configured with these integrations enabled by default:

- `Http` — outbound HTTP request spans.
- `Express` / `Nest` — automatic transaction naming.
- `Postgres` (when applicable) — DB query spans.
- `OnUncaughtException`, `OnUnhandledRejection` — guarantee no
  error escapes silently.
- **Disabled**: `LocalVariables` (memory cost in production),
  `Anr` (still flaky in NestJS workers).

## 5. PostHog Integration

### 5.1 What PostHog captures

PostHog is **product analytics**, not error tracking. It receives:

- **Activity-log events** — see
  [`activity-log`](./activity-log.md). Every `ActivityLog` row dispatched
  to PostHog as a typed event.
- **Page views** (from the dashboard, with locale + page name).
- **Feature usage** (custom events emitted by domain code).
- **Plan changes** — upgrade, downgrade, cancellation.
- **Generation cost / outcome** — aggregated per directory per period.

### 5.2 Event naming convention

snake_case, derived from `ActivityActionType`:

| `ActivityActionType`  | PostHog event name    |
| --------------------- | --------------------- |
| `DIRECTORY_GENERATED` | `directory_generated` |
| `ITEM_ADDED`          | `item_added`          |
| `OAUTH_LINKED`        | `oauth_linked`        |

Event properties mirror the row's `details` block but **with PII
stripped** (no email, no IP, no user-agent — only `userId`, opaque
UUIDs, and action context).

### 5.3 Identification

Users are identified by `userId` (UUID). The platform never sends
`email` or `name` to PostHog. The dashboard alias-creates the user on
first login — `posthog.identify(userId, {plan, locale})` — and the
`PostHogInterceptor` includes `distinct_id: userId` on every event.

### 5.4 Feature flags

PostHog feature flags are read on the API side via
`posthog.getFeatureFlag(flagKey, distinctId)`. Used today for:

- A/B testing pipeline tweaks.
- Gradual rollouts of new pipelines (e.g. claude-managed-agent
  rollout).
- "Beta tester" feature gates.

## 6. Structured Logging

NestJS's `Logger` is the canonical logger. The platform doesn't add a
parallel logging library. Conventions:

- **Context** — every service constructor sets a `Logger` with the
  class name (`new Logger(MyService.name)`).
- **Levels** — `verbose` < `debug` < `log` < `warn` < `error`.
- **Structured payloads** — `logger.log('directory generated', { directoryId, durationMs })`.
- **No sensitive values** — never log API keys, OAuth tokens, JWT
  payloads, or user emails.
- **JSON output in production** — `LOGGER_FORMAT=json` flips the log
  formatter to NDJSON for downstream aggregation (Datadog, Loki,
  CloudWatch, etc.).

## 7. The Two Interceptors

Both run on every controller via `APP_INTERCEPTOR`:

### 7.1 `SentryInterceptor`

- Starts a Sentry span named after the route.
- Attaches the user / directory / plugin tags described in §4.2.
- On error, captures the exception with the active span.
- On success, finishes the span with the response status.

### 7.2 `PostHogInterceptor`

- Skips `@Public()` routes by default (no PostHog events for unauthenticated traffic — they'd flood with bot scans).
- After the handler finishes, captures a `request_completed` event
  with `path`, `method`, `status`, `durationMs`, `userId`.
- Domain-specific events come from `ActivityLogService` — the
  interceptor is the catch-all for "something happened on a request"
  metrics.

## 8. Plugin-Side Observability

Plugins receive a `logger` via their `PluginContext`. The logger is
namespaced as `[plugin:<id>]` so log lines from a plugin can be
filtered to one source. Plugins **don't** call Sentry / PostHog SDKs —
the platform's interceptors capture errors and successes for them.

For plugin-specific events that matter to product analytics, plugins
emit them via the activity-log service:

```ts
ctx.events.emit('plugin:setting-tested', {
	pluginId: 'openai',
	success: true,
	tier: 'complex'
});
```

The activity-log service picks up `plugin:*` events and records them
as `PLUGIN_TESTED` activity-log rows — which then flow to PostHog via
the dispatcher.

## 9. Trigger.dev Worker Observability

The Trigger.dev worker is its own NestJS app context (see
[`trigger-integration`](./trigger-integration.md)). Each task:

- Boots a NestJS application context with `MonitoringModule`.
- Wraps `task.run` in a Sentry span named after the task id.
- Adds `triggerRunId` and `cronId` (when scheduled) as tags.
- On error, captures with task context.
- Closes the application context in `finally` so resources free up.

A failed Trigger.dev run shows up in Sentry as a transaction tagged
with the task id, the directory id (when applicable), and the failing
step — clickable straight to the offending pipeline step.

## 10. Health Checks

The API exposes `/api/health` (a `@Public()` route):

```json
{
	"status": "ok",
	"uptime": 12345,
	"checks": {
		"database": "ok",
		"cache": "ok",
		"sentry": "enabled",
		"posthog": "enabled",
		"subscriptions": "enabled",
		"trigger": "enabled"
	}
}
```

Each check is a fast read (no external API call) — it inspects the
in-process module wiring. Returns `503` when any check is `failed`;
returns `200` with a degraded subset list when any check is
`disabled`. K8s liveness probes consume this endpoint.

A separate `/api/health/deep` (admin-only) actually pings the DB,
cache, Sentry, PostHog, and Trigger.dev — used for incident response.

## 11. Sentry-PostHog Cross-Linking

When both providers are enabled, the platform threads each Sentry
event with a `posthog_session_id` so support can pivot from a Sentry
error → PostHog session replay. The reverse pivot uses
`sentry_event_id` recorded on PostHog events at error time.

## 12. Secret Hygiene at the Observability Boundary

Two scrubbing layers ensure secrets never leave the process:

1. **Sentry beforeSend hook** — strips fields matching the
   [`settings-system`](./settings-system.md) `x-secret` patterns from
   breadcrumbs, request payloads, and error context.
2. **PostHog property denylist** — `email`, `apiKey`, `token`,
   `password`, anything matching `*_secret` / `*_password` / `*Token`
   is dropped before sending.

Both hooks are applied at the SDK level — every event the platform
sends goes through them, regardless of caller.

## 13. Constitution Reconciliation

| Principle                   | How monitoring respects it                                                       |
| --------------------------- | -------------------------------------------------------------------------------- |
| I — Plugin-first            | Plugins use `ctx.logger` and `ctx.events`; never Sentry / PostHog SDKs directly. |
| II — Capability-driven      | Provider abstraction means swapping Sentry / PostHog is contained.               |
| III — Source-of-truth repos | Monitoring is platform-side; never writes to user repos.                         |
| IV — Trigger.dev            | Trigger.dev worker has the same `MonitoringModule` wiring.                       |
| V — Forward-only migrations | No DB schema.                                                                    |
| VI — Tests                  | Interceptors covered by unit tests; integration paths e2e-tested.                |
| VII — Secret hygiene        | Two scrubbing layers (Sentry beforeSend + PostHog denylist).                     |
| VIII — Plugin counts        | Plugin counts are reported as PostHog events for adoption tracking.              |
| IX — Behaviour-first        | This spec describes observable behaviour.                                        |
| X — Backwards-compat        | New tags + events are additive.                                                  |

## 14. References

- Source:
    - `packages/monitoring/src/`
    - `packages/monitoring/src/sentry/sentry.config.ts`
    - `packages/monitoring/src/posthog/posthog.config.ts`
- Related specs:
    - [`activity-log`](./activity-log.md)
    - [`auth`](./auth.md)
    - [`trigger-integration`](./trigger-integration.md)
    - [`settings-system`](./settings-system.md)
- User docs: [`docs/devops/monitoring.md`](../../devops/monitoring.md)
