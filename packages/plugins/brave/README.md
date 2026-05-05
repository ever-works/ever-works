# @ever-works/brave-plugin

Brave Plugin - Privacy-focused web search using Brave Search API

## Plugin metadata

| Field         | Value                                                  |
| ------------- | ------------------------------------------------------ |
| ID            | `brave`                                                |
| Category      | `search`                                               |
| Capabilities  | `search`                                               |
| Author        | Ever Works Team                                        |
| License       | MIT                                                    |
| Built-in      | yes                                                    |
| Auto-enable   | no                                                     |

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

MIT
