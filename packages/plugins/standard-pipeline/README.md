# @ever-works/standard-pipeline-plugin

Standard Pipeline Plugin - Provides the standard 15-step generation pipeline.

## Plugin metadata

| Field        | Value                              |
| ------------ | ---------------------------------- |
| ID           | `standard-pipeline`                |
| Category     | `pipeline`                         |
| Capabilities | `pipeline`, `form-schema-provider` |
| Author       | Ever Works Team                    |
| License      | AGPL-3.0                           |
| Built-in     | yes                                |
| Auto-enable  | yes                                |

## What is the Standard Pipeline?

The default engine-orchestrated generation pipeline. It runs 15 sequential steps that combine AI generation, web search, content extraction, and post-processing to build a complete work from a single prompt.

## How it works

The pipeline is organized into 6 phases:

1. **Initialization** — Compares the prompt against previous runs, extracts the subject, and detects the domain type
2. **AI Generation** — Generates an initial set of items using AI based on the prompt and domain analysis
3. **Web Search** — Builds search queries, executes web searches, retrieves page content, and filters for relevance
4. **Extraction** — Extracts structured items from web content and aggregates them with AI-generated items
5. **Enrichment** — Assigns categories, validates sources, generates badges, and captures screenshots
6. **Output** — Generates markdown descriptions for each item

## Features

- **Checkpoint resume** — progress is saved after each step and can be resumed on failure
- **Step-level progress** — reports current step name, index, and percentage to the UI in real time
- **Extensible** — pipeline-modifier plugins can inject, replace, or disable individual steps
- **Provider-agnostic** — works with any AI, search, screenshot, or content-extractor plugin

## Settings

The standard pipeline exposes its tuning surface through form fields rather than `settingsSchema`. Key form options include:

- `source_urls` — explicit URLs to extract items from (bypasses web search).
- `initial_categories`, `priority_categories`, `target_keywords` — taxonomy hints for the AI and search steps.
- `ai_first_generation_enabled`, `generate_categories`, `generate_tags`, `generate_collections`, `generate_brands` — toggle individual generation features.
- `capture_screenshots`, `badge_evaluation_enabled` — enable optional enrichment steps.
- `max_search_queries`, `max_results_per_query`, `max_pages_to_process` — bounds for the web-search phase.
- `data_volume_mode` (`real` / `sample`), `max_items` — overall volume controls.
- `content_filtering_enabled`, `relevance_threshold_content`, `min_content_length_for_extraction`, `prompt_comparison_confidence_threshold` — advanced extraction tuning.

## Troubleshooting

| Symptom                                                           | Likely cause                                                                          | Fix                                                                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generation never starts / stays at `0%`                           | `standard-pipeline` not selected as the active pipeline plugin for this work          | Open the work → **Plugins** → `pipeline` capability and set `standard-pipeline` as the active pipeline; or set it as the global pipeline default in **Settings → Plugins** |
| Step fails with `No AI / search / screenshot provider configured` | Pipeline depends on capability plugins that are not enabled or have no credentials    | Enable and configure the matching capability plugin (AI provider, search, screenshot, content-extractor) for the work or globally                                          |
| Step output looks wrong / generic                                 | Form-field tuning not set; pipeline using defaults that don't match the work's domain | Open the **Generator Form** for the work, set domain-specific fields (categories, target keywords, source URLs), and re-run the affected step                              |
| Pipeline cannot resume after host restart                         | Checkpoint not persisted (only the standard pipeline persists checkpoints today)      | Cancel the stuck run and re-trigger generation; for production reliability prefer `standard-pipeline`                                                                      |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/standard-pipeline-plugin build
pnpm --filter @ever-works/standard-pipeline-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- This plugin implements the `pipeline` capability defined in `@ever-works/plugin`.

## License

AGPL-3.0
