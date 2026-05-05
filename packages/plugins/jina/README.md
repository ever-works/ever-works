# @ever-works/jina-plugin

Jina AI Plugin - Web search and content extraction using Jina AI APIs

## Plugin metadata

| Field        | Value                         |
| ------------ | ----------------------------- |
| ID           | `jina`                        |
| Category     | `content-extractor`           |
| Capabilities | `search`, `content-extractor` |
| Author       | Ever Works Team               |
| License      | AGPL-3.0                           |
| Built-in     | yes                           |
| Auto-enable  | no                            |

## What does Jina AI do?

Jina AI provides web search with LLM-optimized results and content extraction that converts any web page into clean markdown.

## Why use it?

- **Web search** — search the web and get results with content already extracted
- **Content extraction** — converts pages to clean markdown, strips ads and navigation
- **Domain filtering** — restrict search to specific domains

## How it works in Ever Works

During work generation, Jina finds relevant information about each item via search and extracts clean content from web pages for enriching descriptions.

## Getting started

1. Get an API key at [jina.ai](https://jina.ai)
2. Enter the key in the **API Key** field below
3. Enable the plugin

## Settings

- **API Key** (`apiKey`) — required, secret. Your Jina API key (also configurable via the `PLUGIN_JINA_API_KEY` environment variable).
- Stored at user scope so each user can supply their own credentials.
- Configuration mode is `hybrid` — admins can preset values and users may override them.

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/jina-plugin build
pnpm --filter @ever-works/jina-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Jina AI homepage](https://jina.ai)

## License

AGPL-3.0
