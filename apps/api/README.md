# Ever Works Backend APIs

Built with NestJS.

## How to run

1. Clone https://github.com/ever-co/ever-works

2. Create `.env` file (based on `.env.example`)

3. Run application using (cd to root of the whole repo, not backend app):

```sh
pnpm dev
```

4. Create a directory object (in memory for now) using a request to `http://localhost:3001/directories`

```json
{
    "slug": "awesome-time-tracking",
    "name": "Awesome Time Tracking",
    "description": "Time Tracking - Software, Methodologies and Practices."
}
```

By default it will create directory with currently authenticated GitHub user as an owner.
If you want to init directory for organization, pass optional `owner` field:

```json
{
    "slug": "awesome-time-tracking",
    "owner": "ever-works",
    "name": "Awesome Time Tracking",
    "description": "Time Tracking - Software, Methodologies and Practices."
}
```

5. Generate GitHub repositories using a request to `http://localhost:3001/generate`

**Basic Request:**

```json
{
    "slug": "awesome-time-tracking",
    "name": "Awesome Time Tracking",
    "prompt": "Generate list of best time tracking software"
}
```

**Advanced Request with All Options:**

```json
{
    "slug": "awesome-time-tracking",
    "name": "Awesome Time Tracking",
    "prompt": "Generate list of best time tracking software for business. Include both open-source and commercial solutions. You can check these URLs for reference: https://github.com/awesome-lists/awesome-time-tracking https://alternativeto.net/category/productivity/time-tracking/",
    "target_keywords": [
        "time tracking",
        "productivity",
        "project management",
        "timesheet",
        "work hours"
    ],
    "source_urls": [
        "https://github.com/awesome-lists/awesome-time-tracking",
        "https://alternativeto.net/category/productivity/time-tracking/"
    ],
    "operation": "create-update",
    "update_with_pull_request": true,
    "config": {
        "max_search_queries": 15,
        "max_results_per_query": 25,
        "max_pages_to_process": 150,
        "relevance_threshold_content": 0.8,
        "min_content_length_for_extraction": 300,
        "ai_first_generation_enabled": true
    }
}
```

**Request Parameters:**

| Field                      | Type     | Required   | Default         | Description                                                                                               |
| -------------------------- | -------- | ---------- | --------------- | --------------------------------------------------------------------------------------------------------- |
| `slug`                     | string   | `required` | -               | Unique identifier for the directory                                                                       |
| `name`                     | string   | `required` | -               | Display name for the directory                                                                            |
| `prompt`                   | string   | `required` | -               | Description/prompt for item generation. URLs mentioned here will be automatically extracted and processed |
| `target_keywords`          | string[] | `optional` | `[]`            | Keywords to focus the search and generation                                                               |
| `source_urls`              | string[] | `optional` | `[]`            | Additional URLs to process for content extraction                                                         |
| `operation`                | enum     | `optional` | `create-update` | Operation type: `create-update` or `recreate` (see Operation Types below)                                 |
| `update_with_pull_request` | boolean  | `optional` | `true`          | Whether to update the repository with a pull request or directly commit the changes to main branch.       |
| `config`                   | object   | `optional` | -               | Advanced configuration options                                                                            |

**Configuration Options:**

| Field                               | Type    | Default | Range    | Description                                         |
| ----------------------------------- | ------- | ------- | -------- | --------------------------------------------------- |
| `max_search_queries`                | number  | 10      | 1-100    | Maximum number of search queries to execute         |
| `max_results_per_query`             | number  | 20      | 1-100    | Maximum results to process per search query         |
| `max_pages_to_process`              | number  | 100     | 1-1000   | Maximum web pages to process for content extraction |
| `relevance_threshold_content`       | number  | 0.75    | 0.01-1.0 | Minimum relevance score for content filtering       |
| `min_content_length_for_extraction` | number  | 300     | 0+       | Minimum content length required for item extraction |
| `ai_first_generation_enabled`       | boolean | true    | -        | Enable AI-first item generation before web search   |

**Operation Types:**

| Operation       | Description                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create-update` | **Default behavior.** Creates a new repository if it doesn't exist, or updates an existing repository by adding new items. Existing items are preserved and new items are deduplicated against them. |
| `recreate`      | **Complete rebuild.** Entirely recreates the repository with fresh data, removing all existing content and replacing it with newly generated items.                                                  |

**Features:**

- **URL Extraction**: URLs mentioned in the prompt are automatically extracted and processed
- **AI-Powered Generation**: Initial items generated using AI before web search
- **Intelligent Search**: Multiple search queries generated from keywords and description
- **Content Filtering**: Relevance assessment and content quality filtering
- **Deduplication**: Advanced deduplication using both field-based and AI-based methods
- **Categorization**: Automatic category and tag generation with consistency across batches
- **Source Validation**: URL validation and fallback search for invalid sources
- **Batch Processing**: Efficient processing with rate limiting and parallel execution
- **Markdown Generation**: Detailed markdown summaries for each item (available via separate endpoint)

> This is a long-running task that may take 5-15 minutes depending on the configuration and number of items processed. The system uses intelligent batching and rate limiting to ensure reliable processing.

6. Deploy to Vercel (optional) using a request to `http://localhost:3001/deploy/awesome-time-tracking/vercel`

```json
// Optional:
{
    "GITHUB_TOKEN": "gh_sqjhqwghsydghsydfgsdyfgdsyf",
    "VERCEL_TOKEN": "e21qwyu2ewgfcuydesgf7udsdsfds"
}
```

> Request body is optional for now, by default it will take values from `.env` during development. Don't forget to change it before going to production, because it will save these tokens inside user's gh actions secrets...

> This endpoint will trigger GitHub Actions Workflow inside website repository. Important thing to note is that we cannot reuse `GITHUB_TOKEN` from github actions workflow because it has short lifetime while our website needs long living github token to make periodically clones, pulls etc.

## Prompt used to generate awesome time tracking in ever works org

```
Please build a directory of time tracking software for business. Split it into 2 categories: open-source and commercial.
```
