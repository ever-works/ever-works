---
id: work-changelog
title: Work Changelog
sidebar_label: Work Changelog
sidebar_position: 3
---

# Work Changelog

Work Changelog gives each work an audit trail of what changed over time. Instead of only showing aggregate generation metrics, the History tab now records item-level and taxonomy-level activity so work owners can review specific changes after generation runs, manual edits, comparison actions, and community PR processing.

:::tip When to use this
Use Work Changelog when you need visibility into how a work evolves over time, especially if multiple people or automated jobs are updating content.
:::

## What It Tracks

Each changelog entry is stored alongside work history and includes an `activityType` plus structured change details.

### Activity Types

| Activity Type                                          | Examples                                           |
| ------------------------------------------------------ | -------------------------------------------------- |
| `generation`                                           | AI generation run added, updated, or removed items |
| `item_added` / `item_updated` / `item_removed`         | Direct item management changes                     |
| `comparison_added` / `comparison_removed`              | Comparison pages created or deleted                |
| `category_change` / `tag_change` / `collection_change` | Taxonomy updates                                   |
| `community_pr_merged`                                  | Items imported from processed community PRs        |

### Changelog Payload

Each history row can carry a structured changelog payload:

```typescript
interface WorkChangelog {
	summary?: string | null;
	addedCount: number;
	updatedCount: number;
	removedCount: number;
	entries: {
		entityType: 'item' | 'comparison' | 'category' | 'tag' | 'collection';
		action: 'added' | 'updated' | 'removed';
		name: string;
		slug?: string;
		fieldsChanged?: string[];
	}[];
}
```

This lets the UI show both a compact summary and an expandable list of exactly what changed.

## How It Works

1. **A work mutation happens** — generation completes, an item is edited, a taxonomy entity changes, a comparison is created, or a community PR is processed.
2. **The platform records a history entry** in `WorkGenerationHistory`.
3. **Structured change details are attached** to the history row as `changelog`.
4. **The History tab renders the entry** with its activity type, summary, and expandable details.

Generation runs still record status, duration, and metrics, but they now also include item-level change details. `RECREATE` runs additionally capture removed items when the new generated set replaces the old one.

## UI Behavior

The History tab now supports:

- **Pagination** for larger works
- **Activity-type filtering** (`generation`, `items`, `comparisons`, `taxonomy`, `community PR`)
- **Expandable changelog details** grouped by Added, Updated, and Removed

This turns the History page into a practical review tool instead of a metrics-only log.

## API

### Get Work History

| Method | Endpoint                 | Description                                    |
| ------ | ------------------------ | ---------------------------------------------- |
| `GET`  | `/api/works/:id/history` | Get paginated work history with changelog data |

**Query parameters:**

| Parameter      | Type   | Description                                                                              |
| -------------- | ------ | ---------------------------------------------------------------------------------------- |
| `limit`        | number | Page size                                                                                |
| `offset`       | number | Pagination offset                                                                        |
| `activityType` | string | Optional filter group (`generation`, `items`, `comparisons`, `taxonomy`, `community_pr`) |

**Example:**

```bash
curl "http://localhost:3100/api/works/<work-id>/history?limit=10&offset=0&activityType=taxonomy" \
  -H "Authorization: Bearer <token>"
```

## Why It Matters

Work Changelog improves trust and reviewability:

- **Owners** can confirm what automation actually changed
- **Editors** can audit manual content updates
- **Teams** can see taxonomy and comparison changes in the same timeline
- **Community-driven works** can track what was merged from contributor PRs

## Related

- [Generation History](../web-dashboard/history-ui.md) — UI behavior and component structure
- [Scheduled Updates](./scheduled-updates.md) — recurring generation runs that produce changelog entries
- [Community PR Processing](./community-pr-processing.md) — community PR events also appear in the changelog
- [Taxonomy System](./taxonomy-system.md) — category, tag, and collection changes are tracked as history activity
