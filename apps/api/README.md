# Ever Works Backend APIs

Built with NestJS.

## Table of Contents

- [Setup & Run](#how-to-run)
    - [1. Clone the repository](#1-clone-the-repository)
    - [2. Create `.env` file](#2-create-env-file)
    - [3. Run application using (cd to root of the whole repo, not backend app)](#3-run-application-using-cd-to-root-of-the-whole-repo-not-backend-app)

- [API Endpoints](#api-endpoints)
    - [1. Create a work object](#4-create-a-work-object)
    - [2. Generate data and GitHub repositories](#5-generate-data-and-github-repositories)
    - [3. Update Work](#6-update-work)
    - [4. Regenerate Markdown](#7-regenerate-markdown)
    - [5. Submit Individual Items](#8-submit-individual-items)
    - [6. Remove Individual Items](#9-remove-individual-items)
    - [7. Extract Item Details](#10-extract-item-details)
    - [8. Update website repository](#11-update-website-repository)
    - [9. Deploy to Vercel](#12-deploy-to-vercel)

- [Examples](#examples)
    - [Example Prompt used to generate awesome time tracking in ever works org](#example-prompt-used-to-generate-awesome-time-tracking-in-ever-works-org)

## How to run

### 1. Clone the repository

Make sure you have [pnpm](https://pnpm.io/) installed, then clone the repository:

```sh
git clone https://github.com/ever-works/ever-works.git
```

Navigate to the `apps/api` work:

```sh
cd ever-works/apps/api
```

Install the dependencies:

```sh
pnpm install
```

### 2. Create `.env` file

Navigate to the `apps/api` work and create a `.env` file. You can use the example file as a starting point:

```shell
cp .env.example .env
```

> Make sure to fill in the required environment variables in the `.env` file.

### 3. Run application:

```sh
pnpm start
```

The application will start running on `http://localhost:3100`.

### 4. Create a work object

To create a new work object, send a POST request to `http://localhost:3100/api/api/works` with the following JSON body:

```json
{
    "slug": "awesome-time-tracking",
    "name": "Awesome Time Tracking",
    "description": "Time Tracking - Software, Methodologies and Practices.",
    "readmeConfig": {
        "header": "This text will be used as additional header in the README.md file",
        "overwriteDefaultHeader": false,

        "footer": "This text will be used as additional footer in the README.md file",
        "overwriteDefaultFooter": false
    }
}
```

**Overwrite default header and footer**
If you want to overwrite the default header and footer in the README.md file, set `overwriteDefaultHeader` and `overwriteDefaultFooter` to `true`. This will replace the default content with your custom text.

**Request Parameters:**
By default, the work will be created with the currently authenticated GitHub user as the owner.

If you want to initialize the work within an organization, provide the optional `owner` field:

```json
{
    "slug": "awesome-time-tracking",
    "owner": "ever-works",
    "name": "Awesome Time Tracking",
    "description": "Time Tracking - Software, Methodologies and Practices."
}
```

### 5. Generate data and GitHub repositories

To generate data and create a GitHub repository for the work, send a POST request to `http://localhost:3100/api/works/{id}/generate` with the following JSON body.

**URL Parameters:**

| Parameter | Type   | Required   | Description        |
| --------- | ------ | ---------- | ------------------ |
| `id`      | string | `required` | The ID of the work |

**Request Body:**

**Basic Request:**

```json
{
    "name": "Awesome Time Tracking",
    "prompt": "Generate list of best time tracking software"
}
```

**Advanced Request with All Options:**

```json
{
    "name": "Awesome Time Tracking",
    "prompt": "Generate list of best time tracking software for business. Start with Open Source projects first, then prioritize Commercial solutions. Include both open-source and commercial solutions. You can check these URLs for reference: https://github.com/awesome-lists/awesome-time-tracking https://alternativeto.net/category/productivity/time-tracking/",
    "company": {
        "name": "Acme Corporation",
        "website": "https://acme.com"
    },
    "target_keywords": [
        "time tracking",
        "productivity",
        "project management",
        "timesheet",
        "work hours"
    ],
    "initial_categories": ["Open Source", "Commercial"],
    "priority_categories": ["Enterprise", "SaaS"],
    "source_urls": [
        "https://github.com/awesome-lists/awesome-time-tracking",
        "https://alternativeto.net/category/productivity/time-tracking/"
    ],
    "generation_method": "create-update",
    "update_with_pull_request": true,
    "badge_evaluation_enabled": false,
    "website_repository_creation_method": "create-using-template",
    "config": {
        "max_search_queries": 10,
        "max_results_per_query": 25,
        "max_pages_to_process": 10,
        "relevance_threshold_content": 0.5,
        "min_content_length_for_extraction": 300,
        "prompt_comparison_confidence_threshold": 0.5,
        "content_filtering_enabled": false,
        "ai_first_generation_enabled": true
    }
}
```

**Request Parameters:**

| Field                                | Type     | Required   | Default                 | Description                                                                                               |
| ------------------------------------ | -------- | ---------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `name`                               | string   | `required` | -                       | Display name for the work                                                                                 |
| `prompt`                             | string   | `required` | -                       | Description/prompt for item generation. URLs mentioned here will be automatically extracted and processed |
| `company`                            | object   | `optional` | -                       | Company information (see Company Object below)                                                            |
| `target_keywords`                    | string[] | `optional` | `[]`                    | Keywords to focus the search and generation                                                               |
| `initial_categories`                 | string[] | `optional` | `[]`                    | Initial categories to assign to generated items                                                           |
| `priority_categories`                | string[] | `optional` | `[]`                    | Categories that should appear first in the final output (can also be extracted from prompt)               |
| `source_urls`                        | string[] | `optional` | `[]`                    | Additional URLs to process for content extraction                                                         |
| `generation_method`                  | enum     | `optional` | `create-update`         | Generation method: `create-update` or `recreate` (see Generation Methods below)                           |
| `update_with_pull_request`           | boolean  | `optional` | `true`                  | Whether to update the repository with a pull request or directly commit the changes to main branch.       |
| `website_repository_creation_method` | enum     | `optional` | `create-using-template` | Method for creating the website repository: `duplicate` or `create-using-template` (see below)            |
| `badge_evaluation_enabled`           | boolean  | `optional` | `false`                 | Whether to evaluate badges for the generated items                                                        |
| `config`                             | object   | `optional` | -                       | Advanced configuration options                                                                            |

**Company Object:**

| Field     | Type   | Required                           | Description                                                                                 |
| --------- | ------ | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `name`    | string | `required` (when company provided) | Company name that will be written to .works/works.yml                                       |
| `website` | string | `required` (when company provided) | Company website URL (must be valid HTTP/HTTPS URL) that will be written to .works/works.yml |

**Configuration Options:**

| Field                                    | Type    | Default    | Range    | Description                                                                                       |
| ---------------------------------------- | ------- | ---------- | -------- | ------------------------------------------------------------------------------------------------- |
| `max_search_queries`                     | number  | 10         | 1-100    | Maximum number of search queries to execute                                                       |
| `max_results_per_query`                  | number  | 10         | 1-100    | Maximum results to process per search query                                                       |
| `max_pages_to_process`                   | number  | 10         | 1-1000   | Maximum web pages to process for content extraction                                               |
| `relevance_threshold_content`            | number  | 0.5        | 0.01-1.0 | Minimum relevance score for content filtering                                                     |
| `min_content_length_for_extraction`      | number  | 300        | 0+       | Minimum content length required for item extraction                                               |
| `content_filtering_enabled`              | boolean | `optional` | `true`   | Whether to enable content filtering based on relevance and quality                                |
| `ai_first_generation_enabled`            | boolean | true       | -        | Enable AI-first item generation before web search                                                 |
| `prompt_comparison_confidence_threshold` | number  | 0.5        | 0.01-1.0 | Minimum confidence score for prompt comparison (used when `generation_method` is `create-update`) |

**Generation Methods:**

| Generation Method | Description                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create-update`   | **Default behavior.** Creates a new repository if it doesn't exist, or updates an existing repository by adding new items. Existing items are preserved and new items are deduplicated against them. |
| `recreate`        | **Complete rebuild.** Entirely recreates the repository with fresh data, removing all existing content and replacing it with newly generated items.                                                  |

**Website Repository Creation Methods:**

| Method                  | Description                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `duplicate`             | **Default behavior.** Creates an independent copy (duplicate) of the template repository. This is a full clone.                             |
| `create-using-template` | Creates a new repository using the template repository as a GitHub template. This initializes the new repository with the template's files. |

**Features:**

- **URL Extraction**: URLs mentioned in the prompt are automatically extracted and processed
- **AI-Powered Generation**: Initial items generated using AI before web search
- **Intelligent Search**: Multiple search queries generated from keywords and description
- **Content Filtering**: Relevance assessment and content quality filtering
- **Deduplication**: Advanced deduplication using both field-based and AI-based methods
- **Categorization**: Automatic category and tag generation with consistency across batches
- **Priority Categories**: Categories can be prioritized to appear first in the final output
- **Smart Category Extraction**: Priority categories can be extracted from natural language prompts
- **Source Validation**: URL validation and fallback search for invalid sources
- **Badge Evaluation**: Optional badge evaluation for generated items
- **Batch Processing**: Efficient processing with rate limiting and parallel execution
- **Markdown Generation**: Detailed markdown summaries for each item (available via separate endpoint)

> This is a long-running task that may take 5-15 minutes depending on the configuration and number of items processed. The system uses intelligent batching and rate limiting to ensure reliable processing.

### 6. Update Work

This streamlines the process of updating an existing work without requiring a request body, in contrast to the behavior of the `/generate` endpoint.

**Endpoint:**

```
POST /api/works/{id}/update
```

**Request Body (Optional):**

```json
{
    "generation_method": "create-update",
    "update_with_pull_request": true
}
```

**Response:**

```json
{
    "status": "pending",
    "slug": "awesome-time-tracking",
    "parameters": {...},
    "message": "Processing update for 'Awesome Time Tracking'. Check logs or data folder for updates."
}
```

**URL Parameters:**

| Parameter | Type   | Required   | Description                  |
| --------- | ------ | ---------- | ---------------------------- |
| `id`      | string | `required` | The ID of the work to update |

**POST Request Body Parameters:**

| Field                      | Type    | Required   | Description                                                                                                           |
| -------------------------- | ------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `generation_method`        | enum    | `optional` | Generation method: `create-update` or `recreate` (default: `create-update`)                                           |
| `update_with_pull_request` | boolean | `optional` | Whether to update the repository with a pull request or directly commit the changes to main branch. (default: `true`) |

### 7. Regenerate Markdown

To regenerate the README markdown file for a GitHub repository, send a POST request to `http://localhost:3100/api/works/{id}/regenerate-markdown`.

**Endpoint:**

```POST /api/works/{id}/regenerate-markdown

```

**URL Parameters:**

| Parameter | Type   | Required   | Description                  |
| --------- | ------ | ---------- | ---------------------------- |
| `id`      | string | `required` | The ID of the work to update |

**Response:**

```json
{
    "status": "success"
}
```

### 8. Submit Individual Items

To submit individual items to an existing work, send a POST request to `http://localhost:3100/api/works/{id}/submit-item` with the item details.

**Endpoint:**

```
POST /api/works/{id}/submit-item
```

**URL Parameters:**

| Parameter | Type   | Required   | Description                              |
| --------- | ------ | ---------- | ---------------------------------------- |
| `id`      | string | `required` | The ID of the work to submit the item to |

**Request Body:**

```json
{
    "name": "Awesome Tool",
    "description": "A really useful development tool",
    "source_url": "https://github.com/example/awesome-tool",
    "category": "Development Tools",
    "tags": ["productivity", "open-source"],
    "featured": false,
    "pay_and_publish_now": false
}
```

**Request Parameters:**

| Field                 | Type     | Required   | Description                                                         |
| --------------------- | -------- | ---------- | ------------------------------------------------------------------- |
| `name`                | string   | `required` | Item name                                                           |
| `description`         | string   | `required` | Item description                                                    |
| `source_url`          | string   | `required` | Valid HTTP/HTTPS URL for the item                                   |
| `category`            | string   | `required` | Category name for the item                                          |
| `tags`                | string[] | `optional` | Array of tag strings                                                |
| `featured`            | boolean  | `optional` | Whether item should be featured (default: false)                    |
| `pay_and_publish_now` | boolean  | `optional` | Force auto-merge regardless of config (default: false)              |
| `slug`                | string   | `optional` | Custom slug for the item (auto-generated from name if not provided) |

**Response:**

```json
{
    "status": "success",
    "slug": "awesome-time-tracking",
    "item_name": "Awesome Tool",
    "message": "Item \"Awesome Tool\" has been submitted for review. PR #42 created.",
    "pr_number": 42,
    "pr_url": "https://github.com/owner/repo-data/pull/42",
    "branch_name": "feature-1640995200000-abc123",
    "auto_merged": false
}
```

**Response Fields:**

| Field         | Type    | Description                                               |
| ------------- | ------- | --------------------------------------------------------- |
| `status`      | string  | Status of the operation: `success`, `error`, or `pending` |
| `slug`        | string  | Work slug                                                 |
| `item_name`   | string  | Name of the submitted item                                |
| `message`     | string  | Status message                                            |
| `pr_number`   | number  | _(Success only)_ GitHub PR number if created              |
| `pr_url`      | string  | _(Success only)_ GitHub PR URL if created                 |
| `branch_name` | string  | _(Success only)_ Git branch name if created               |
| `auto_merged` | boolean | _(Success only)_ Whether the PR was automatically merged  |

**Auto-Merge Behavior:**

The PR will be automatically merged if either:

1. `pay_and_publish_now` is set to `true` in the request
2. `autoapproval` is set to `true` in the repository's .works/works.yml

Otherwise, the PR will be created and require manual review.

**Example with Immediate Publishing:**

```bash
curl -X POST http://localhost:3100/api/works/{work-id}/submit-item \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Premium Tool",
    "description": "A premium development tool",
    "source_url": "https://example.com/premium-tool",
    "category": "Development Tools",
    "tags": ["premium", "enterprise"],
    "featured": true,
    "pay_and_publish_now": true
  }'
```

**Process Flow:**

1. **Validation**: Request body is validated
2. **Repository Access**: Data repository is cloned/pulled
3. **Config Check**: Repository config is checked for autoapproval settings
4. **Branch Creation**: New feature branch is created
5. **Content Generation**: AI generates markdown content for the item
6. **File Creation**: Item YAML and markdown files are created
7. **Commit & Push**: Changes are committed and pushed
8. **PR Creation**: Pull request is created
9. **Auto-Merge** (conditional): PR is merged if auto-merge conditions are met

### 9. Remove Individual Items

To remove individual items from an existing work, send a POST request to `http://localhost:3100/api/works/{id}/remove-item` with the item details.

**Endpoint:**

```
POST /api/works/{id}/remove-item
```

**URL Parameters:**

| Parameter | Type   | Required   | Description                                |
| --------- | ------ | ---------- | ------------------------------------------ |
| `id`      | string | `required` | The ID of the work to remove the item from |

**Request Body:**

```json
{
    "item_slug": "awesome-tool",
    "reason": "Item is no longer maintained",
    "pay_and_publish_now": false
}
```

**Request Parameters:**

| Field                 | Type    | Required   | Description                                                       |
| --------------------- | ------- | ---------- | ----------------------------------------------------------------- |
| `item_slug`           | string  | `required` | The slug of the item to remove                                    |
| `reason`              | string  | `optional` | Reason for removing the item (will be included in commit message) |
| `pay_and_publish_now` | boolean | `optional` | Force auto-merge regardless of config (default: false)            |

**Response:**

```json
{
    "status": "success",
    "slug": "awesome-time-tracking",
    "item_name": "Awesome Tool",
    "item_slug": "awesome-tool",
    "message": "Item \"Awesome Tool\" removal has been submitted for review. PR #43 created.",
    "pr_number": 43,
    "pr_url": "https://github.com/owner/repo-data/pull/43",
    "branch_name": "feature-1640995200000-def456",
    "auto_merged": false
}
```

**Response Fields:**

| Field         | Type   | Description                                               |
| ------------- | ------ | --------------------------------------------------------- |
| `status`      | string | Status of the operation: `success`, `error`, or `pending` |
| `slug`        | string | Work slug                                                 |
| `item_name`   | string | Name of the removed item                                  |
| `item_slug`   | string | Slug of the removed item                                  |
| `message`     | string | Status message                                            |
| `pr_number`   | number | _(Success only)_ GitHub PR number if created              |
| `pr_url`      | string | _(Success only)_ GitHub PR URL if created                 |
| `branch_name` | string | _(Success only)_ Git branch name if created               |

**Example with Immediate Publishing:**

```bash
curl -X POST http://localhost:3100/api/works/{work-id}/remove-item \
  -H "Content-Type: application/json" \
  -d '{
    "item_slug": "outdated-tool",
    "reason": "Tool is no longer maintained and has security vulnerabilities"
  }'
```

### 10. Extract Item Details

To extract item details from a single URL without adding it to any work, send a POST request to `http://localhost:3100/api/extract-item-details` with the URL and optional existing categories.

**Endpoint:**

```
POST /api/extract-item-details
```

**Request Body:**

```json
{
    "source_url": "https://github.com/example/awesome-tool",
    "existing_categories": ["Development Tools", "Open Source", "Productivity"]
}
```

**Request Parameters:**

| Field                 | Type     | Required   | Description                                                                                   |
| --------------------- | -------- | ---------- | --------------------------------------------------------------------------------------------- |
| `source_url`          | string   | `required` | Valid HTTP/HTTPS URL to extract item details from                                             |
| `existing_categories` | string[] | `optional` | Array of existing categories to consider when categorizing the extracted item (default: `[]`) |

**Response:**

```json
{
    "status": "success",
    "source_url": "https://github.com/example/awesome-tool",
    "item": {
        "name": "Awesome Tool",
        "description": "A comprehensive development tool that enhances productivity",
        "featured": false,
        "source_url": "https://github.com/example/awesome-tool",
        "category": "Development Tools",
        "slug": "awesome-tool",
        "tags": ["productivity", "development", "open-source"],
        "markdown": "# Awesome Tool\n\nA comprehensive development tool...",
        "badges": {
            "security": {
                "type": "security",
                "value": "A",
                "evaluated_at": "2024-01-15T10:30:00Z",
                "details": "No known security vulnerabilities"
            },
            "license": {
                "type": "license",
                "value": "A",
                "evaluated_at": "2024-01-15T10:30:00Z",
                "details": "MIT License - permissive"
            },
            "quality": {
                "type": "quality",
                "value": "A",
                "evaluated_at": "2024-01-15T10:30:00Z",
                "details": "Active development, good documentation"
            }
        }
    },
    "message": "Successfully extracted item details: \"Awesome Tool\""
}
```

**Response Fields:**

| Field        | Type     | Description                                                    |
| ------------ | -------- | -------------------------------------------------------------- |
| `status`     | string   | Status of the operation: `success` or `error`                  |
| `source_url` | string   | The URL that was processed                                     |
| `item`       | ItemData | _(Success only)_ Complete item data with all extracted details |
| `message`    | string   | Status message                                                 |

**ItemData Fields:**

| Field         | Type        | Description                                                                |
| ------------- | ----------- | -------------------------------------------------------------------------- |
| `name`        | string      | Extracted item name                                                        |
| `description` | string      | Extracted item description                                                 |
| `featured`    | boolean     | Always `false` for extracted items                                         |
| `source_url`  | string      | The source URL (same as input)                                             |
| `category`    | string      | Extracted or assigned category (considers existing_categories if provided) |
| `slug`        | string      | Auto-generated URL-friendly slug                                           |
| `tags`        | string[]    | Array of extracted tags/keywords                                           |
| `markdown`    | string      | AI-generated markdown content for the item                                 |
| `badges`      | ItemBadges? | Optional badges evaluation (for repository URLs)                           |

**Example Usage:**

```bash
curl -X POST http://localhost:3100/api/extract-item-details \
  -H "Content-Type: application/json" \
  -d '{
    "source_url": "https://github.com/microsoft/vscode",
    "existing_categories": ["Editors", "Development Tools", "Open Source"]
  }'
```

**Process Flow:**

1. **URL Validation**: Source URL is validated for proper format
2. **Content Retrieval**: Web page content is fetched using Tavily API
3. **AI Extraction**: AI analyzes content to extract item details
4. **Category Assignment**: Category is assigned considering existing categories if provided
5. **Slug Generation**: URL-friendly slug is auto-generated from item name
6. **Markdown Generation**: AI generates detailed markdown content
7. **Badge Evaluation**: Badges are evaluated for repository URLs
8. **Response**: Complete item data is returned

**Use Cases:**

- Preview item details before submitting to a work
- Extract structured data from URLs for external processing
- Validate and enrich item information
- Batch processing of URLs to extract item details

### 11. Update website repository

To update an existing website repository with the latest changes from the template repository, send a POST request to `http://localhost:3100/api/works/{id}/update-website`.
the `id` parameter should be the work ID.

This endpoint updates an existing website repository by pulling the latest changes from the template repository. It automatically detects the original creation method and applies the appropriate update strategy.

**Request:**

```
POST /api/works/{id}/update-website
```

**URL Parameters:**

| Parameter | Type   | Required   | Description                             |
| --------- | ------ | ---------- | --------------------------------------- |
| `id`      | string | `required` | The ID of the work/repository to update |

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

| Field         | Type   | Description                                                             |
| ------------- | ------ | ----------------------------------------------------------------------- |
| `status`      | string | Status of the operation: `success` or `error`                           |
| `slug`        | string | The work slug that was updated                                          |
| `owner`       | string | The GitHub owner (user or organization) of the repository               |
| `repository`  | string | Full repository name in `owner/repo-name` format                        |
| `message`     | string | Descriptive message about the update operation                          |
| `method_used` | string | The update method that was successfully used (see Update Methods below) |

**Update Methods:**

The service automatically tries different update strategies in order of preference:

| Method                  | Description                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `duplicate`             | **Fallback method.** Clones the original template, replaces the remote origin, and pushes to the target repository.               |
| `create-using-template` | **Last resort.** Clones both repositories, copies files from template to target (excluding .git), commits and pushes the changes. |

**Error Responses:**

```json
{
    "status": "error",
    "slug": "awesome-time-tracking",
    "owner": "",
    "repository": "/awesome-time-tracking-website",
    "message": "Failed to update website repository"
}
```

**Prerequisites:**

- The work must exist (created via `/works` endpoint)
- The website repository must exist (created via `/generate` endpoint)
- Valid GitHub authentication token in environment
