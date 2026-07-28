# @ever-works/hubspot-connector-plugin

First-party **HubSpot CRM connector** for the Ever Works platform, built on the
official [`@hubspot/api-client`](https://www.npmjs.com/package/@hubspot/api-client).

Capabilities: `connector`, `connector-hubspot`, `event-source`.

## What it does

- **Outbound message** — `send()` appends a Note engagement to a CRM record
  (`targetConfig.associatedObjectId` / `settings.defaultAssociatedObjectId`),
  associated with the record's HubSpot-defined note association type,
  idempotent on `messageRef`.
- **Outbound record** — `createRecord()` writes a contact / company / deal (or
  any custom object) via `crm.objects.basicApi.create`, idempotent on
  `idempotencyKey`.
- **Event source** — `pullEvents()` sweeps each configured CRM object type in
  turn through the Search API, filtered server-side on that type's
  last-modified property, normalized into `IngestedEventEnvelope`s
  (`hubspot.contact` / `hubspot.company` / `hubspot.deal`, custom objects fall
  back to `hubspot.record`) for the event-ingest spine. With a `portalId`
  configured each envelope carries a record deep link as `sourceUrl` so
  Memory/Activity rows link back to the origin.
- **Opt-in historical backfill** — `backfillDays` (default `0` = off, max 90)
  widens the FIRST pull's window only, bounded to
  `HUBSPOT_BACKFILL_MAX_PAGES` search pages per object type.

## Degradation is loud, never silent

An unconfigured connector never quietly returns nothing:

- `verifyConnection()` reports the missing `accessToken` (and surfaces the
  HubSpot error body when the read probe fails, e.g. a missing scope).
- `send()` / `createRecord()` throw on a missing token, a missing record id, or
  an object type that has no note association (rather than writing an orphan
  note).
- `pullEvents()` throws `EventSourceNotConfiguredError`.

## Settings

| Key                         | Notes                                                                |
| --------------------------- | -------------------------------------------------------------------- |
| `accessToken`               | Private-app token — secret, env `HUBSPOT_ACCESS_TOKEN`.              |
| `objectTypes`               | Comma-separated sweep list (contacts, companies, deals when empty).  |
| `portalId`                  | Portal (hub) id — enables record deep links on every envelope.       |
| `backfillDays`              | Opt-in first-pull history window (0 = off, max 90).                  |
| `defaultObjectType`         | Default object type for `createRecord` + the verify probe.           |
| `defaultAssociatedObjectId` | Default CRM record outbound notes attach to.                         |

No credential is ever hardcoded, logged, or written into an ingested envelope.

## Testing

Hermetic Vitest suite (`pnpm test`) — the SDK client is stubbed through the
`createClient` seam; no network calls.
