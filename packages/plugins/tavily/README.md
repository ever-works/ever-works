# @ever-works/tavily-plugin

Tavily Plugin - Web search and content extraction using Tavily API

## Plugin metadata

| Field        | Value                         |
| ------------ | ----------------------------- |
| ID           | `tavily`                      |
| Category     | `search`                      |
| Capabilities | `search`, `content-extractor` |
| Author       | Ever Works Team               |
| License      | AGPL-3.0                           |
| Built-in     | yes                           |
| Auto-enable  | yes                           |

## What does Tavily do?

Tavily is a search and content extraction service designed for AI applications. It searches the web for relevant results and extracts clean, structured content from web pages, providing the source material that Ever Works uses to generate accurate work items.

## Why use it?

- **AI-optimized search** — returns results formatted for AI processing, not just links
- **Content extraction** — pulls clean text from web pages, removing ads and navigation elements
- **Configurable depth** — choose basic search for speed or advanced search for thoroughness
- **Domain filtering** — include or exclude specific websites from search results

## How it works in Ever Works

During work generation, the search facade uses Tavily to find information about each item, discover relevant source URLs, and extract content from web pages. This powers automatic descriptions, source URL resolution, and content enrichment across the generation pipeline.

## Getting started

1. Create an account at [tavily.com](https://tavily.com)
2. Copy your API key from the Tavily dashboard
3. Enter the key in the **API Key** field below
4. Tavily will be used automatically during work generation

## Settings

- **API Key** — Your Tavily API key (secret, scoped per user, also configurable via `PLUGIN_TAVILY_API_KEY`).

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/tavily-plugin build
pnpm --filter @ever-works/tavily-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Tavily homepage](https://tavily.com)

## License

AGPL-3.0
