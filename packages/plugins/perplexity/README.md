# @ever-works/perplexity-plugin

Perplexity Plugin - AI-powered web search with citations

## Plugin metadata

| Field        | Value           |
| ------------ | --------------- |
| ID           | `perplexity`    |
| Category     | `search`        |
| Capabilities | `search`        |
| Author       | Ever Works Team |
| License      | AGPL-3.0        |
| Built-in     | yes             |
| Auto-enable  | no              |

## What does Perplexity do?

Perplexity is an AI-powered search API that returns web search results enriched with citations and AI-generated context. It understands natural language queries and provides highly relevant results.

## Why use it?

- **AI-powered search** — understands intent, not just keywords
- **Citations included** — every result comes with source attribution
- **Domain filtering** — include or exclude specific domains
- **Recency filtering** — restrict results to recent time periods (day, week, month)

## How it works in Ever Works

When enabled as the active search provider, Perplexity is used during work generation to find relevant information about each item. Its AI-powered understanding produces more contextually relevant results than traditional keyword search.

## Getting started

1. Create an account at [perplexity.ai](https://perplexity.ai)
2. Get your API key from [perplexity.ai/account/api](https://perplexity.ai/account/api)
3. Enter the key in the **API Key** field below
4. Enable this plugin to use it for work generation

## Settings

- **API Key** — Your Perplexity API key (secret, scoped per user, also configurable via `PLUGIN_PERPLEXITY_API_KEY`).

## Troubleshooting

| Symptom                                      | Likely cause                                                            | Fix                                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `401 Unauthorized` / `Authentication failed` | API key missing, revoked, or wrong key entered                          | Re-enter the **API Key** from the Perplexity dashboard, or set `PLUGIN_PERPLEXITY_API_KEY` in the host environment for default fallback |
| `429 Too Many Requests`                      | Free-tier or paid quota exhausted on Perplexity                         | Throttle calls, wait for the quota reset, or upgrade the plan in the Perplexity dashboard                                               |
| Empty / sparse results                       | Query is too restrictive, time-range or domain filters are too narrow   | Broaden the query, relax `time_range` / `safesearch` / `include_domains` / `exclude_domains` filters, or raise `max_results`            |
| Plugin not used during work generation       | Another search plugin is set as the default for the `search` capability | In **Settings → Plugins**, set `perplexity` as the default for `search`, or disable competing search plugins                            |
| `healthCheck` reports unhealthy              | API key invalid OR Perplexity endpoint unreachable from the host        | Verify the key with a manual `curl` against the documented endpoint and confirm outbound HTTPS is allowed by the firewall               |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/perplexity-plugin build
pnpm --filter @ever-works/perplexity-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Perplexity homepage](https://perplexity.ai)

## License

AGPL-3.0
