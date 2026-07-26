# @ever-works/jira-connector-plugin

First-party **JIRA connector** for the Ever Works platform (Wave 8), built on
[`jira.js`](https://www.npmjs.com/package/jira.js).

Capabilities: `connector`, `event-source`.

## Why `jira.js`

Atlassian publishes no maintained first-party Node client for the Jira Cloud
REST API: the Atlassian Labs `@atlassian/jira` package stopped at `0.1.0` with
no release since 2018, and `@forge/api` only runs inside a Forge app runtime.
`jira.js` is the actively maintained (weekly releases), TypeScript-native Jira
Cloud client, and is what this connector builds on.

## What it does

- **Outbound** — `send()` posts a comment on a JIRA issue
  (`targetConfig.issueKey` / `defaultIssueKey`), idempotent on `messageRef`.
  Plain text is rendered into Atlassian Document Format by the SDK.
- **Event source** — `pullEvents()` sweeps issues updated since the platform
  watermark with one bounded JQL query per page, normalized into
  `IngestedEventEnvelope`s (`jira.issue` / `jira.comment`). Each envelope
  carries the issue's browse URL as `sourceUrl` so Memory/Activity rows link
  back to the origin.
- **Work routing** — every envelope carries a `tracker-team` `workHint` keyed
  on the project key, so a Work claiming that project gets the event on its
  feed.
- **Opt-in historical backfill** — `backfillDays` (default `0` = off, max 90)
  widens the FIRST pull's window only, bounded to `JIRA_BACKFILL_MAX_PAGES`
  pages.

### Comments ride with the issue

JIRA has no "all comments" endpoint — comments only exist under an issue. The
sweep therefore requests the `comment` field alongside each issue and emits a
`jira.comment` envelope for every comment that itself changed inside the
window. That keeps a page at ONE API call instead of one per issue, and an
issue whose only change is a new comment is already in the result set because
commenting bumps `updated`.

### JQL and the site timezone

JQL evaluates bare date literals in the SITE's timezone while the platform
watermark is UTC, so the rendered window can be off by the site's UTC offset.
That is safe in both directions: dedupe is `(source, sourceEventId)`, so an
over-wide window costs one extra page and drops nothing, and each comment
re-checks `since` before its envelope is emitted.

## Settings

| Key               | Notes                                                              |
| ----------------- | ------------------------------------------------------------------ |
| `baseUrl`         | JIRA site URL, `https://…` only — env `JIRA_BASE_URL`.             |
| `email`           | Atlassian account email (API-token basic auth) — env `JIRA_EMAIL`. |
| `apiToken`        | Atlassian API token — secret, env `JIRA_API_TOKEN`.                |
| `projectKeys`     | Optional comma-separated project-key filter for the pull.          |
| `backfillDays`    | Opt-in first-pull history window (0 = off, max 90).                |
| `defaultIssueKey` | Default issue for outbound comments.                               |

### SSRF posture

Unlike every sibling connector, this one takes its host from user settings (a
JIRA site is per-customer), so `baseUrl` is an SSRF surface. It is validated
before any request: `https:` only, no embedded credentials, and loopback /
link-local / RFC-1918 / `.local` / `.internal` hosts are rejected. Project keys
are whitelisted against JIRA's own key alphabet rather than escaped, because
they are interpolated into JQL.

## Testing

Hermetic Vitest suite (`pnpm test`) — the SDK client is stubbed through the
`createClient` seam; no network calls.
