---
id: community-pr-processing
title: Community PR Processing
sidebar_label: Community PR
sidebar_position: 2
---

# Community PR Processing

Community PR Processing automates the handling of pull requests submitted by external contributors to a work's GitHub repository. When someone opens a PR that adds new tools, resources, or listings, the platform uses AI to extract structured items from the PR diff and commits them directly to the data repository — no manual review needed.

:::tip When to use this
Enable Community PR Processing on works that accept public contributions. Contributors open PRs against the main (Markdown) repository, and the platform takes care of parsing, categorizing, and storing the new items automatically.
:::

## Prerequisites

Before enabling Community PR Processing, make sure the following are in place:

1. **GitHub plugin configured** — The GitHub plugin must be active with a valid access token (see [Plugin System](/plugin-system/built-in-plugins#github)).
2. **Main repository linked** — The work must have a connected GitHub main repository.
3. **Data repository linked** — The work must have a connected GitHub data repository where items are stored.
4. **AI provider active** — At least one AI provider plugin must be enabled for item extraction (see [AI & Generation](/ai-agents)).

## How It Works

1. **Discovery** — The system queries GitHub for open PRs on the work's main repository. PRs that have already been processed are skipped (tracked internally by PR number).
2. **Analysis** — For each new PR, file diffs are fetched and combined with the work's context (name, description, existing categories) and the PR's title and body.
3. **AI Extraction** — The combined context is sent to the configured AI provider, which returns structured item data: name, description, source URL, category, and tags.
4. **Data Sync** — Extracted items are written to the data repository, committed with a message linking back to the original PR, and pushed.
5. **Feedback** — A comment is posted on the PR listing the items that were added. If auto-close is enabled, the PR is closed automatically.

Processing runs **automatically every hour** for all works that have the feature enabled. You can also trigger it manually via the API.

## Configuration

Community PR Processing is configured per-work through the Settings page or the `PUT /api/works/:id` endpoint.

| Setting                | Type    | Default | Description                                       |
| ---------------------- | ------- | ------- | ------------------------------------------------- |
| `communityPrEnabled`   | boolean | `false` | Master switch — enables automatic PR processing   |
| `communityPrAutoClose` | boolean | `true`  | Automatically close PRs after items are extracted |

## API

### Manually Trigger Processing

Process all unhandled community PRs for a work on demand.

| Method | Endpoint                               | Auth |
| ------ | -------------------------------------- | ---- |
| `POST` | `/api/works/:id/process-community-prs` | JWT  |

**Path parameters:**

| Parameter | Type   | Description |
| --------- | ------ | ----------- |
| `id`      | string | Work UUID   |

**Response** (`200 OK`):

```json
{
	"itemsAdded": 3
}
```

**Errors:**

| Status | Reason                                               |
| ------ | ---------------------------------------------------- |
| `400`  | Community PR processing is not enabled for this work |
| `404`  | Work not found                                       |

**Example:**

```bash
curl -X POST http://localhost:3100/api/works/<work-id>/process-community-prs \
  -H "Authorization: Bearer <token>"
```

### Enable via Work Update

```bash
curl -X PUT http://localhost:3100/api/works/<work-id> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "communityPrEnabled": true,
    "communityPrAutoClose": true
  }'
```

## How Contributors Submit Items

Contributors open a pull request against the work's main GitHub repository. The PR can add new Markdown files, modify existing ones, or include item data in any text-based format. The AI extraction step reads the raw diff, so there is no strict template requirement — though PRs with clear item names, descriptions, and URLs yield the best results.

## PR Comment Examples

**Items found:**

> Thank you for your contribution! The following items have been added to the work:
>
> - **Acme Tool** — A modern build system for JavaScript projects
> - **WidgetKit** — Open-source UI component library
>
> The data repository has been updated automatically.

**No items found:**

> Thank you for your pull request! After analyzing the changes, no new work items could be extracted. This may happen if the PR contains formatting changes, documentation updates, or content that doesn't match the work's scope.

## Related

- [Works API](/api/works) — Full endpoint reference including Community PR Processing
- [Collections](./collections) — Another way to organize items into curated groups
- [Plugin System — GitHub](/plugin-system/built-in-plugins#github) — GitHub plugin configuration
