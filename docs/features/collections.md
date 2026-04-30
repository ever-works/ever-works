---
id: collections
title: Collections
sidebar_label: Collections
sidebar_position: 3
---

# Collections

Collections let you curate directory items into named groups like "Editor's Picks", "Best for Beginners", or "Top Open Source". Unlike categories (which classify what an item *is*) and tags (which describe its features), collections are editorial groupings that cut across categories.

## Taxonomy Overview

The platform supports three taxonomy dimensions for organizing items:

| Taxonomy | Purpose | Cardinality | Example |
|----------|---------|-------------|---------|
| **Category** | Primary functional grouping | 1 per item (required) | "Design Tools", "Databases" |
| **Tag** | Descriptive keywords | 0–3 per item | "open-source", "free-tier", "self-hosted" |
| **Collection** | Curated editorial group | 0–1 per item (optional) | "Editor's Picks", "Best for Beginners" |

An item belongs to exactly one category, can have multiple tags, and may optionally belong to one collection.

## Enabling Collections

Collections are controlled by two independent toggles:

| Toggle | Where | Effect |
|--------|-------|--------|
| **`collections_enabled`** | Website Settings (`PUT /api/directories/:id/website-settings`) | Controls whether collections are displayed on the deployed website |
| **`generate_collections`** | Standard Pipeline plugin settings | Controls whether the AI assigns collections during generation |

Both default to `true`. You can disable AI-generated collections while still managing collections manually, or vice versa.

## Managing Collections

Collections can be created and managed from the **Items** page in the Web Dashboard (under the Collections tab) or via the API.

### Collection Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Display name (max 100 characters), e.g. "Editor's Picks" |
| `description` | string | No | Short description (max 500 characters) |
| `icon_url` | string | No | URL to an icon image (max 500 characters) |
| `priority` | number | No | Display order — lower numbers appear first (min 0) |

:::info
The collection **ID** is generated automatically from the name by slugifying it. For example, a collection named "Editor's Picks" gets the ID `editors-picks`. You cannot set the ID manually.
:::

## API

All collection endpoints require JWT authentication.

### Create a Collection

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/directories/:id/collections` | Create a new collection |

```bash
curl -X POST http://localhost:3100/api/directories/<directory-id>/collections \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Editor'\''s Picks",
    "description": "Hand-picked favorites by the editorial team",
    "priority": 1
  }'
```

### Update a Collection

| Method | Endpoint | Description |
|--------|----------|-------------|
| `PUT` | `/api/directories/:id/collections/:collectionId` | Update an existing collection |

```bash
curl -X PUT http://localhost:3100/api/directories/<directory-id>/collections/editors-picks \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Updated description",
    "priority": 2
  }'
```

### Delete a Collection

| Method | Endpoint | Description |
|--------|----------|-------------|
| `DELETE` | `/api/directories/:id/collections/:collectionId` | Delete a collection |

```bash
curl -X DELETE http://localhost:3100/api/directories/<directory-id>/collections/editors-picks \
  -H "Authorization: Bearer <token>"
```

:::warning
Deleting a collection does not remove items — it only removes the grouping. Items that belonged to the deleted collection will have their `collection` field cleared.
:::

### List Collections

Collections are returned as part of the existing categories-tags endpoint:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/directories/:id/categories-tags` | Returns categories, tags, and collections |

```bash
curl http://localhost:3100/api/directories/<directory-id>/categories-tags \
  -H "Authorization: Bearer <token>"
```

**Response:**

```json
{
  "status": "success",
  "categories": [...],
  "tags": [...],
  "collections": [
    {
      "id": "editors-picks",
      "name": "Editor's Picks",
      "description": "Hand-picked favorites by the editorial team",
      "priority": 1
    }
  ]
}
```

## AI-Assigned Collections

During AI generation, the Standard Pipeline can automatically assign items to collections. The AI evaluates each item's prominence and suitability, then optionally assigns it to one collection. Not every item receives a collection — the AI only assigns collections when a clear fit exists.

AI-generated collections contain only an `id` and `name`. You can enrich them with a `description`, `icon_url`, and `priority` using the update endpoint after generation completes.

To disable AI-generated collections, set `generate_collections` to `false` in the Standard Pipeline plugin settings.

## Data Storage

Collections are stored as a `collections.yml` file in the directory's data repository, alongside `categories.yml` and `tags.yml`. Each item's YAML file includes an optional `collection` field containing the collection's slug ID.

## Related

- [Directories API](/api/directories) — Full endpoint reference including collection CRUD
- [Community PR Processing](./community-pr-processing) — Automatically extract items from community contributions
- [AI & Generation](/ai-agents) — AI pipeline that assigns collections during generation
