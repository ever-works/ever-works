# @ever-works/google-workspace-connector-plugin

First-party **Google Workspace connector** for the Ever Works platform (Wave 8),
built on Google's official Node clients
[`@googleapis/drive`](https://www.npmjs.com/package/@googleapis/drive) and
[`@googleapis/calendar`](https://www.npmjs.com/package/@googleapis/calendar)
(the per-API packages published from `googleapis/google-api-nodejs-client`,
chosen over the monolithic `googleapis` aggregate for install size).

Capabilities: `connector`, `event-source`.

## Scope in v1

Deliberately narrow — the two highest-value, lowest-risk read surfaces:

- **Drive file changes** → `google.drive-change` envelopes (files modified
  since the watermark, optionally narrowed to configured folders). `workHint`
  kind `doc-database` on the file's parent folder.
- **Calendar events** → `google.calendar-event` envelopes (events updated since
  the watermark, per configured calendar). `workHint` kind `meeting` on the
  Meet conference id when the event has one, else the event id.
- **Google Meet transcripts** → `google.meet-recording` envelopes. Meet drops a
  transcript Google Doc into the account's "Meet Recordings" Drive folder;
  those files are exported as plain text and emitted with `transcriptText`,
  which the platform's Meetings kind processor turns into a Meeting row and an
  `ingestTranscript` run. **Meet needs no separate connector — it rides this
  one.**

**Out of v1:** Gmail, Docs/Sheets content, Admin & Reports. Each needs a
materially wider consent scope for materially less signal, and Gmail in
particular would put whole mailboxes through the ingest spine.

## Auth: OAuth refresh token, not a service account

The connector authenticates with an OAuth **refresh token** (client id +
client secret + refresh token; scopes `drive.readonly` and
`calendar.readonly`).

A service account was rejected for v1: it can only reach a user's My Drive
through Workspace domain-wide delegation, which excludes individual Google
accounts and requires super-admin configuration — while a refresh token is the
same "paste one secret" operation and works for both. Service accounts with
domain-wide delegation remain a documented follow-up for org-wide sweeps.

## Settings

| Key               | Notes                                                               |
| ----------------- | ------------------------------------------------------------------- |
| `clientId`        | Google OAuth client id — env `GOOGLE_WORKSPACE_CLIENT_ID`.          |
| `clientSecret`    | OAuth client secret — secret, env `GOOGLE_WORKSPACE_CLIENT_SECRET`. |
| `refreshToken`    | OAuth refresh token — secret, env `GOOGLE_WORKSPACE_REFRESH_TOKEN`. |
| `surfaces`        | `drive`, `calendar`, or both (default both).                        |
| `driveFolderIds`  | Optional comma-separated Drive folder filter.                       |
| `calendarIds`     | Comma-separated calendar ids (default `primary`).                   |
| `meetTranscripts` | Export Meet transcript docs into meeting envelopes (default true).  |
| `backfillDays`    | Opt-in first-pull history window (0 = off, max 90).                 |

## Sweep protocol

Phases run drive → calendar (once per configured calendar), each resumable on
the API's own page token. The opt-in historical backfill (`backfillDays`,
default `0` = off, max 90) widens the FIRST pull's window only, bounded to
`GOOGLE_BACKFILL_MAX_PAGES` pages per phase. Re-delivery across overlapping
windows is fine — the ingest pipeline dedupes on `(source, sourceEventId)`.

Drive folder ids are whitelisted against Drive's own file-id alphabet rather
than escaped, because they are interpolated into the Drive `q` query language.

## Testing

Hermetic Vitest suite (`pnpm test`) — the SDK clients are stubbed through the
`createClient` seam; no network calls.
