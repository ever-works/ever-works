# @ever-works/bluesky-connector-plugin

First-party **Bluesky (AT Protocol) social connector** for the Ever Works
platform, built on the official
[`@atproto/api`](https://www.npmjs.com/package/@atproto/api) SDK.

Capabilities: `connector`, `connector-bluesky`, `event-source`.

## What it does

- **Outbound** — `send()` publishes a post, or a threaded reply when the target
  config carries `replyToUri` + `replyToCid` (an explicit `rootUri`/`rootCid`
  overrides the thread root, otherwise the parent is used). Idempotent on
  `messageRef`.
- **Event source** — `pullEvents()` sweeps notifications (mentions, replies,
  likes, reposts, follows) and then the connected account's own posts,
  normalized into `IngestedEventEnvelope`s (`bluesky.notification` /
  `bluesky.post`) for the event-ingest spine. Each envelope carries the public
  `bsky.app` permalink as `sourceUrl` so Memory/Activity rows link back to the
  origin. Neither AT Protocol endpoint filters by time, so each phase is
  windowed client-side newest-first and stops at the first item older than the
  watermark.
- **Opt-in historical backfill** — `backfillDays` (default `0` = off, max 90)
  widens the FIRST pull's window only, bounded to
  `BLUESKY_BACKFILL_MAX_PAGES` pages per phase.

## Degradation is loud, never silent

- `verifyConnection()` reports missing credentials, an SSRF-unsafe PDS URL, and
  login failures.
- `send()` throws on missing credentials or a failed post.
- `pullEvents()` throws `EventSourceNotConfiguredError` when the identifier or
  app password is absent.

## Settings

| Key            | Notes                                                          |
| -------------- | -------------------------------------------------------------- |
| `identifier`   | Handle or DID of the connected account.                        |
| `appPassword`  | App password — secret, env `BLUESKY_APP_PASSWORD`.             |
| `service`      | PDS URL (defaults to `https://bsky.social`), SSRF-guarded.     |
| `backfillDays` | Opt-in first-pull history window (0 = off, max 90).            |

Always authenticate with a Bluesky **app password**, never the account
password. No credential is hardcoded, logged, or written into an ingested
envelope.

## Testing

Hermetic Vitest suite (`pnpm test`) — the SDK agent is stubbed through the
`createAgent` seam; no network calls.
