# @ever-works/valyu-plugin

Valyu Plugin - Web search and content extraction using Valyu API

## Plugin metadata

| Field        | Value                         |
| ------------ | ----------------------------- |
| ID           | `valyu`                       |
| Category     | `search`                      |
| Capabilities | `search`, `content-extractor` |
| Author       | Ever Works Team               |
| License      | MIT                           |
| Built-in     | yes                           |
| Auto-enable  | no                            |

## What does Valyu do?

Valyu is an AI-native search and content extraction service that searches across web and proprietary data sources. It returns results optimized for AI applications and RAG pipelines, providing the source material that Ever Works uses to generate accurate work items.

## Why use it?

- **Multi-source search** — search across web, proprietary datasets (arXiv, PubMed, financial data), and news
- **AI-optimized results** — returns content formatted for AI processing with relevance scoring
- **Content extraction** — pulls clean text and markdown from web pages
- **Domain filtering** — include or exclude specific websites from search results
- **Date filtering** — restrict results to specific time periods

## How it works in Ever Works

During work generation, the search facade uses Valyu to find information about each item, discover relevant source URLs, and extract content from web pages. This powers automatic descriptions, source URL resolution, and content enrichment across the generation pipeline.

## Getting started

1. Create an account at [valyu.ai](https://valyu.ai)
2. Copy your API key from the Valyu dashboard
3. Enter the key in the **API Key** field below
4. Valyu will be used during work generation when selected as the search provider

## Settings

- **API Key** (`apiKey`) — required, secret. Your Valyu API key (also configurable via the `PLUGIN_VALYU_API_KEY` environment variable).
- **Response Length** (`responseLength`) — optional, one of `short` (~25k chars), `medium` (~50k, default), `large` (~100k), or `max` (unlimited). Controls content volume per result.
- API key is stored at user scope so each user can supply their own credentials.
- Configuration mode is `hybrid` — admins can preset values and users may override them.

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/valyu-plugin build
pnpm --filter @ever-works/valyu-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Valyu homepage](https://valyu.ai)

## License

MIT
