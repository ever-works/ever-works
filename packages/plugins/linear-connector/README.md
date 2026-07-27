# @ever-works/linear-connector-plugin

First-party **Linear connector** for the Ever Works platform (Wave 8), built on
the official [`@linear/sdk`](https://www.npmjs.com/package/@linear/sdk).

Capabilities: `connector`, `connector-linear`, `event-source`.

## What it does

- **Outbound** — `send()` posts a comment on a Linear issue
  (`targetConfig.issueId` / `defaultIssueId`), idempotent on `messageRef`.
- **Event source** — `pullEvents()` sweeps issues (created/updated) and then
  comments since the platform watermark, normalized into
  `IngestedEventEnvelope`s (`linear.issue` / `linear.comment`) for the
  event-ingest spine. Each envelope carries the issue URL as `sourceUrl` so
  Memory/Activity rows link back to the origin.
- **Opt-in historical backfill** — `backfillDays` (default `0` = off, max 90)
  widens the FIRST pull's window only, bounded to
  `LINEAR_BACKFILL_MAX_PAGES` pages per phase.

- **Historical backfill (`backfill()` capability method)** — the optional
  `backfill()` method on the `event-source` capability runs the same sweep
  out-of-band over an EXPLICIT window, so history can be imported at any time
  instead of only as a side effect of the first pull's `backfillDays`. One call
  fetches one page and hands back a cursor, so the per-phase page bound still
  applies. Re-delivery is free — the ingest pipeline dedupes on
  `(source, sourceEventId)`.

## Settings

| Key              | Notes                                                        |
| ---------------- | ------------------------------------------------------------ |
| `apiKey`         | Linear API key (`lin_api_…`) — secret, env `LINEAR_API_KEY`. |
| `teamIds`        | Optional comma-separated team-id filter for the pull.        |
| `backfillDays`   | Opt-in first-pull history window (0 = off, max 90).          |
| `defaultIssueId` | Default issue for outbound comments.                         |

## Testing

Hermetic Vitest suite (`pnpm test`) — the SDK client is stubbed through the
`createClient` seam; no network calls.
