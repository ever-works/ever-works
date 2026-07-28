# @ever-works/pipedrive-connector-plugin

First-party **Pipedrive CRM connector** for the Ever Works platform, built on
the official [`pipedrive`](https://www.npmjs.com/package/pipedrive) Node SDK.

Capabilities: `connector`, `connector-pipedrive`, `event-source`.

## What it does

- **Outbound message** — `send()` appends a note to a deal (default), person or
  organization (`targetConfig.recordId` + `recordType`, or
  `settings.defaultDealId`), idempotent on `messageRef`.
- **Outbound record** — `createRecord()` writes a deal / person / organization,
  idempotent on `idempotencyKey`.
- **Event source** — `pullEvents()` sweeps each configured entity type in turn
  through Pipedrive's own `/recents` endpoint (its native "everything that
  changed since this timestamp" API), normalized into `IngestedEventEnvelope`s
  (`pipedrive.deal` / `pipedrive.person` / `pipedrive.organization`) for the
  event-ingest spine. With a `companyDomain` configured each envelope carries a
  record deep link as `sourceUrl`.
- **Opt-in historical backfill** — `backfillDays` (default `0` = off, max 90)
  widens the FIRST pull's window only, bounded to
  `PIPEDRIVE_BACKFILL_MAX_PAGES` pages per entity type.

## Degradation is loud, never silent

- `verifyConnection()` reports the missing `apiToken` and surfaces the
  Pipedrive error payload when the probe fails.
- `send()` / `createRecord()` throw on a missing token, a missing record id, or
  an unsupported collection.
- `pullEvents()` throws `EventSourceNotConfiguredError`.

## Settings

| Key             | Notes                                                                |
| --------------- | --------------------------------------------------------------------- |
| `apiToken`      | API token — secret, env `PIPEDRIVE_API_TOKEN`.                       |
| `entityTypes`   | Comma-separated sweep list (deals, persons, organizations by default). |
| `companyDomain` | `acme` for `acme.pipedrive.com` — enables record deep links.         |
| `backfillDays`  | Opt-in first-pull history window (0 = off, max 90).                  |
| `defaultDealId` | Default deal outbound notes attach to.                               |

Envelope payloads carry a per-entity field whitelist only — custom fields and
nested expansions never ride along, and no credential is hardcoded, logged, or
written into an envelope.

## Testing

Hermetic Vitest suite (`pnpm test`) — the SDK client is stubbed through the
`createClient` seam; no network calls.
