# @ever-works/linkup-plugin

Linkup Plugin - Web search and content extraction using Linkup API

## Plugin metadata

| Field        | Value                         |
| ------------ | ----------------------------- |
| ID           | `linkup`                      |
| Category     | `search`                      |
| Capabilities | `search`, `content-extractor` |
| Author       | Ever Works Team               |
| License      | AGPL-3.0                      |
| Built-in     | yes                           |
| Auto-enable  | no                            |

## What does Linkup do?

Linkup connects AI applications to the internet, providing grounding data to enrich AI output with precision and factuality. It searches the web for relevant content and extracts clean markdown from any URL.

## Why use it?

- **High precision search** — optimized for factual grounding of LLM responses
- **Deep search mode** — iterative search for comprehensive results when needed
- **Content extraction** — fetches clean markdown from any webpage via the /fetch endpoint
- **Domain filtering** — include or exclude specific websites from search results

## How it works in Ever Works

During work generation, the search facade uses Linkup to find information about each item, discover relevant source URLs, and extract content from web pages. This powers automatic descriptions, source URL resolution, and content enrichment across the generation pipeline.

## Getting started

1. Create an account at [linkup.so](https://linkup.so)
2. Copy your API key from the Linkup dashboard
3. Enter the key in the **API Key** field below
4. Linkup will be available for use during work generation

## Settings

- **API Key** (`apiKey`) — required, secret. Your Linkup API key (also configurable via the `PLUGIN_LINKUP_API_KEY` environment variable).
- Stored at user scope so each user can supply their own credentials.
- Configuration mode is `hybrid` — admins can preset values and users may override them.

## Troubleshooting

| Symptom                                      | Likely cause                                                            | Fix                                                                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 Unauthorized` / `Authentication failed` | API key missing, revoked, or wrong key entered                          | Re-enter the **API Key** from the Linkup dashboard, or set `PLUGIN_LINKUP_API_KEY` in the host environment for default fallback                           |
| `429 Too Many Requests`                      | Free-tier or paid quota exhausted on Linkup                             | Throttle calls, wait for the quota reset, or upgrade the plan in the Linkup dashboard                                                                     |
| Empty / sparse results                       | Query is too restrictive, time-range or domain filters are too narrow   | Broaden the query, relax `time_range` / `safesearch` / `include_domains` / `exclude_domains` filters, or raise `max_results`                              |
| Plugin not used during work generation       | Another search plugin is set as the default for the `search` capability | In **Settings → Plugins**, set `linkup` as the default for `search`, or disable competing search plugins                                                  |
| `Failed to extract content` for a URL        | Page is gated by login, Cloudflare, or robots.txt; URL is malformed     | Verify the URL is publicly reachable; for protected pages enable a different `content-extractor` plugin (`scrapfly`, `notion-extractor`, `pdf-extractor`) |
| `healthCheck` reports unhealthy              | API key invalid OR Linkup endpoint unreachable from the host            | Verify the key with a manual `curl` against the documented endpoint and confirm outbound HTTPS is allowed by the firewall                                 |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/linkup-plugin build
pnpm --filter @ever-works/linkup-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Linkup homepage](https://linkup.so)

## License

AGPL-3.0
