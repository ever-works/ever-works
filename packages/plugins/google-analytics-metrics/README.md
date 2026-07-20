# @ever-works/google-analytics-metrics-plugin

Read-only Google Analytics 4 metrics for the Ever Works **Goals** feature
(capability: `metrics-provider`). Lets Goals evaluate targets like
"1000 active users/week" or "50 conversions/day" without hard-coding
Google anywhere in the platform.

Built on the **official
[`@google-analytics/data`](https://www.npmjs.com/package/@google-analytics/data)
SDK** (`BetaAnalyticsDataClient.runReport` — no hand-rolled REST).

## Metrics

| Metric id      | GA4 Data API metric | Windows                | Unit    |
| -------------- | ------------------- | ---------------------- | ------- |
| `active_users` | `activeUsers`       | `day`, `week`, `month` | `count` |
| `sessions`     | `sessions`          | `day`, `week`, `month` | `count` |
| `conversions`  | `keyEvents`         | `day`, `week`, `month` | `count` |

### `conversions` = GA4 key events

GA4 renamed **conversions → key events** in March 2024; `keyEvents` is
the current Data API metric name and what this plugin queries. The
provider-facing metric id stays `conversions` because that is the term
Goals users reach for. If you are cross-checking against other GA
tooling, the legacy/pre-rename Data API metric name for the same series
was `conversions` — on properties/tools that still use the old name,
`keyEvents` is its direct successor.

## Window → date-range math (UTC, documented choice)

Window boundaries are computed on **UTC calendar boundaries**, mirroring
the `stripe-metrics` sibling, then sent as GA4 `dateRanges`
(`YYYY-MM-DD`, both ends **inclusive** — the GA4 API contract):

- `day` — the anchor's UTC date (`startDate = endDate`). With no
  `windowAnchor` this means **"today UTC so far"**: GA reports partial
  data for the current day.
- `week` — the ISO week: Monday on/before the anchor through the
  following Sunday.
- `month` — the 1st through the last day of the anchor's UTC month.

`windowAnchor` (ISO-8601) selects "the day/week/month containing this
instant"; omitted = now.

**Caveat:** the GA4 API interprets report dates in the _property's
reporting time zone_, not UTC. We deliberately anchor the calendar math
in UTC so every metrics provider agrees on which day/week/month an
instant belongs to; for properties whose reporting zone differs from
UTC, the day boundaries within GA are the property's own.

Aggregate parsing: a metrics-only `runReport` returns one aggregate row;
`rows[0].metricValues[0].value` is the value. GA omits `rows` entirely
when the range has no data — that is reported as `0`, not an error.

## Typed errors

Failures throw `GoogleAnalyticsMetricsError` with a stable `code`:
`invalid_settings`, `unknown_metric`, `unsupported_window`,
`invalid_anchor`, `auth_error` (gRPC `UNAUTHENTICATED`/`PERMISSION_DENIED`
or HTTP 401/403 — `status` is set to 401/403), `http_error` (other
upstream failures) and `invalid_response` (malformed report rows).

## Read-only by design — minimal access

This plugin only calls `runReport`, a reporting endpoint that cannot
mutate anything (the `metrics-provider` contract forbids writes anyway).
Grant the service account only the **Viewer** role:

1. In Google Cloud, create a service account and download a **JSON key**;
   enable the **Google Analytics Data API** for the project
2. In GA4 **Admin → Property access management**, add the service-account
   email with the **Viewer** role
3. Paste the JSON key into the plugin's **Service account key** setting

## Settings

| Setting              | Required | Description                                                                                                                     |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `propertyId`         | yes      | Numeric GA4 property id (e.g. `123456789`; `properties/123456789` also accepted). Env fallback: `GOOGLE_ANALYTICS_PROPERTY_ID`. |
| `serviceAccountJson` | yes      | Full JSON service-account key file. Secret; env fallback: `GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON`.                              |

## Development

```bash
pnpm build   # tsc --noEmit && tsup (ESM + CJS + d.ts)
pnpm test    # Vitest (SDK fully mocked — no network)
```
