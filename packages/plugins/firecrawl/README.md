# @ever-works/firecrawl-plugin

Firecrawl Plugin - Web search and content extraction using the Firecrawl API

## Plugin metadata

| Field        | Value                         |
| ------------ | ----------------------------- |
| ID           | `firecrawl`                   |
| Category     | `search`                      |
| Capabilities | `search`, `content-extractor` |
| Author       | Ever Works Team               |
| License      | MIT                           |
| Built-in     | yes                           |
| Auto-enable  | no                            |

## What does Firecrawl do?

Firecrawl is a web scraping and search API that can search the web for relevant results and extract clean, well-formatted markdown content from any web page. It handles JavaScript rendering, anti-bot bypasses, and content cleaning automatically.

## Why use it?

- **Web search** — search the web and get structured results with content snippets
- **Clean markdown output** — returns well-structured markdown from any web page
- **JavaScript rendering** — handles dynamic/SPA pages that simple HTTP fetches miss
- **Anti-bot handling** — bypasses common protections automatically
- **Metadata extraction** — captures title, description, and other page metadata

## How it works in Ever Works

When enabled, Firecrawl can be used as both a search provider and content extractor during work generation. It searches the web for relevant information and extracts high-quality content from web pages, including JavaScript-heavy sites.

## Getting started

1. Create an account at [firecrawl.dev](https://firecrawl.dev)
2. Copy your API key from the Firecrawl dashboard
3. Enter the key in the **API Key** field below
4. Enable this plugin to use it for search and content extraction

## Settings

- **API Key** (`apiKey`) — required, secret. Your Firecrawl API key (also configurable via the `PLUGIN_FIRECRAWL_API_KEY` environment variable).
- Stored at user scope so each user can supply their own credentials.
- Configuration mode is `hybrid` — admins can preset values and users may override them.

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/firecrawl-plugin build
pnpm --filter @ever-works/firecrawl-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Firecrawl homepage](https://firecrawl.dev)

## License

MIT
