# @ever-works/exa-plugin

Exa Plugin - Neural and keyword search using the Exa API

## Plugin metadata

| Field        | Value                         |
| ------------ | ----------------------------- |
| ID           | `exa`                         |
| Category     | `search`                      |
| Capabilities | `search`, `content-extractor` |
| Author       | Ever Works Team               |
| License      | AGPL-3.0                      |
| Built-in     | yes                           |
| Auto-enable  | no                            |

## What does Exa do?

Exa is an AI-native search engine that understands meaning, not just keywords. It offers neural search (semantic understanding), keyword search (traditional matching), and an auto mode that picks the best approach for each query. It can also extract clean text content from web pages.

## Why use it?

- **Neural search** — finds results based on meaning, not just keyword matching
- **Content extraction** — pulls clean text from any web page URL
- **Category filtering** — restrict to companies, research papers, news, tweets, GitHub repos, or personal sites
- **Domain control** — include or exclude specific domains from results
- **Time filtering** — find results from the last day, week, month, or year

## How it works in Ever Works

When enabled and set as the active search provider, Exa is used during work generation to find information about each item. Its neural search mode is particularly useful for finding semantically relevant content that keyword-based engines might miss. The content extraction capability can pull text from web pages for enriching work items.

## Getting started

1. Create an account at [exa.ai](https://exa.ai)
2. Copy your API key from the Exa dashboard
3. Enter the key in the **API Key** field below
4. Choose your preferred search type (auto recommended)
5. Enable this plugin to use it for work generation

## Settings

- **API Key** — Your Exa API key (secret, scoped per user, also configurable via `PLUGIN_EXA_API_KEY`).
- **Search Type** — Search mode: `auto` (recommended), `neural` (semantic), or `keyword` (traditional).
- **Default Max Results** — Default number of results per search (1–100, default 10).
- **Category Filter** — Optionally restrict results to a specific category (company, research paper, news, tweet, personal site, github).

## Troubleshooting

| Symptom                                      | Likely cause                                                            | Fix                                                                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 Unauthorized` / `Authentication failed` | API key missing, revoked, or wrong key entered                          | Re-enter the **API Key** from the Exa dashboard, or set `PLUGIN_EXA_API_KEY` in the host environment for default fallback                                 |
| `429 Too Many Requests`                      | Free-tier or paid quota exhausted on Exa                                | Throttle calls, wait for the quota reset, or upgrade the plan in the Exa dashboard                                                                        |
| Empty / sparse results                       | Query is too restrictive, time-range or domain filters are too narrow   | Broaden the query, relax `time_range` / `safesearch` / `include_domains` / `exclude_domains` filters, or raise `max_results`                              |
| Plugin not used during work generation       | Another search plugin is set as the default for the `search` capability | In **Settings → Plugins**, set `exa` as the default for `search`, or disable competing search plugins                                                     |
| `Failed to extract content` for a URL        | Page is gated by login, Cloudflare, or robots.txt; URL is malformed     | Verify the URL is publicly reachable; for protected pages enable a different `content-extractor` plugin (`scrapfly`, `notion-extractor`, `pdf-extractor`) |
| `healthCheck` reports unhealthy              | API key invalid OR Exa endpoint unreachable from the host               | Verify the key with a manual `curl` against the documented endpoint and confirm outbound HTTPS is allowed by the firewall                                 |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/exa-plugin build
pnpm --filter @ever-works/exa-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Exa homepage](https://exa.ai)

## License

AGPL-3.0
