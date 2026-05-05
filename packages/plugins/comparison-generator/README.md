# @ever-works/comparison-generator-plugin

Auto-generates SEO-optimized A vs B comparison pages between Work items

## Plugin metadata

| Field        | Value                  |
| ------------ | ---------------------- |
| ID           | `comparison-generator` |
| Category     | `utility`              |
| Capabilities | _(none)_               |
| Author       | Ever Works Team        |
| License      | MIT                    |
| Built-in     | yes                    |
| Auto-enable  | no                     |

## What is the Comparison Generator?

The Comparison Generator is a system plugin that automatically creates detailed A vs B comparison pages between items in your works. Each comparison includes structured dimensions with scores, a verdict, and a full SEO-optimized markdown article.

## How it works

1. **Pair selection** — the plugin analyzes items within each category and picks the most relevant pairs that haven't been compared yet
2. **Research** — gathers information about both items using configured search and content-extraction plugins
3. **Comparison generation** — uses your AI provider to produce a structured comparison with dimensions, scores, and a verdict
4. **Article writing** — generates a full markdown article suitable for publishing as a standalone comparison page

## Features

- **Scheduled generation** — runs automatically based on your work schedule or a custom cadence (daily, weekly, monthly)
- **Manual comparisons** — pick any two items and generate a comparison on demand from the Comparisons tab
- **Dimension scoring** — each comparison breaks down into multiple dimensions with per-item scores and summaries
- **Duplicate prevention** — tracks previously generated pairs so no comparison is repeated
- **Source attribution** — includes references to the sources used during research

## Configuration

Enable comparison generation per work from the work Generator settings. You can configure:

- **Cadence** — how often to auto-generate a new comparison (or follow the work schedule)
- **Max comparisons** — cap at a custom limit (1–500) or set to "All" to generate every possible pair
- **Min items** — minimum items required in a category before comparisons are generated

## Settings

- **Generation Cadence** (`cadence_override`) — how often to auto-generate comparisons. One of `use_work`, `daily`, `weekly`, `monthly`. Defaults to `use_work`.
- **Max Comparisons Mode** (`max_comparisons_mode`) — `custom` to cap at a number, or `unlimited` to generate every possible pair. Defaults to `custom`.
- **Max Comparisons** (`max_comparisons`) — maximum total comparisons to generate when in custom mode (1–500). Defaults to 50.
- **Min Items for Comparison** (`min_items_for_comparison`) — minimum items in a category before generating comparisons (2–20). Defaults to 3.
- **AI Provider / AI Model** (`ai_provider`, `ai_model`, hidden) — optional overrides for the AI provider and model used for comparison generation. Leave empty to use the work defaults.
- **Custom Prompt** (`custom_prompt`, hidden) — additional instructions appended to comparison generation prompts.
- **Extended Analysis** (`extended_analysis`, hidden) — when enabled, generates a deeper analysis alongside the standard comparison. Defaults to `false`.

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/comparison-generator-plugin build
pnpm --filter @ever-works/comparison-generator-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)

## License

MIT
