# @ever-works/serpapi-plugin

SerpAPI Plugin - Web search using SerpAPI (Google, Bing, Yahoo, and more)

## Plugin metadata

| Field         | Value                                                  |
| ------------- | ------------------------------------------------------ |
| ID            | `serpapi`                                              |
| Category      | `search`                                               |
| Capabilities  | `search`                                               |
| Author        | Ever Works Team                                        |
| License       | MIT                                                    |
| Built-in      | yes                                                    |
| Auto-enable   | no                                                     |

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

MIT
