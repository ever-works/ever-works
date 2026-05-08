# @ever-works/brave-plugin

Brave Plugin - Privacy-focused web search using Brave Search API

## Plugin metadata

| Field        | Value           |
| ------------ | --------------- |
| ID           | `brave`         |
| Category     | `search`        |
| Capabilities | `search`        |
| Author       | Ever Works Team |
| License      | AGPL-3.0        |
| Built-in     | yes             |
| Auto-enable  | no              |

## What does Brave Search do?

Brave Search provides privacy-focused web search results from an independent search index. Unlike other search engines, Brave builds its own index and does not track users or their searches.

## Why use it?

- **Privacy-first** — no tracking, no profiling, independent search index
- **Fresh results** — filter by time range (day, week, month, year)
- **Safe search** — built-in content filtering (off, moderate, strict)
- **Localization** — supports country and language filtering

## How it works in Ever Works

When enabled and set as the active search provider, Brave Search is used during work generation to find information about each item. Its independent index can surface results that other engines may miss.

## Getting started

1. Get an API key at [brave.com/search/api](https://brave.com/search/api/)
2. Enter the key in the **API Key** field below
3. Enable this plugin to use it for work generation

## Settings

- **API Key** — Your Brave Search API key (secret, scoped per user, also configurable via `PLUGIN_BRAVE_API_KEY`).
- **Default Max Results** — Default number of results per search (1–20, default 10).

## Troubleshooting

| Symptom                                      | Likely cause                                                            | Fix                                                                                                                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 Unauthorized` / `Authentication failed` | API key missing, revoked, or wrong key entered                          | Re-enter the **API Key** from the [Brave Search dashboard](https://api.search.brave.com/app/dashboard); or set `PLUGIN_BRAVE_API_KEY` in the host environment for default fallback |
| `429 Too Many Requests`                      | Free-tier rate limit exceeded (1 query/sec)                             | Wait, throttle calls, or upgrade the plan in the Brave dashboard                                                                                                                   |
| Plugin not used during work generation       | Another search plugin is set as the default for the `search` capability | In **Settings → Plugins**, set `brave` as the default for `search`, or disable competing search plugins                                                                            |
| Empty results array                          | Query returned no Brave-indexed results, or `safesearch` filtered them  | Broaden the query, lower `safesearch` (`off` / `moderate` / `strict`), or remove time-range / country filters                                                                      |
| `Healthcheck failed`                         | API key invalid OR Brave API endpoint unreachable from the host         | Verify the key with `curl -H 'X-Subscription-Token: $KEY' https://api.search.brave.com/res/v1/web/search?q=test` and confirm outbound HTTPS to `api.search.brave.com` is allowed   |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/brave-plugin build
pnpm --filter @ever-works/brave-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Brave Search homepage](https://brave.com/search/api)

## License

AGPL-3.0
