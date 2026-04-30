---
id: item-source-validation
title: Item Source Validation
sidebar_label: Source Validation
sidebar_position: 5
---

# Item Source Validation

Item Source Validation checks two separate things about each item's `source_url`:

1. **Reachability** — whether the source can be verified as reachable
2. **Accuracy** — whether the source is actually a good, specific source for the item

This is more useful than a plain dead-link checker because a URL can be reachable but still be too generic or weak for the item it claims to support.

:::tip Example
For an item like GitHub Copilot, `https://github.com/` may be reachable, but it is usually too broad to be considered the best source for that specific item.
:::

## Validation Model

### Reachability Status

| Status | Meaning |
|---|---|
| `reachable` | The system could verify or infer that the URL is reachable |
| `broken` | The URL returned a high-confidence dead-link signal such as `404` or `410` |
| `unknown` | The automated check could not confirm reachability |

### Accuracy Status

| Status | Meaning |
|---|---|
| `accurate` | The source is relevant and specific to the item |
| `generic` | The source is relevant, but too broad or generic |
| `weak` | The source is not a strong supporting page for the item |
| `unknown` | Accuracy could not be determined confidently |

### Stored Metadata

```typescript
interface ItemSourceValidation {
  reachability_status: 'reachable' | 'broken' | 'unknown';
  accuracy_status: 'accurate' | 'generic' | 'weak' | 'unknown';
  checked_at?: string;
  confidence_score?: number | null;
  is_relevant?: boolean;
  is_specific?: boolean;
  is_official?: boolean;
  reason?: string | null;
  suggested_source_url?: string | null;
}
```

## How It Works

1. **Deterministic reachability check**
   - The system runs an HTTP-based check on the source URL.
   - Clear dead-link signals such as `404` and `410` are treated as broken.
   - Ambiguous automated failures remain `unknown` rather than being shown as false errors.
2. **Content extraction**
   - If the URL is not clearly broken, content extraction is attempted.
   - Successful extraction is also treated as evidence that the source is usable enough to inspect.
3. **AI source validation**
   - AI evaluates whether the page is relevant, specific, and likely the right source for the item.
   - The result is stored separately from reachability.

## Manual Checks

Users can manually trigger validation from the item actions menu.

| Action | Behavior |
|--------|----------|
| `Re-check source` | Re-runs source validation for a single item |
| `Apply suggestion` | Replaces the current `source_url` with an AI-suggested alternative when available |

Repeated manual checks are cached for a short window so the same item does not rerun the full git + extraction + AI flow on every click.

## Scheduled Validation

Source validation can also run automatically.

- It still runs after scheduled generation completes successfully.
- It now also has its own standalone periodic scheduler.
- Each directory schedule can define a separate `sourceValidationCadence`.
- If no separate cadence is set, it defaults to the main schedule cadence.

This keeps source quality fresh even between generation runs.

## UI Behavior

The Items UI shows compact validation status without turning every ambiguous case into a warning:

- **Broken links** are shown as strong warnings
- **Reachable / accurate / generic / weak** states are shown as persistent, lower-noise status text
- Suggested replacement source URLs appear in the item action menu instead of bloating the card layout

## API

### Check a Single Item Source

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/directories/:id/check-item-health` | Run source validation for one item and persist the result |

**Example:**

```bash
curl -X POST http://localhost:3100/api/directories/<directory-id>/check-item-health \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "item_slug": "github-copilot"
  }'
```

## Why It Matters

Item Source Validation helps directory owners keep links useful, not just alive:

- detect clearly broken sources
- identify generic or weak supporting pages
- store AI reasoning for later review
- apply better source suggestions directly from the UI

## Related

- [Items Management](../web-dashboard/items-ui.md) — where validation status and actions appear
- [Scheduled Updates](./scheduled-updates.md) — source validation cadence can be configured alongside generation cadence
- [Scheduling Interface](../web-dashboard/schedule-ui.md) — dashboard controls for validation cadence
- [Directories API](../api/directories.md) — schedule fields and manual validation endpoint
