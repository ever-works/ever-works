# Anonymous usage statistics sender (`ever-stats-sink`)

The built-in provider of the `stats-sink` capability: it delivers the anonymous usage statistics report of an Ever Works installation to the statistics endpoint.

- **What it receives:** one report that the statistics module already built, validated against the published `ever.stats.v1` schema, serialised once and signed with the installation's statistics key.
- **What it does:** `POST <base>/v1/stats/reports` with the body exactly as given, the signature headers as given, `Content-Type: application/json` and the `User-Agent` the module passes. No cookie, no credential, no redirect followed, a timeout, and never a body above 16 KiB. The base URL must be `https` (`http` only for a private or local host, for example a local test receiver).
- **What it answers:** `sent` (202), `rejected` (a redirect, 400, 409, 413, 415, 422 — with the refused field paths for a 422 — and any other 4xx), or `failed` (408, 429, 5xx, network, timeout). It reads at most 64 KiB of an answer.
- **What it never does:** open a connection when it is loaded, start a timer, read or log the body, or add anything to the report.

The plugin is hidden and has no settings. With statistics off — the default, unless `EVER_STATS_ENABLED=true` — or switched off in **Settings → Ever Platform**, nothing ever calls it.

To deliver reports somewhere else, write a plugin that declares the `stats-sink` capability and set `EVER_WORKS_STATS_SINK` to its id.

See [Anonymous usage statistics](../../../docs/ever-platform/anonymous-statistics.md).
