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
- **Slash command** — the app's slash command (e.g. `/works`) points at `POST /api/ingest/slack/commands`.

Mention `@works` in a channel and the message is routed to the same platform chat the web app uses; the reply is posted back into the thread.

Typing `/works <your question>` takes the **same** path: the endpoint acks instantly with a private "on it" message (Slack gives a slash command three seconds to respond), then posts the answer into the channel when the model is done. A bare `/works` answers with a usage hint instead of an empty prompt, and each invocation is recorded in your Activity feed as a `slack.command` event.

Security: every delivery — events and slash commands alike — is verified with the app's signing secret (HMAC v0 over `v0:{timestamp}:{rawBody}`, ±300s timestamp tolerance, constant-time compare) and the endpoints **fail closed** — with no configured install, everything is rejected, including Slack's own `url_verification` handshake. Deliveries are attributed per workspace, so a command from a workspace no account has connected is refused rather than guessed.

## GitHub pull-request review

Point a repository webhook at `POST /api/ingest/github/events` and Agents review your pull requests.

On `pull_request` opened/synchronize — and on `@ever-works` mentions in PR comments — the reviewer matches the repository to a Work (across all three repo roles), builds a byte-capped diff, adds Knowledge-Base context and memory recall, makes one structured AI call, and posts the review. The review is keyed on the head SHA, so each pushed revision is reviewed exactly once.

The platform's own replies and unknown bots are never ingested — the loop must not echo its own output. Reviews, inline findings and summary comments from **trusted reviewer bots** (CodeRabbit, Copilot, Codex and Greptile by default; `GITHUB_TRUSTED_REVIEW_BOTS` to change the list, `none` to disable) become Task rejection feedback with a severity (`critical | major | minor`, mapped from CodeRabbit's Major/Minor/Critical and Codex/Greptile P1–P3) so the next resumed run fixes P2+ first. A `changes_requested` review from a trusted bot is recorded exactly as a human's would be; a bot comment is recorded, never reviewed. The platform's own `<GITHUB_APP_SLUG>[bot]` identity stays excluded even if it is listed. A trusted-bot finding with no recognisable marker is stored with no severity and the resumed run is told to treat it as major — an unrecognised marker is never read as a nit.

Deliveries are verified with the configured webhook secret (HMAC SHA-256 over the raw body, constant-time compare) and the endpoint fails closed the same way. A missing `x-github-event` header is rejected outright.

> This per-repository receiver is distinct from the platform **GitHub App** webhook (`/api/github-app/webhooks`), which handles installation and push sync.

## Issue and incident intake

_"File an issue, the fleet picks it up."_ Four inbound sources turn issues and incidents into ingested events that any event-sourced Task Trigger can match, and that the **triage filer** turns into exactly one Task each.

| Source                | Endpoint                         | Verified with (the vendor's own scheme)                                                          | Event                                                         |
| --------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| **GitHub issues**     | `POST /api/ingest/github/events` | `X-Hub-Signature-256` — GitHub App / repository webhook secret (same path as PR review)          | `github.issue` (`source: github`)                             |
| **Dependabot alerts** | `POST /api/ingest/github/events` | same                                                                                             | `incident` (`source: github`, `payload.provider: dependabot`) |
| **Jira Cloud**        | `POST /api/ingest/jira/events`   | `X-Hub-Signature` = `sha256=` HMAC-SHA256 over the raw body with the Jira webhook secret         | `jira.issue` (`source: jira-connector`)                       |
| **Sentry**            | `POST /api/ingest/sentry/events` | `Sentry-Hook-Signature` = hex HMAC-SHA256 over the raw body with the integration's client secret | `incident` (`source: sentry`)                                 |

Every receiver **fails closed**. A delivery whose signature cannot be verified with the vendor's own scheme is rejected (401) and nothing is filed; a receiver with no secret configured rejects everything; and no source ever falls back to "unsigned but trusted". Which account — and therefore which Organization and Work — an event lands in comes from the **install binding** (the same `ingest_install_bindings` table Slack and GitHub use), never from anything in the payload. The generic trigger fire URL cannot serve these vendors: it is signed with a per-trigger platform secret over `timestamp.body`, which no third party can reproduce.

### GitHub issues and Dependabot alerts

Subscribe the GitHub App (or the repository webhook) to **Issues** and **Dependabot alerts** — with the App, grant _Dependabot alerts: read_. Deliveries ride the existing GitHub receiver, so they are verified and attributed exactly like pull requests.

- `issues` actions `opened`, `reopened`, `closed`, `labeled`, `unlabeled`, `assigned`, `unassigned` and `edited` (title edits only — body edits are noise) become `github.issue` events. Pull-request threads (which GitHub also reports as issues) are skipped; the PR path owns them.
- The stable identity is `subject.externalId = owner/repo#number`; `sourceEventId` carries the action and timestamp, so a re-label is a new revision while an exact redelivery dedupes to zero.
- `dependabot_alert` actions (`created`, `reopened`, `reintroduced`, `auto_reopened`, `fixed`, `dismissed`, `auto_dismissed`) become `incident` events with `payload.provider: dependabot`, identity `owner/repo#dependabot-<alert number>`, the package as `culprit` and the advisory severity as `level`.
- Work routing uses the repository (`workHint: repo`), like every other GitHub event.

### Jira Cloud

The **jira-connector** plugin gains an inbound surface. In the connector's settings set a **Webhook secret**, then in Jira create a webhook (_Settings → System → Webhooks_) for `Issue: created / updated / deleted` pointing at `POST /api/ingest/jira/events` **with that same secret**. Jira then signs every delivery in `X-Hub-Signature`; a webhook created without a secret sends no signature and is rejected — there is no unsigned mode.

- `jira:issue_created` / `jira:issue_updated` / `jira:issue_deleted` become `jira.issue` events; an update whose changelog moves `status` is reported as a **transition** with `statusFrom` / `statusTo`. Descriptions arrive as wiki text or ADF and are flattened either way.
- The event shape is the same one the connector's pull sweep emits (`source: jira-connector`, identity `issue.id`, `sourceEventId = <id>:<updated>`), so a webhook and a later sweep of the same change dedupe against each other.
- Attribution is **per site**: the delivery's API self-links name the Jira site, which selects the platform user whose install is configured for that `baseUrl`; the delivery must then verify with that install's secret. A forged host can at most pick a secret the signature will not match. Unknown or ambiguous sites are refused as a clean no-op, never guessed.
- Work routing: claim the Jira **project key** under **Tracker team** in the Work's external references.

### Sentry

Create an **internal integration** in Sentry (_Settings → Developer Settings_) with a webhook URL of `POST /api/ingest/sentry/events`, enable **Alert Rule Action** and the **Issue** webhooks, and add it as the action of the alert rules you care about. Put the integration's **Client Secret** in `SENTRY_WEBHOOK_CLIENT_SECRET` on the API; Sentry signs every delivery with it (`Sentry-Hook-Signature`). Unset, the receiver answers 401 to everything.

Sentry signs with one platform-level secret, so a verified delivery proves it came from Sentry but not **whose** it is. The owner therefore claims the installation once, authenticated:

| Endpoint                                               | What it does                                                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/ingest/sentry/bindings`                     | Claim `{ installationUuid, label? }` (the uuid from the integration's installation page). First claim wins; another account's uuid is a 409. |
| `GET /api/ingest/sentry/bindings`                      | Your claims.                                                                                                                                 |
| `DELETE /api/ingest/sentry/bindings/:installationUuid` | Release one.                                                                                                                                 |

Deliveries for an installation nobody has claimed are a 200 no-op that files nothing; a signed `installation.deleted` removes the claim.

- `issue` (`created`, `resolved`, `unresolved`, `assigned`, `ignored`, `archived`, `unarchived`) and `event_alert` deliveries become `incident` events with `payload.provider: sentry`, identity = the Sentry **issue id**, and the issue link, `culprit`, `title`, `level`, last-seen `release`, `environment` and `project` on the payload. `error`, `comment` and `metric_alert` resources are acknowledged and dropped.
- Work routing: claim the Sentry **project slug** under **Tracker team** on the Work; `event_alert` deliveries carry only the numeric project id, so claim that too if you route alert-rule fires. Raw bodies are never logged — event alerts carry stack frames and user context.

### The `incident` kind

An incident is "something broke and somebody should look". Every incident source normalizes into the one `kind: incident` envelope with the same payload block (`provider`, `externalId`, `title`, `url`, `culprit`, `level`, `release`, `environment`, `project`, `status`, `action`), so a trigger with `eventMatcher: { kind: 'incident' }` matches all of them and `source` narrows to a vendor. Adding a source means implementing the small `IncidentSource` interface (`apps/api/src/ingest/incidents/`) behind whichever receiver verifies that vendor's signature — a CI-flake source over GitHub `workflow_run` / `check_run` deliveries is the documented next seam.

### Triage Tasks

The **triage filer** consumes `github.issue`, `jira.issue` and `incident` events from the spine and keeps **one Task per `(source, external id)`** in the Work the event routed to:

- First sight files a Task in that Work (under its tenant / organization) titled `[<key>] <title>` with the `triage` and `source:<source>` labels, a priority from the vendor severity (`fatal`/`critical`/`Highest` → P1, `error`/`high` → P2, `low`/`info` → P4, else P3), and a body carrying the link, culprit, level, last-seen release, environment, project, status, labels and assignees, plus the original text inside a neutralized `<source_content>` block (data, never instructions).
- The dedup key is persisted as an `external_issue_links` row (`UNIQUE (user, source, externalIssueId)`) pointing at the Task. A re-fired webhook, a re-label, a transition or a repeated Sentry alert finds that row and posts **one comment** with the delta on the existing Task — it never files a second one. An exact redelivery dedupes in the spine and produces nothing at all.
- Events that routed to no Work are left alone (a trigger may still act on them); a Work the owner does not hold is refused. Filing happens in the ingest drain (`event-ingest-tick`), so a Task appears seconds to a minute after the webhook.
- The filer matches on the event **kind**, not on how the event arrived. The jira-connector's poll sweep emits the same `jira.issue` kind, so issues it picks up are triaged too — which is the point, but it means turning on the connector's optional `backfillDays` window files a Task for every issue updated inside it whose project is claimed on a Work. Leave the backfill at its default (`0`, off) unless you want that history as Tasks.

### Matching intake in triggers

Any event-sourced Task Trigger sees these kinds with no extra wiring — for example `{ "source": "github", "kind": "github.issue" }` to hand new issues to an agent, `{ "kind": "incident" }` for every vendor's incidents, or `{ "source": "sentry", "kind": "incident" }` for Sentry only.

## Native connectors

| Connector   | Direction          | Brings in                                                         |
| ----------- | ------------------ | ----------------------------------------------------------------- |
| **Slack**   | inbound + outbound | Channel messages, mentions; posts replies                         |
| **Discord** | inbound + outbound | Channel messages; posts replies                                   |
| **Linear**  | inbound + outbound | Issue activity; posts comments                                    |
| **Jira**    | inbound + outbound | Issue activity (poll + Cloud webhooks, see above); posts comments |
| **Notion**  | inbound + outbound | Page activity; appends comments                                   |
| **Zoom**    | inbound            | Completed cloud recordings → Meetings                             |

Enable them like any other [plugin](../plugin-system/index.md), under **Settings → Integrations**.

## Meetings

A **Meeting** is a first-class record: title, start/end, source, participants, a deep link, and optionally a transcript.

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
