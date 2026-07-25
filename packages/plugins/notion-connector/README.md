# @ever-works/notion-connector-plugin

First-party **Notion connector** for the Ever Works platform (Wave 8), built on
the official [`@notionhq/client`](https://www.npmjs.com/package/@notionhq/client).

Capabilities: `connector`, `connector-notion`, `event-source`.

## What it does

- **Outbound** — `send()` appends a comment to a Notion page
  (`targetConfig.pageId` / `defaultPageId`), idempotent on `messageRef`.
  Integration tokens without comment capabilities fail with a clear,
  actionable error (grant "Insert comments" and share the page).
- **Event source** — `pullEvents()` sweeps pages created/edited since the
  platform watermark — per configured database (`databases.query` with a
  server-side `last_edited_time` filter) or workspace-wide (`search`,
  newest-first with client-side windowing) — normalized into
  `IngestedEventEnvelope`s (`notion.page`) for the event-ingest spine. Each
  envelope carries the page URL as `sourceUrl` so Memory/Activity rows link
  back to the origin.
- **Opt-in historical backfill** — `backfillDays` (default `0` = off, max 90)
  widens the FIRST pull's window only, bounded to
  `NOTION_BACKFILL_MAX_PAGES` result pages per phase.

## Settings

| Key             | Notes                                                         |
| --------------- | ------------------------------------------------------------- |
| `apiKey`        | Notion integration token — secret, env `NOTION_API_KEY`.      |
| `databaseIds`   | Optional comma-separated database filter (search when empty). |
| `backfillDays`  | Opt-in first-pull history window (0 = off, max 90).           |
| `defaultPageId` | Default page for outbound comments.                           |

## Testing

Hermetic Vitest suite (`pnpm test`) — the SDK client is stubbed through the
`createClient` seam; no network calls.
