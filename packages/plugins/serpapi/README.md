# @ever-works/serpapi-plugin

SerpAPI Plugin - Web search using SerpAPI (Google, Bing, Yahoo, and more)

## Plugin metadata

| Field        | Value           |
| ------------ | --------------- |
| ID           | `serpapi`       |
| Category     | `search`        |
| Capabilities | `search`        |
| Author       | Ever Works Team |
| License      | AGPL-3.0        |
| Built-in     | yes             |
| Auto-enable  | no              |

## What does SerpAPI do?

SerpAPI provides structured search results from multiple search engines including Google, Bing, Yahoo, DuckDuckGo, Baidu, and Yandex. It returns clean, parsed results ready for AI processing.

## Why use it?

- **Multiple engines** — choose from Google, Bing, Yahoo, DuckDuckGo, Baidu, or Yandex
- **Structured data** — returns parsed results with titles, snippets, links, and metadata
- **Region & language** — target specific countries and languages for localized results
- **Pagination** — navigate through multiple pages of results
- **Related searches** — discover related search queries

## How it works in Ever Works

When enabled and set as the active search provider, SerpAPI is used during work generation to find information about each item. It can search across multiple engines to gather diverse source material.

## Getting started

1. Create an account at [serpapi.com](https://serpapi.com)
2. Copy your API key from the SerpAPI dashboard
3. Enter the key in the **API Key** field below
4. Select your preferred search engine
5. Enable this plugin to use it for work generation

## Settings

- **API Key** — Your SerpAPI key (secret, scoped per user, also configurable via `PLUGIN_SERPAPI_API_KEY`).
- **Search Engine** — Which engine to use: `google` (default), `bing`, `yahoo`, `duckduckgo`, `baidu`, or `yandex`.
- **Default Max Results** — Default number of results per search (1–100, default 10).

## Troubleshooting

| Symptom                                      | Likely cause                                                            | Fix                                                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `401 Unauthorized` / `Authentication failed` | API key missing, revoked, or wrong key entered                          | Re-enter the **API Key** from the SerpAPI dashboard, or set `PLUGIN_SERPAPI_API_KEY` in the host environment for default fallback |
| `429 Too Many Requests`                      | Free-tier or paid quota exhausted on SerpAPI                            | Throttle calls, wait for the quota reset, or upgrade the plan in the SerpAPI dashboard                                            |
| Empty / sparse results                       | Query is too restrictive, time-range or domain filters are too narrow   | Broaden the query, relax `time_range` / `safesearch` / `include_domains` / `exclude_domains` filters, or raise `max_results`      |
| Plugin not used during work generation       | Another search plugin is set as the default for the `search` capability | In **Settings → Plugins**, set `serpapi` as the default for `search`, or disable competing search plugins                         |
| `healthCheck` reports unhealthy              | API key invalid OR SerpAPI endpoint unreachable from the host           | Verify the key with a manual `curl` against the documented endpoint and confirm outbound HTTPS is allowed by the firewall         |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/serpapi-plugin build
pnpm --filter @ever-works/serpapi-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [SerpAPI homepage](https://serpapi.com)

## License

AGPL-3.0
