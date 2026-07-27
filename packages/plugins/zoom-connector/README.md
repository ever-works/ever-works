# @ever-works/zoom-connector-plugin

Zoom connector for the Ever Works platform (Wave 8, Meetings v1 — transcript-first).

## What it does

- **Event source (`event-source` capability)** — `pullEvents` sweeps **completed
  cloud recordings** since the last watermark via the official
  [`@zoom/rivet`](https://www.npmjs.com/package/@zoom/rivet) SDK
  (`MeetingsS2SAuthClient.endpoints.cloudRecording.listAllRecordings`,
  Server-to-Server OAuth). When a completed transcript (VTT) file exists it is
  downloaded, converted to readable text and truncated to the envelope-safe cap
  (24 000 chars). Each recording becomes a `zoom.recording`
  `IngestedEventEnvelope`; the agent-side Meetings processor turns those
  envelopes into `Meeting` rows and runs transcript ingest
  (summary + memory + activity).
- **Connector (`connector` capability)** — `verifyConnection` validates the
  Server-to-Server OAuth credentials. Outbound messaging is **not** part of v1;
  `send` rejects loudly.

- **Historical backfill (`backfill()` capability method)** — the optional
  `backfill()` method on the `event-source` capability runs the same sweep
  out-of-band over an EXPLICIT window, so history can be imported at any time
  instead of only as a side effect of the first pull's `backfillDays`. One call
  fetches one page and hands back a cursor, so the per-phase page bound still
  applies. Re-delivery is free — the ingest pipeline dedupes on
  `(source, sourceEventId)`.

## Settings

| Key            | Notes                                                             |
| -------------- | ----------------------------------------------------------------- |
| `accountId`    | Zoom account id of the Server-to-Server OAuth app                 |
| `clientId`     | Client id of the Server-to-Server OAuth app                       |
| `clientSecret` | Client secret (`x-secret`)                                        |
| `backfillDays` | Opt-in historical backfill window on first pull (0–90, default 0) |

## Sweep protocol

The Zoom recordings list API caps `from`/`to` at one month, so a sweep advances
through ≤30-day window chunks up to the sweep end bound, round-tripping the
API's `next_page_token` inside each chunk. Re-delivery across overlapping
windows is safe — the ingest pipeline dedupes on `(source, sourceEventId)`, and
transcript availability is part of the identity (`:recording` vs
`:transcript`) so a transcript that completes after the recording still lands.

## Vendor-SDK note

Every Zoom **API** call goes through the official `@zoom/rivet` SDK. The one
exception is the transcript **file** download: Rivet wraps the REST endpoints
but exposes neither recording-file downloads nor its internal access token, so
the download leg performs the official Server-to-Server OAuth
`account_credentials` token flow (`https://zoom.us/oauth/token`) and fetches the
SDK-returned `download_url` with the bearer token. Both hosts are fixed Zoom
origins — no user-controlled URLs.

## Follow-up (documented, not in v1)

**Live bot-join** — an Ever Works bot joining meetings/calls to capture audio
and transcripts in real time — requires Zoom's Meeting Bot / RTMS surface and a
media pipeline. It will layer onto this connector without changing the
`zoom.recording` envelope contract.

## Tests

```bash
cd packages/plugins/zoom-connector && pnpm test
```

Vitest suite with a mocked client seam (`createClient` override) — no real Zoom
calls.
