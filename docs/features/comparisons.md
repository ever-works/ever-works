---
id: comparisons
title: Comparisons
sidebar_label: Comparisons
sidebar_position: 7
---

# Comparisons

Comparisons auto-generate SEO-optimized "A vs B" comparison pages between items in a directory. Each comparison includes structured dimension-by-dimension scoring, a verdict, a full markdown article, and optional extended deep-dive analysis.

:::tip When to use this
Enable comparisons on directories where users naturally compare alternatives — e.g., "Best CI/CD Tools" or "Top Design Platforms".
:::

## Prerequisites

- Directory must have completed at least one generation (items must exist)
- At least one **AI provider** plugin must be active
- At least one **search** plugin must be active (for web research)
- Minimum of 3 items (configurable) in a category before pairs are generated

## How It Works

1. **Pair selection** — analyzes items within each category, picks the best un-compared pair. Featured items are prioritized. Previously generated pairs are tracked and skipped.
2. **Web research** — searches the web using configured search plugins for comparison-relevant content (e.g., "Vercel vs Netlify"), extracts page content from top results.
3. **Structured generation (Pass 1)** — sends the research and item data to the AI provider to produce a structured JSON comparison: title, summary, verdict, verdict_winner, and 3–8 scored dimensions.
4. **Article generation (Pass 2)** — sends the structured data back to the AI to produce a full markdown article with introduction, feature table, dimension analysis, pros/cons, verdict, and sources.
5. **Extended analysis (optional Pass 3)** — if enabled, generates a deeper 7-section analysis covering feature breakdown, use-case analysis, migration considerations, technical deep-dive, cost analysis, ecosystem, and future outlook.
6. **Storage and commit** — writes comparison YAML, markdown, and optional extended markdown to the data repository, then commits and pushes with a descriptive message.

### Pair Selection Algorithm

Items are grouped by their primary category. Within each category, items are sorted by selection priority:

| Priority | Criteria             |
| -------- | -------------------- |
| 1        | Featured items first |
| 2        | Lower `order` value  |
| 3        | Alphabetical by name |

All C(n,2) pairs are generated from the sorted list. Previously generated pairs are skipped. The pair key is order-independent — `netlify--vercel` is the same pair regardless of which item is A or B.

### Comparison Data Model

Each comparison produces a `ComparisonData` object:

| Field            | Type   | Description                                 |
| ---------------- | ------ | ------------------------------------------- |
| `id` / `slug`    | string | Canonical pair key, e.g., `netlify--vercel` |
| `title`          | string | SEO-optimized comparison title              |
| `item_a_slug`    | string | Slug of the first item                      |
| `item_b_slug`    | string | Slug of the second item                     |
| `item_a_name`    | string | Display name of item A                      |
| `item_b_name`    | string | Display name of item B                      |
| `category`       | string | Shared category                             |
| `summary`        | string | 2–3 sentence overview                       |
| `verdict`        | string | AI recommendation (2–4 sentences)           |
| `verdict_winner` | string | `item_a`, `item_b`, or `tie`                |
| `dimensions`     | array  | 3–8 scored comparison dimensions            |
| `sources`        | array  | URLs used during research                   |
| `generated_at`   | string | ISO 8601 timestamp                          |

Each entry in `dimensions` follows this shape:

| Field            | Type   | Description                          |
| ---------------- | ------ | ------------------------------------ |
| `name`           | string | Dimension name (e.g., "Performance") |
| `item_a_summary` | string | Summary for item A                   |
| `item_b_summary` | string | Summary for item B                   |
| `item_a_score`   | number | Score 1–10                           |
| `item_b_score`   | number | Score 1–10                           |
| `winner`         | string | `item_a`, `item_b`, or `tie`         |

## Enabling Comparisons

Comparisons are configured at two levels:

### 1. Directory Form Fields

These fields appear on the directory generator settings form (provided by the Comparison Generator plugin's form schema):

| Field                 | Type    | Default         | Description                                             |
| --------------------- | ------- | --------------- | ------------------------------------------------------- |
| `comparison_enabled`  | boolean | `false`         | Master switch for comparisons                           |
| `comparison_cadence`  | select  | `use_directory` | Cadence: Use Directory Schedule, Daily, Weekly, Monthly |
| `comparison_max_mode` | select  | `custom`        | Custom Limit or All Pairs                               |
| `comparison_max`      | number  | `50`            | Max comparisons (1–500, only shown in Custom mode)      |

### 2. Plugin Settings

The **Comparison Generator** plugin (`comparison-generator`) provides additional configuration. See [Built-in Plugins](/plugin-system/built-in-plugins#comparison-generator) for the full settings table.

| Setting                    | Type    | Default         | Description                                            |
| -------------------------- | ------- | --------------- | ------------------------------------------------------ |
| `cadence_override`         | string  | `use_directory` | `use_directory`, `daily`, `weekly`, `monthly`          |
| `max_comparisons_mode`     | string  | `custom`        | `custom` or `unlimited`                                |
| `max_comparisons`          | number  | `50`            | Max total comparisons (1–500)                          |
| `min_items_for_comparison` | number  | `3`             | Min items in category before generating (2–20)         |
| `ai_provider`              | string  | —               | Override AI provider for comparison generation         |
| `ai_model`                 | string  | —               | Override AI model for comparison generation            |
| `custom_prompt`            | string  | —               | Additional instructions appended to comparison prompts |
| `extended_analysis`        | boolean | `false`         | Enable 7-section deep-dive extended analysis           |

## Scheduling

A cron job runs every 6 hours for all directories with comparisons enabled. Each run generates one comparison per directory (the next best un-generated pair). Comparisons can also be triggered manually via the API or the dashboard.

## Generate All

The dashboard provides a **Generate All** button that batch-generates every remaining comparison pair for a directory. Under the hood, it calls the single-generation endpoint (`POST /api/directories/:id/comparisons/generate`) in a loop, generating one comparison at a time.

The UI shows a real-time progress bar with the number of completed comparisons out of the total remaining. You can stop generation at any time — the process also stops automatically if there are no more pairs or after 3 consecutive errors.

Before starting, a confirmation dialog shows the number of remaining pairs and warns that the process may take several minutes for directories with many items.

## Model Selection

By default, comparisons use the directory's configured AI provider and model. You can override both on the Comparisons page using the **AI Model** settings panel:

- **Provider** — select any active AI provider plugin (OpenAI, Anthropic, Google, Groq, etc.)
- **Model** — the model dropdown updates dynamically based on the selected provider's available models

These overrides are stored as `ai_provider` and `ai_model` in the Comparison Generator plugin settings and apply only to comparison generation — they do not affect the main directory generation pipeline.

## Extended Analysis

When enabled, each comparison generates an additional deep-dive analysis alongside the standard article. The extended analysis covers 7 sections:

1. **Detailed Feature Breakdown** — granular feature-by-feature comparison
2. **Use-Case Analysis** — which tool fits which scenario
3. **Migration Considerations** — switching costs and effort
4. **Technical Deep-Dive** — architecture, performance, scalability
5. **Cost & Pricing Analysis** — pricing models, tiers, total cost of ownership
6. **Ecosystem & Community** — integrations, community size, support
7. **Future Outlook** — roadmap, trends, long-term viability

Toggle extended analysis on the Comparisons page in the AI Model settings panel, or set `extended_analysis: true` in the plugin settings. The extended markdown is stored as a separate file (`{slug}-extended.md`) in the data repo and returned via the `extendedAnalysisMarkdown` field in the API response.

## Custom Prompt

You can provide custom instructions that are appended to all comparison generation prompts — the structure prompt, article prompt, and extended analysis prompt. Use this to steer the AI's tone, focus areas, or inclusion criteria specific to comparisons.

The custom prompt is managed in the **Advanced Prompts** settings page under the "Comparison" section. Maximum length: 2,000 characters.

Examples:

- "Focus on pricing differences and value for money"
- "Write in a casual, developer-friendly tone"
- "Emphasize open-source vs proprietary trade-offs"

:::note
This is separate from the [Advanced Prompts](./advanced-prompts) that customize the main generation pipeline. The comparison custom prompt only affects comparison generation.
:::

## API

All endpoints require JWT authentication. Base path: `/api/directories/:id/comparisons`.

| Method   | Endpoint                                           | Description                             |
| -------- | -------------------------------------------------- | --------------------------------------- |
| `GET`    | `/api/directories/:id/comparisons`                 | List all comparisons                    |
| `GET`    | `/api/directories/:id/comparisons/remaining-count` | Count remaining un-generated pairs      |
| `GET`    | `/api/directories/:id/comparisons/:slug`           | Get a comparison with markdown          |
| `POST`   | `/api/directories/:id/comparisons/generate`        | Auto-generate next comparison           |
| `POST`   | `/api/directories/:id/comparisons/generate-manual` | Generate comparison for a specific pair |
| `DELETE` | `/api/directories/:id/comparisons/:slug`           | Delete a comparison                     |

### List All Comparisons

```bash
curl http://localhost:3100/api/directories/:id/comparisons \
  -H "Authorization: Bearer <token>"
```

Returns an array of `ComparisonData` objects, sorted by `generated_at` descending.

### Get a Single Comparison

```bash
curl http://localhost:3100/api/directories/:id/comparisons/netlify--vercel \
  -H "Authorization: Bearer <token>"
```

Response:

```json
{
	"comparison": { "slug": "netlify--vercel", "title": "...", "...": "..." },
	"markdown": "## Introduction\n...",
	"extendedAnalysisMarkdown": "## Detailed Feature Breakdown\n..."
}
```

### Get Remaining Count

```bash
curl http://localhost:3100/api/directories/:id/comparisons/remaining-count \
  -H "Authorization: Bearer <token>"
```

Response:

```json
{ "count": 42 }
```

### Auto-Generate Next Comparison

Automatically picks the best un-generated pair and generates a comparison.

```bash
curl -X POST http://localhost:3100/api/directories/:id/comparisons/generate \
  -H "Authorization: Bearer <token>"
```

Response:

```json
{ "status": "success", "slug": "netlify--vercel", "message": "Comparison generated" }
```

Possible `status` values: `success`, `skipped` (no pairs remaining or max reached), `error`.

### Generate a Manual Comparison

Compare two specific items by slug.

```bash
curl -X POST http://localhost:3100/api/directories/:id/comparisons/generate-manual \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"itemASlug": "netlify", "itemBSlug": "vercel"}'
```

Returns `400` if the slugs are the same, if either slug is missing, or if the comparison already exists.

### Delete a Comparison

```bash
curl -X DELETE http://localhost:3100/api/directories/:id/comparisons/netlify--vercel \
  -H "Authorization: Bearer <token>"
```

:::warning
Deleting a comparison removes its YAML, markdown, and extended markdown files from the data repository, updates the comparison state, and pushes the change.
:::

## Data Storage

Comparisons are stored in the data repository under the `comparisons/` directory:

```
comparisons/
  netlify--vercel/
    netlify--vercel.yml              # Structured comparison data
    netlify--vercel.md               # Full markdown article
    netlify--vercel-extended.md      # Extended analysis (if enabled)
```

The `config.yml` metadata tracks comparison state:

```yaml
metadata:
    comparison_state:
        generated_pairs:
            - netlify--vercel
            - figma--sketch
        last_generated_at: '2025-01-15T10:30:00Z'
        total_generated: 2
```

## Related

- [Scheduled Updates](./scheduled-updates) — comparisons can follow the directory schedule
- [Advanced Prompts](./advanced-prompts) — customize AI behavior for pipeline steps
- [Built-in Plugins](/plugin-system/built-in-plugins#comparison-generator) — Comparison Generator plugin settings
- [AI & Generation](/ai-agents/) — pipeline overview
