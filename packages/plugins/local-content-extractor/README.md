# @ever-works/local-content-extractor-plugin

Local Content Extractor - System plugin for extracting web page content using axios + Readability

## Plugin metadata

| Field        | Value                              |
| ------------ | ---------------------------------- |
| ID           | `local-content-extractor`          |
| Category     | `content-extractor`                |
| Capabilities | `content-extractor`                |
| Author       | Ever Works Team                    |
| License      | MIT                                |
| Built-in     | yes                                |
| Auto-enable  | yes                                |

## What does the local content extractor plugin do?

This is the default content-extractor plugin in Ever Works. It runs entirely in-process — no external API or paid service needed — and uses lightweight HTML parsing to pull the main article text, title, and metadata from a fetched URL.

Under the hood it combines `axios` for HTTP fetching, `linkedom` for HTML parsing, Mozilla's `@mozilla/readability` for article detection, and `turndown` to convert the cleaned HTML into markdown. The plugin also extracts page metadata (Open Graph, Twitter cards, canonical URL, favicon), images, and outbound links.

## Why use it?

- Zero configuration and no API key required
- Zero per-extraction cost — runs locally in your own process
- Works offline and on-prem with no third-party dependencies at runtime
- Good baseline accuracy for most public web pages with a real text layer

## How it works in Ever Works

When items in a Work need their content enriched, the platform calls the active content-extractor plugin to turn each URL into structured text. `local-content-extractor` is the default fallback so the platform always works out of the box, even before you connect a paid provider like Scrapfly or a domain-specific extractor like Notion or PDF.

## When to switch

If you need JavaScript-rendered pages, paywalled content, anti-bot bypass, headless-browser behavior, or higher accuracy on tricky sites, switch the active plugin to `scrapfly`, `notion-extractor`, or `pdf-extractor` for those source types.

## Settings

This plugin has no required settings. A few internal tuning knobs (`timeout`, `minContentLength`, `userAgent`) are exposed in the schema but are hidden from the UI and use sensible defaults.

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/local-content-extractor-plugin build
pnpm --filter @ever-works/local-content-extractor-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)

## License

MIT
