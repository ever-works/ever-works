# Feature Specification: Ever Gauzy Integration (Ever Works side)

**Feature ID**: `integrations-ever-gauzy`
**Status**: `Draft`
**Created**: 2026-10-15
**Last updated**: 2026-10-15
**Owner**: Product (Ruslan)
**Plan items**: EW-P1-7 (settings UI); the phase map below links the platform items.

> **Goal.** A Gauzy tenant owner connects their Gauzy tenant to their Ever Works tenant. From then on Tasks, Teams,
> Goals, Missions, Ideas, Docs, Agents and an Inbox sync in **both directions**: what Ever Works agents work on is visible
> in Gauzy (and through Gauzy in Plane and Ever Teams), and what humans do in Gauzy is visible to agents and humans in
> Ever Works.
>
> **Where the code lives.** The integration is built in the Gauzy codebase as the plugins
> `packages/plugins/integration-ever-works` and `integration-ever-works-ui`. Ever Works adds the platform capabilities
> they need and the small product surface specified here. **Ever Works never calls Gauzy's API**: Gauzy pulls and pushes
> with its key, and Ever Works only sends webhooks.

---

## 1. Decisions that shape the Ever Works side

| #   | Decision                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Connect **manually** with an `ew_int_` integration key created in Ever Works; one-click connect waits for Ever ID ([`integration-keys`](../integration-keys/spec.md)). |
| D2  | Ever Works Agents become Gauzy Employees (`kind='agent'`); Ever Works stays the owner of agents (read-only for the integration).                                       |
| D3  | Works = Gauzy Projects, linked explicitly; Gauzy never creates Works implicitly (P2 adds an opt-in repo-less `project` kind).                                          |
| D3b | Missions = Gauzy Strategic Initiatives.                                                                                                                                |
| D4  | Ideas = Gauzy tasks of issue type "Idea".                                                                                                                              |
| D6  | Keep per-user ownership; add `private` \| `team` \| `organization` visibility ([`record-visibility`](../record-visibility/spec.md)).                                   |
| D7  | Durable domain events (outbox, relay, feed, webhooks v2, plugin capability) — not `@nestjs/cqrs` ([`domain-events`](../domain-events/spec.md)).                        |
| D8  | Deletes on one side archive or cancel on the other; nothing is hard-deleted.                                                                                           |
| D9  | Spend safety: Gauzy-originated goals are drafts, missions paused, ideas never built.                                                                                   |
| D11 | A record on a Team is team-scoped on both sides; a record with no team is organization-scoped; `private` never syncs.                                                  |

## 2. User flow in Ever Works

1. **Settings → API keys → New key → type "Integration"**, or the preset link
   `https://app.ever.works/settings/api-keys?new=integration&preset=ever-gauzy`.
2. Name the key (for example "Ever Gauzy — Acme"), pick **one or more organizations** to pin it to, keep the preset
   scopes ([`integration-keys`](../integration-keys/spec.md) §3: everything except `org:write` and `email:write`).
3. Copy the key — shown once, starts with `ew_int_` — and paste it into Gauzy (Integrations → Ever Works → Connect).
4. Gauzy then validates with `GET /api/integrations/v1/whoami`, maps orgs, registers its webhook subscription
   (`POST /api/integrations/v1/webhooks` with `excludeOriginTags=['gauzy:<connectionId>']`), records the feed head and
   runs the initial sync.

**Revoke** in Ever Works: deleting the key disables it and its webhook subscriptions at once; Gauzy sees
`401 invalid_key`, pauses and asks its admin to reconnect.

## 3. Settings UI (EW-P1-7)

- **Settings → API keys**:
    - a **"New integration key"** dialog: name, org pins (multi-select), and a scope checklist with an **"Ever Gauzy"
      preset**;
    - integration keys listed separately from personal keys, with last use, scopes, pins and a **Rotate** action;
    - deep link `?new=integration&preset=ever-gauzy` opens the dialog pre-filled.
- **Settings → Integrations → "Ever Gauzy"** card: explains the manual connection, lists active integration keys of
  kind `ever-gauzy` and their webhook subscriptions, and a revoke action disables both.
- **Settings → Webhooks** (EW-P1-5): list, create, deliveries, redeliver — there is no UI for webhooks today.
- Fix the `alert()` placeholder on Settings → Integrations → Emails in the same area (EW-P4-3).

## 4. Default entity directions (set in Gauzy, shown here for reference)

| Entity                 | Default direction                         |
| ---------------------- | ----------------------------------------- |
| Members                | suggest only                              |
| Agents                 | Ever Works → Gauzy                        |
| Teams                  | both                                      |
| Works ↔ Projects       | link only                                 |
| Missions ↔ Initiatives | Ever Works → Gauzy                        |
| Goals                  | both                                      |
| Ideas                  | both                                      |
| Tasks + comments       | both                                      |
| Inbox                  | Ever Works → Gauzy items; state both ways |
| Docs                   | both, synced folders only                 |

## 5. What never syncs

Personal-scope Ever Works data; records with `visibility='private'`; time logs, screenshots and payroll; Ever Works
billing, credits and budgets; secrets, environments and fleet data.

## 6. Phase map (Ever Works items)

| Phase                     | Items                                                                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 Foundations            | EW-P1-1 domain events · EW-P1-2 integration keys · EW-P1-3 record visibility · EW-P1-4 API v1 · EW-P1-5 webhooks v2 · EW-P1-6 sync transitions + reopen · EW-P1-7 this UI · EW-P1-8 tests |
| P2 Goals, missions, ideas | EW-P2-1 ideas · EW-P2-2 goals (external metric) · EW-P2-3 task dates/estimate · EW-P2-4 repo-less `project` Work · EW-P2-5 missions · EW-P2-6 org + member roles                          |
| P3 Inbox and KB           | EW-P3-1 inbox events + act-as reply · EW-P3-2 KB events + org scope for all classes                                                                                                       |
| P4 Email                  | EW-P4-1 external inbound · EW-P4-2 email events · EW-P4-3 email fixes                                                                                                                     |
| P5 Future                 | Ever ID delegated writes (one-click connect); plugins consuming domain events                                                                                                             |

## 7. Definition of done (per phase)

- [ ] Specs updated, migrations on all three dialects, unit / contract / e2e suites green.
- [ ] Every AI review thread read and resolved.
- [ ] Deployed `develop → stage` and verified on stage against Gauzy stage: connect, initial sync, edits in both
      directions, a webhook delivery and a feed catch-up — proven from the running pod.
- [ ] Contract changes recorded with a version bump ([`integrations-api-v1`](../integrations-api-v1/spec.md) §8).
