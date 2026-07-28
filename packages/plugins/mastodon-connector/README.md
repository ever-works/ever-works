# @ever-works/mastodon-connector-plugin

First-party **Mastodon social connector** for the Ever Works platform, built on
the [`masto`](https://www.npmjs.com/package/masto) SDK (Mastodon ships no
first-party JavaScript SDK; `masto` is the established client — the connector
never hand-rolls REST calls).

Capabilities: `connector`, `connector-mastodon`, `event-source`.

## What it does

- **Outbound** — `send()` publishes a status at the configured visibility, or a
  threaded reply when the target config carries `inReplyToId`. Idempotent on
  `messageRef`.
- **Event source** — `pullEvents()` sweeps notifications (mentions, favourites,
  boosts, follows) and then the connected account's own statuses, normalized
  into `IngestedEventEnvelope`s (`mastodon.notification` / `mastodon.status`)
  for the event-ingest spine. Status HTML is flattened to plain text; the
  status permalink rides along as `sourceUrl`. Mastodon paginates by id, so
  each phase walks `max_id` newest-first and stops at the first item older than
  the watermark.
- **Opt-in historical backfill** — `backfillDays` (default `0` = off, max 90)
  widens the FIRST pull's window only, bounded to
  `MASTODON_BACKFILL_MAX_PAGES` pages per phase.

## Degradation is loud, never silent

- `verifyConnection()` reports missing credentials, an SSRF-unsafe instance URL,
  and failed credential verification.
- `send()` throws on missing credentials or a failed status create.
- `pullEvents()` throws `EventSourceNotConfiguredError` when the instance URL or
  access token is absent, or when the token resolves to no account.

## Settings

| Key                 | Notes                                                    |
| ------------------- | -------------------------------------------------------- |
| `instanceUrl`       | Instance base URL — SSRF-guarded before every call.      |
| `accessToken`       | Application token — secret, env `MASTODON_ACCESS_TOKEN`. |
| `defaultVisibility` | `public` \| `unlisted` \| `private` \| `direct`.         |
| `backfillDays`      | Opt-in first-pull history window (0 = off, max 90).      |

No credential is hardcoded, logged, or written into an ingested envelope.

## Testing

Hermetic Vitest suite (`pnpm test`) — the SDK client is stubbed through the
`createClient` seam; no network calls.
