---
id: integrations
title: Integrations (Slack, GitHub, connectors, meetings)
sidebar_label: Integrations
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

Mention `@works` in a channel and the message is routed to the same platform chat the web app uses; the reply is posted back into the thread.

Security: every delivery is verified with the app's signing secret (HMAC v0 over `v0:{timestamp}:{rawBody}`, ±300s timestamp tolerance, constant-time compare) and the endpoint **fails closed** — with no configured install, everything is rejected, including Slack's own `url_verification` handshake.

## GitHub pull-request review

Point a repository webhook at `POST /api/ingest/github/events` and Agents review your pull requests.

On `pull_request` opened/synchronize — and on `@ever-works` mentions in PR comments — the reviewer matches the repository to a Work (across all three repo roles), builds a byte-capped diff, adds Knowledge-Base context and memory recall, makes one structured AI call, and posts the review. The review is keyed on the head SHA, so each pushed revision is reviewed exactly once and bot comments are never re-ingested.

Deliveries are verified with the configured webhook secret (HMAC SHA-256 over the raw body, constant-time compare) and the endpoint fails closed the same way. A missing `x-github-event` header is rejected outright.

> This per-repository receiver is distinct from the platform **GitHub App** webhook (`/api/github-app/webhooks`), which handles installation and push sync.

## Native connectors

| Connector   | Direction          | Brings in                                 |
| ----------- | ------------------ | ----------------------------------------- |
| **Slack**   | inbound + outbound | Channel messages, mentions; posts replies |
| **Discord** | inbound + outbound | Channel messages; posts replies           |
| **Linear**  | inbound + outbound | Issue activity; posts comments            |
| **Notion**  | inbound + outbound | Page activity; appends comments           |
| **Zoom**    | inbound            | Completed cloud recordings → Meetings     |

Enable them like any other [plugin](../plugin-system/index.md), under **Settings → Integrations**.

## Meetings

A **Meeting** is a first-class record: title, start/end, source, participants, a deep link, and optionally a transcript.

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
