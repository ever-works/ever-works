# @ever-works/brightdata-plugin

Bright Data Plugin - Web search and content extraction using Bright Data API

## Plugin metadata

| Field        | Value                         |
| ------------ | ----------------------------- |
| ID           | `brightdata`                  |
| Category     | `search`                      |
| Capabilities | `search`, `content-extractor` |
| Author       | Ever Works Team               |
| License      | AGPL-3.0                      |
| Built-in     | yes                           |
| Auto-enable  | no                            |

## What does Bright Data do?

Bright Data provides web search via its SERP API and content extraction via its Web Scraper. It handles bot detection, CAPTCHAs, and geo-restrictions through a global proxy network.

## Why use it?

- **SERP API** — search Google, Bing, and Yandex programmatically with structured results
- **Bot detection bypass** — handles CAPTCHAs, JavaScript challenges, and anti-bot measures
- **Markdown extraction** — converts any web page into clean markdown content
- **Parallel scraping** — extract content from multiple URLs concurrently

## How it works in Ever Works

Bright Data serves dual purposes: the SERP API finds relevant information about work items, while the Web Scraper extracts content from web pages. Its bot-detection bypass makes it effective for sites that block standard requests.

## Getting started

1. Sign up at [brightdata.com](https://brightdata.com)
2. Copy your API key from the dashboard
3. Enter the key in the **API Key** field below
4. Enable this plugin to use it for search and/or content extraction

## Settings

- **API Key** (`apiKey`) — required, secret. Your Bright Data API key (also configurable via the `PLUGIN_BRIGHTDATA_API_KEY` environment variable).
- Stored at user scope so each user can supply their own credentials.
- Configuration mode is `hybrid` — admins can preset values and users may override them.

## Troubleshooting

| Symptom                                      | Likely cause                                                            | Fix                                                                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 Unauthorized` / `Authentication failed` | API key missing, revoked, or wrong key entered                          | Re-enter the **API Key** from the Bright Data dashboard, or set `PLUGIN_BRIGHTDATA_API_KEY` in the host environment for default fallback                  |
| `429 Too Many Requests`                      | Free-tier or paid quota exhausted on Bright Data                        | Throttle calls, wait for the quota reset, or upgrade the plan in the Bright Data dashboard                                                                |
| Empty / sparse results                       | Query is too restrictive, time-range or domain filters are too narrow   | Broaden the query, relax `time_range` / `safesearch` / `include_domains` / `exclude_domains` filters, or raise `max_results`                              |
| Plugin not used during work generation       | Another search plugin is set as the default for the `search` capability | In **Settings → Plugins**, set `brightdata` as the default for `search`, or disable competing search plugins                                              |
| `Failed to extract content` for a URL        | Page is gated by login, Cloudflare, or robots.txt; URL is malformed     | Verify the URL is publicly reachable; for protected pages enable a different `content-extractor` plugin (`scrapfly`, `notion-extractor`, `pdf-extractor`) |
| `healthCheck` reports unhealthy              | API key invalid OR Bright Data endpoint unreachable from the host       | Verify the key with a manual `curl` against the documented endpoint and confirm outbound HTTPS is allowed by the firewall                                 |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/brightdata-plugin build
pnpm --filter @ever-works/brightdata-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Bright Data homepage](https://brightdata.com)

## License

AGPL-3.0
