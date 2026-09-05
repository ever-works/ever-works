---
id: integrations
title: Integrations (Slack, GitHub, connectors, meetings)
sidebar_label: Integrations
description: The event envelope every integration produces, the Slack app and GitHub pull-request receivers, the eleven native connectors, and the Meetings API.
---

# Integrations

Your AI team should see the same things your human team sees. Integrations bring outside activity — chat, pull requests, issues, docs, recordings — into the platform as a normalized stream, and let Agents act back through the same channels.

## The event spine

Every integration produces the same shape: an **event envelope**.

| Field           | Notes                                                                        |
| --------------- | ---------------------------------------------------------------------------- |
| `id`            | Connector-assigned envelope id.                                              |
| `source`        | Producing plugin id, e.g. `slack-connector`.                                 |
| `sourceEventId` | Stable id in the source system. `(source, sourceEventId)` is the dedupe key. |
| `kind`          | Source-namespaced event kind, e.g. `slack.message`.                          |
| `occurredAt`    | ISO 8601, when it happened at the source.                                    |
| `actor`         | `{ name, externalId? }`                                                      |
| `subject`       | `{ type, externalId, title? }`                                               |
| `sourceUrl`     | Deep link back to the original message / PR / page / recording.              |
| `payload`       | Source-specific detail (≤ 32 KB serialized).                                 |

Events arrive two ways:

- **Pull** — the `event-ingest-tick` cron drives every enabled `event-source` plugin with a resumable per-(plugin, user) cursor and a page budget.
- **Push** — `POST /api/ingest/events` accepts up to 100 envelopes per call.

Ingest is a **dedupe-insert**, so retries are free: the response reports `{ inserted, duplicates, rejected }`. Events land owner-scoped, and dedupe is per owner — the same source event may legitimately land for two different accounts.

Ingested events fan out to your Activity feed and, where relevant, to memory.

## Slack

The **slack-connector** plugin is bidirectional:

- **Outbound** — Agents post messages to channels.
- **Inbound** — the Slack Events API points at `POST /api/ingest/slack/events`.
- **Slash command** — the app's slash command (e.g. `/works`) points at `POST /api/ingest/slack/commands`.

Mention `@works` in a channel and the message is routed to the same platform chat the web app uses; the reply is posted back into the thread.

Typing `/works <your question>` takes the **same** path: the endpoint acks instantly with a private "on it" message (Slack gives a slash command three seconds to respond), then posts the answer into the channel when the model is done. A bare `/works` answers with a usage hint instead of an empty prompt, and each invocation is recorded in your Activity feed as a `slack.command` event.

Security: every delivery — events and slash commands alike — is verified with the app's signing secret (HMAC v0 over `v0:{timestamp}:{rawBody}`, ±300s timestamp tolerance, constant-time compare) and the endpoints **fail closed** — with no configured install, everything is rejected, including Slack's own `url_verification` handshake. Deliveries are attributed per workspace, so a command from a workspace no account has connected is refused rather than guessed.

## GitHub pull-request review

Point a repository webhook at `POST /api/ingest/github/events` and Agents review your pull requests.

On `pull_request` opened/synchronize — and on `@ever-works` mentions in PR comments — the reviewer matches the repository to a Work (across all three repo roles), builds a byte-capped diff, adds Knowledge-Base context and memory recall, makes one structured AI call, and posts the review. The review is keyed on the head SHA, so each pushed revision is reviewed exactly once and bot comments are never re-ingested.

Deliveries are verified with the configured webhook secret (HMAC SHA-256 over the raw body, constant-time compare) and the endpoint fails closed the same way. A missing `x-github-event` header is rejected outright.

> This per-repository receiver is distinct from the platform **GitHub App** webhook (`/api/github-app/webhooks`), which handles installation and push sync.

## Native connectors

Eleven connectors ship today, all in the `connector` plugin category. Each one declares up to two
independent legs, and the difference is what the two middle columns below record:

- the **`connector` capability** — the messaging leg, whose `direction` is `outbound`, `inbound` or
  `bidirectional`;
- the **`event-source` capability** — the ingest leg, a `pullEvents` sweep that feeds the event spine
  on the `event-ingest-tick` cron.

They are genuinely independent. A connector can be `direction: 'outbound'` and still pull a rich
event stream — Linear, Jira, HubSpot, Pipedrive, Bluesky and Mastodon are all exactly that.

| Connector            | Plugin id                    | `connector` direction | `event-source` | Brings in                                                                  | Pushes out                                          |
| -------------------- | ---------------------------- | --------------------- | -------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| **Slack**            | `slack-connector`            | bidirectional         | yes            | Channel messages and bot mentions from the configured channels             | Channel messages and threaded replies, Block Kit    |
| **Discord**          | `discord-connector`          | **outbound**          | **no**         | Nothing — this connector has no ingest leg                                 | Channel messages with embeds, via `discord.js` REST |
| **Linear**           | `linear-connector`           | outbound              | yes            | Issues created/updated, and comments                                       | Comments on Linear issues                           |
| **Notion**           | `notion-connector`           | outbound              | yes            | Pages created or edited — workspace-wide, or per database                  | Comments appended to Notion pages                   |
| **Jira**             | `jira-connector`             | outbound              | yes            | Issues created/updated, and comments                                       | Comments on Jira issues                             |
| **HubSpot**          | `hubspot-connector`          | outbound              | yes            | Contacts, companies, deals and custom objects                              | Notes appended to CRM records, and new records      |
| **Pipedrive**        | `pipedrive-connector`        | outbound              | yes            | Deals, persons and organizations                                           | Notes on those records, and new records             |
| **Zoom**             | `zoom-connector`             | inbound               | yes            | Completed cloud recordings, with transcripts when available → Meetings     | Nothing — ingest only                               |
| **Google Workspace** | `google-workspace-connector` | inbound               | yes            | Drive file changes, Calendar events, Meet recording transcripts → Meetings | Nothing — ingest only                               |
| **Bluesky**          | `bluesky-connector`          | outbound              | yes            | Mentions and replies, plus the connected account's own posts               | Posts and threaded replies over AT Protocol         |
| **Mastodon**         | `mastodon-connector`         | outbound              | yes            | Mention notifications and the account's own statuses                       | Statuses and threaded replies on your own instance  |

Every connector talks to its provider through that provider's own official SDK — `@slack/web-api`,
`discord.js`, `@linear/sdk`, `@notionhq/client`, `jira.js`, `@hubspot/api-client`, the `pipedrive`
Node SDK, `@zoom/rivet`, the Google API Node.js clients, `@atproto/api` and `masto`.

:::caution Discord is outbound only
The Discord connector's manifest declares `direction: 'outbound'` with `inbound: false` and
`reply: false`, and it does **not** declare the `event-source` capability. It posts into a channel;
it does not read one, and nothing from Discord reaches your Activity feed. Inbound Interactions API
routing is a documented follow-up — the connector's **Application public key** setting exists for
it and is unused today.
:::

[Connectors](./connectors.md) is the full catalog: every credential each one needs, the event kinds
it emits, how its events are routed to a Work, and what each connector deliberately does not do.

### How to enable a connector

1. Open **Sidebar → Plugins** (`/plugins`), or go straight to **Settings → Plugins → Connectors**
   (`/settings/plugins/connector`).
2. Press **Enable** on the connector's card, leave **Also enable for all works** ticked in the
   dialog, and press **Enable** again to commit — account-level _on_ does not cascade to your Works
   on its own.
3. Open the connector's settings form, paste its credentials, and press **Save Settings**.
4. Narrow the sweep with the scoping fields on the same form (`eventChannelIds`, `teamIds`,
   `databaseIds`, `projectKeys`, `objectTypes`, `entityTypes`, `driveFolderIds`, `calendarIds`).
   Empty usually means "everything".
5. Wait for the next sweep — `event-ingest-tick` runs every 5 minutes; there is no "sync now"
   button — then check **Sidebar → Activity** (`/activity`) or a Work's **Activity** tab
   (`/works/:id/activity`).

:::note There is no Settings → Integrations index page
`/settings/integrations` has no index page and soft-404s: the settings navigation deliberately omits
a bare **Integrations** tab. Only its two children exist — **Channels**
(`/settings/integrations/channels`) and **Emails** (`/settings/integrations/emails`), both of which
belong to [Notifications](./notifications.md). Connectors live under **Plugins**. Bare
`/settings/plugins` redirects to `/settings/plugins/ai-provider`, so link to
`/settings/plugins/connector` when you mean the connector catalog.
:::

:::tip Connectors are not notification channels
If what you want is routine outbound delivery — alerts, digests, run results pushed into a channel —
reach for a [notification channel](./notifications.md) instead. Slack, Discord, Telegram, WhatsApp
and Novu ship as a separate outbound-only plugin family with their own Settings screen and a
test-send button.
:::

## Meetings

A **Meeting** is a first-class record: title, start/end, source, participants, a deep link, and optionally a transcript. This section is the API surface; [Meetings](./meetings.md) covers the record itself — every field, the transcript enrichment fan-out, and the screens you create and read meetings on.

:::note Where to find it
Meetings have no sidebar entry of their own — a meeting is a _memory source_, so the catalog renders as the **Meetings** block on **Sidebar → Memory** (anchor `/memory#meetings`), right under the agent-memory panel. The source and Work filters, pagination and **New meeting** button are unchanged. The old `/meetings` link still works: it redirects to that block and carries its filters across. `/meetings/new` and the meeting detail pages (`/meetings/:id`) are unchanged.
:::

| Endpoint                            | What it does                                                 |
| ----------------------------------- | ------------------------------------------------------------ |
| `GET /api/meetings`                 | Your meetings, newest first. Filter by `workId` or `source`. |
| `POST /api/meetings`                | Create one manually or by import.                            |
| `GET /api/meetings/:id`             | One meeting, including the transcript body.                  |
| `PATCH /api/meetings/:id`           | Partial update.                                              |
| `DELETE /api/meetings/:id`          | Remove it.                                                   |
| `POST /api/meetings/:id/transcript` | Attach a transcript (size-capped at 200,000 characters).     |

Sources are `zoom`, `google-meet`, `manual` and `import`. Zoom recordings arrive through the ingest spine rather than this API.

Attaching a transcript stores it and then runs a **best-effort** fan-out: an AI summary, a memory observation, and a `meeting.transcript` envelope that lands on your Activity feed with the recording link. Only the transcript write can fail the call — every enrichment degrades gracefully, so a missing AI key costs you the summary, not the transcript.

List rows omit the transcript body; the detail endpoint includes it.

## Related

- [Plugin System](../plugin-system/index.md) · [Knowledge Base & Memory](./knowledge-base.md) · [Agents](./agents.md)
- [Connectors](./connectors.md) — the full eleven-connector catalog: credentials, event kinds, work-routing claims
- [Meetings](./meetings.md) — the Meeting record, transcripts, AI summaries and the Memory fan-out
- [Notifications](./notifications.md) — outbound channels (Slack, Discord, Telegram, WhatsApp, Novu) and event subscriptions
- [Plugins](./plugins.md) — enabling plugins, account-level vs work-level, the Settings → Plugins screens
- [Activity](./activity.md) — where ingested events land, and the Schedules view
