# @ever-works/notion-extractor-plugin

Notion Page Extractor - Extract content from Notion pages using the Notion API or Splitbee

## Plugin metadata

| Field        | Value               |
| ------------ | ------------------- |
| ID           | `notion-extractor`  |
| Category     | `content-extractor` |
| Capabilities | `content-extractor` |
| Author       | Ever Works Team     |
| License      | AGPL-3.0                 |
| Built-in     | no                  |
| Auto-enable  | no                  |

## What does the Notion Extractor do?

This plugin extracts content from Notion pages and converts it to clean markdown for use as source material during work generation. It supports both public and private Notion pages.

## Why use it?

- **Leverage existing content** — use Notion pages as source material without manual copy-pasting
- **Public and private pages** — extracts published pages out of the box and private pages with an API key
- **Clean markdown output** — preserves headings, formatting, and document structure
- **No API key required for public pages** — public pages are extracted via the Splitbee API at no cost

## How it works in Ever Works

When a source URL points to a Notion page (notion.so or notion.site), the content extractor facade delegates to this plugin instead of the default extractor. It retrieves the page content as structured markdown, which the AI then uses to generate work items during the pipeline.

## Getting started

1. Enable the Notion Extractor plugin on this page
2. For public pages, no additional configuration is required
3. For private pages, create a Notion integration at [notion.so/my-integrations](https://www.notion.so/my-integrations) and enter the API key in the settings below
4. Add Notion page URLs as source material when generating your work

## Settings

- **Notion API Key** (`apiKey`) — optional, secret, user-scoped. Required only for private pages. Leave empty to use the free Splitbee API for public pages.
- **Use Splitbee for public pages** (`useSplitbeeForPublicPages`) — boolean, default `true`. Recommended unless you hit rate limits.
- **Request Timeout** (`timeout`) — number, default `30000` ms. Range 5000–120000 ms.

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/notion-extractor-plugin build
pnpm --filter @ever-works/notion-extractor-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Notion Developers homepage](https://developers.notion.com)

## License

AGPL-3.0
