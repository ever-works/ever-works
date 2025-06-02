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
    "generation_method": "create-update",
    "update_with_pull_request": true,
    "website_repository_creation_method": "duplicate",
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

| Field                                | Type     | Required   | Default         | Description                                                                                               |
| ------------------------------------ | -------- | ---------- | --------------- | --------------------------------------------------------------------------------------------------------- |
| `slug`                               | string   | `required` | -               | Unique identifier for the directory                                                                       |
| `name`                               | string   | `required` | -               | Display name for the directory                                                                            |
| `prompt`                             | string   | `required` | -               | Description/prompt for item generation. URLs mentioned here will be automatically extracted and processed |
| `target_keywords`                    | string[] | `optional` | `[]`            | Keywords to focus the search and generation                                                               |
| `source_urls`                        | string[] | `optional` | `[]`            | Additional URLs to process for content extraction                                                         |
| `generation_method`                  | enum     | `optional` | `create-update` | Generation method: `create-update` or `recreate` (see Generation Methods below)                           |
| `update_with_pull_request`           | boolean  | `optional` | `true`          | Whether to update the repository with a pull request or directly commit the changes to main branch.       |
| `website_repository_creation_method` | enum     | `optional` | `duplicate`     | Method for creating the website repository: `duplicate`, `fork`, or `create-using-template` (see below)   |
| `config`                             | object   | `optional` | -               | Advanced configuration options                                                                            |

**Configuration Options:**

| Field                               | Type    | Default | Range    | Description                                         |
| ----------------------------------- | ------- | ------- | -------- | --------------------------------------------------- |
| `max_search_queries`                | number  | 10      | 1-100    | Maximum number of search queries to execute         |
| `max_results_per_query`             | number  | 20      | 1-100    | Maximum results to process per search query         |
| `max_pages_to_process`              | number  | 100     | 1-1000   | Maximum web pages to process for content extraction |
| `relevance_threshold_content`       | number  | 0.75    | 0.01-1.0 | Minimum relevance score for content filtering       |
| `min_content_length_for_extraction` | number  | 300     | 0+       | Minimum content length required for item extraction |
| `ai_first_generation_enabled`       | boolean | true    | -        | Enable AI-first item generation before web search   |

**Generation Methods:**

| Generation Method | Description                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create-update`   | **Default behavior.** Creates a new repository if it doesn't exist, or updates an existing repository by adding new items. Existing items are preserved and new items are deduplicated against them. |
| `recreate`        | **Complete rebuild.** Entirely recreates the repository with fresh data, removing all existing content and replacing it with newly generated items.                                                  |

**Website Repository Creation Methods:**

| Method                  | Description                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `duplicate`             | **Default behavior.** Creates an independent copy (duplicate) of the template repository. This is a full clone.                             |
| `fork`                  | Creates a fork of the template repository under the specified user or organization. This maintains a link to the original template.         |
| `create-using-template` | Creates a new repository using the template repository as a GitHub template. This initializes the new repository with the template's files. |

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

7. Update website repository (optional) using a request to `http://localhost:3001/update-website/{slug}`

This endpoint updates an existing website repository by pulling the latest changes from the template repository. It automatically detects the original creation method and applies the appropriate update strategy.

**Request:**

```
POST /update-website/awesome-time-tracking
```

**URL Parameters:**

| Parameter | Type   | Required   | Description                                    |
| --------- | ------ | ---------- | ---------------------------------------------- |
| `slug`    | string | `required` | The slug of the directory/repository to update |

**Response:**

```json
{
    "status": "success",
    "slug": "awesome-time-tracking",
    "owner": "ever-works",
    "repository": "ever-works/awesome-time-tracking-website",
    "message": "Successfully updated using duplicate method",
    "method_used": "duplicate"
}
```

**Response Fields:**

| Field           | Type   | Description                                                               |
| --------------- | ------ | ------------------------------------------------------------------------- |
| `status`        | string | Status of the operation: `success` or `error`                             |
| `slug`          | string | The directory slug that was updated                                       |
| `owner`         | string | The GitHub owner (user or organization) of the repository                 |
| `repository`    | string | Full repository name in `owner/repo-name` format                          |
| `message`       | string | Descriptive message about the update operation                            |
| `method_used`   | string | The update method that was successfully used (see Update Methods below)   |
| `error_details` | string | _(Error responses only)_ Additional details about the error that occurred |

**Update Methods:**

The service automatically tries different update strategies in order of preference:

| Method                  | Description                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `fork`                  | **Preferred method.** Pulls latest changes from the upstream template repository. Only works if the repository is actually a fork. |
| `duplicate`             | **Fallback method.** Clones the original template, replaces the remote origin, and pushes to the target repository.                |
| `create-using-template` | **Last resort.** Clones both repositories, copies files from template to target (excluding .git), commits and pushes the changes.  |

**Error Responses:**

```json
{
    "status": "error",
    "slug": "awesome-time-tracking",
    "owner": "",
    "repository": "/awesome-time-tracking-website",
    "message": "Failed to update website repository",
    "error_details": "Directory with slug 'awesome-time-tracking' not found"
}
```

**Prerequisites:**

- The directory must exist (created via `/directories` endpoint)
- The website repository must exist (created via `/generate` endpoint)
- Valid GitHub authentication token in environment

## Prompt used to generate awesome time tracking in ever works org

```
Please build a directory of time tracking software for business. Split it into 2 categories: open-source and commercial.
```
