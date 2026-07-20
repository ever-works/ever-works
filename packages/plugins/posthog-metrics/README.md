# @ever-works/posthog-metrics-plugin

Read-only PostHog product analytics metrics for the Ever Works **Goals**
feature (capability: `metrics-provider`). Lets Goals evaluate targets
like "100 signups/day" or "1000 active users/month" without hard-coding
PostHog anywhere in the platform.

## Why a raw Query API client (and not `posthog-node`)?

House rule NN #22 mandates official SDKs — with a documented escape
hatch when no official SDK covers the surface. That escape hatch applies
here: the official [`posthog-node`](https://www.npmjs.com/package/posthog-node)
SDK is **ingestion-only** (`capture`, `identify`, feature flags) and
exposes no surface for the [PostHog Query API](https://posthog.com/docs/api/queries)
(`POST /api/projects/:project_id/query`), and PostHog ships no official
JS client for querying. This plugin therefore implements a **minimal
fetch client** against the documented Query API (15 s timeout, typed
errors). The rationale is also documented in the module doc block of
`src/posthog-metrics.plugin.ts`.

## Metrics

| Metric id      | What it reads                                         | Windows                | Unit    | Params              |
| -------------- | ----------------------------------------------------- | ---------------------- | ------- | ------------------- |
| `event_count`  | `count()` of one event via HogQL over the window      | `day`, `week`, `month` | `count` | `{ event: string }` |
| `active_users` | `count(DISTINCT person_id)` via HogQL over the window | `day`, `week`, `month` | `count` | —                   |

Notes:

- All window boundaries are computed in **UTC** (PostHog stores event
  timestamps in UTC). `week` is the ISO week (Monday 00:00:00 UTC
  through the following Monday). `windowAnchor` (ISO-8601) selects "the
  day/week/month containing this instant"; omitted = now.
- Ranges are half-open: `timestamp >= from AND timestamp < to`.
- The event name travels as a HogQL **placeholder value** (`{event}` +
  `values`), never string-interpolated into the query — no HogQL
  injection is possible and the query shape is fixed.

## Read-only by design

The Query API is called with HTTP POST, but the request is a pure read:
it executes a fixed HogQL `SELECT` and mutates nothing (the
`metrics-provider` contract is about side effects, not HTTP verbs).
Use a **personal API key scoped to `Query: Read`** only:

1. PostHog → **Settings** → **Personal API keys**
2. **Create personal API key** → scope it to _Query: Read_ on your project
3. Configure the `phx_...` key + your **Project ID** (Settings → Project)

## Settings

| Setting          | Required | Default                  | Notes                                                         |
| ---------------- | -------- | ------------------------ | ------------------------------------------------------------- |
| `apiHost`        | no       | `https://us.posthog.com` | EU Cloud: `https://eu.posthog.com`; self-hosted URLs work too |
| `projectId`      | yes      | —                        | Numeric project id; env fallback `POSTHOG_PROJECT_ID`         |
| `personalApiKey` | yes      | —                        | Secret (`x-secret`); env fallback `POSTHOG_PERSONAL_API_KEY`  |

## Typed errors

All failures throw `PostHogMetricsError` with a stable `code`
(mirroring the `custom-http-metrics` sibling where the codes overlap):
`invalid_settings`, `unknown_metric`, `unsupported_window`,
`invalid_params`, `timeout` (15 s cap), `http_error` (carries the
upstream `status`), `invalid_response`, `value_not_numeric`.

## Testing

```bash
cd packages/plugins/posthog-metrics && pnpm test
```

Vitest with a mocked `fetch` — query construction (UTC boundaries,
HogQL placeholders), response parsing (`results[0][0]`), error mapping
and settings/env resolution. No network access.
