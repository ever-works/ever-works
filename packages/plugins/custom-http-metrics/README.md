# @ever-works/custom-http-metrics-plugin

First-party **`metrics-provider`** plugin (Goals PR-7) that turns any JSON HTTP
endpoint the user controls into a platform metric. Each configured endpoint is
exposed as one metric with `supportedWindows: ['point']` — a custom endpoint
returns the **current** value; window semantics beyond a point-in-time reading
are the endpoint's own concern.

The platform's `MetricsFacadeService` (in `@ever-works/agent`) routes
`listMetrics` / `getMetricValue` calls here so Goals (PR-8) can evaluate
targets like "keep signups above 100" against user-owned numbers without a
first-party integration.

## Capability contract

Implements `IMetricsProviderPlugin` from
`@ever-works/plugin` (`contracts/capabilities/metrics-provider.interface.ts`):

- `listMetrics(settings?)` — maps configured endpoints to `MetricDescriptor`s
- `getMetricValue(query, settings?)` — GETs the endpoint, extracts and returns
  the numeric value as a `MetricSample`
- `isAvailable(settings?)` — `true` when at least one endpoint is configured
  (always `true` for the settings-less registry probe)

The contract is **read-only by design** — this plugin never issues anything but
GET requests (enforced at settings-validation time _and_ again at call time).

## Settings

```jsonc
{
	"endpoints": [
		{
			"id": "mrr", // stable metric id (referenced by Goals)
			"label": "Monthly recurring revenue",
			"url": "https://metrics.example.com/mrr",
			"unit": "usd", // optional, defaults to "count"
			"valuePath": "data.metrics[0].value",
			"method": "GET", // optional; GET is the only allowed value
			"headers": {
				// optional; values are stored as secrets (x-secret)
				"Authorization": "Bearer …"
			}
		}
	]
}
```

### Value paths

`valuePath` is a tiny, safe, dependency-free dot/bracket resolver — **not** a
full JSONPath engine (and definitely not `eval`):

- `data.metrics.value` — dot-separated keys
- `data.metrics[0].value` — numeric array indices
- `stats['active users']` / `stats["active users"]` — quoted keys
- optional leading `$` root: `$.data.value`

Only own properties are read (never the prototype chain);
`__proto__` / `constructor` / `prototype` segments are rejected outright.

## Security & robustness

- **SSRF-guarded**: every request goes through
  `safeFetchWithDnsPin` from `@ever-works/plugin/helpers/ssrf-guard`
  (lexical check + DNS resolution check — private, loopback, link-local,
  CGNAT and cloud-metadata addresses are blocked). `validateSettings`
  additionally runs the lexical check for early feedback.
- **GET-only**: any configured non-GET method fails validation and, as a
  second line of defense, fails the call itself (`method_not_allowed`).
- **No redirects**: `redirect: 'error'` — the guard does not re-validate
  post-redirect targets, so redirects are refused entirely.
- **Caps**: responses are limited to **1 MB** (checked via Content-Length
  _and_ while streaming) and **15 s** (`AbortSignal.timeout`).
- **JSON only**: the response must carry a `*json*` content type and parse
  as JSON; the extracted value must coerce to a finite number.

All failures throw `CustomHttpMetricsError` with a stable `code`
(`ssrf_blocked`, `method_not_allowed`, `response_too_large`, `timeout`,
`http_error`, `invalid_content_type`, `invalid_json`, `value_not_found`,
`value_not_numeric`, `unknown_metric`, `unsupported_window`,
`invalid_settings`).

## Development

```bash
cd packages/plugins/custom-http-metrics
pnpm build   # tsc --noEmit && tsup (ESM + CJS + DTS)
pnpm test    # vitest
```
