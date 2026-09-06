# Existing substrate — what is already built, and where it is unreachable

**Status:** `Reference` · **Created:** 2026-09-06
**Audience:** anyone sizing or implementing an [Agent Workspace](./README.md) epic

A full read of the platform (17 subsystem inventories → 219 catalogued capabilities across
736 API routes, 55 API modules, 84 BFF handlers, 135 entities and 102 plugin packages) turned up
a pattern worth stating before any epic is estimated:

> **Most of this program is not "build the feature". It is "bind a finished backend to a screen."**

Repeatedly, a capability shipped complete — entity, endpoints, service logic, guards, tests — and
the UI increment never followed. The code is live, exercised by tests, and reachable only by
`curl`. Every row below is therefore a **UI-only or wiring-only** unit of work.

Read this before writing an estimate. Several epics that look XL are M once you know the routing
semantics, the confidence scoring, or the stream relay is already done and tested.

---

## 1. Finished backends with no UI at all

| Ref | What exists | What is missing | Epic |
| --- | --- | --- | --- |
| **S1** | **Workflows** — a visual-agent-orchestration graph backend: create/update/run a saved graph, list runs, read a run trace, output truncation, failure node id, step count. 8 tested routes, 2 entities. | Any UI whatsoever. Even a plain list + Run button would surface it. | [AW-21](./AW-21-capability-catalog/) |
| **S2** | **Escalation queue** — "what is waiting on me across every Work", confidence-ranked by an AI judge with a deterministic heuristic fallback, deduplicated, resolvable under a compare-and-set guard, already feeding the digest. | No page reads it. One list + a resolve button against three existing endpoints. | [AW-03](./AW-03-decision-queue/) |
| **S3** | **Agent↔node affinity** — "this agent runs on that machine" is fully implemented: entity, 3 endpoints, an enqueue-time snapshot into `fleet_jobs.targetNodeId`, a lease-time filter, and tests. | A node picker on the agent settings page. No `affinity` i18n key exists yet. | [AW-11](./AW-11-agent-computers/) |
| **S4** | **Per-agent Inbox** — list, detail and compose pages built with RFC-5321 recipient validation, a hardened server action and error scrubbing. | A tab entry in `AgentDetailTabs`, a `ROUTES` constant, and an i18n pass. The pages exist and nothing links to them. | [AW-05](./AW-05-agent-email/) |
| **S5** | **Email live stream** — a working server-sent-events endpoint with a 5 s poll, 15 s heartbeat, 10-minute lifetime cap and per-connection diffing. | The client hook it was written for was never built. | [AW-05](./AW-05-agent-email/), [AW-04](./AW-04-live-feed/) |
| **S11** | **Local model execution on a fleet node** — a complete CLI runner with process containment, Windows Job Objects, effort/permission/sandbox modes, timeouts and output limits. Built and tested. | No job kind dispatches to it. Add one kind + an executor registration. | [AW-11](./AW-11-agent-computers/) |
| **S14** | **Schedule aggregation** — one endpoint normalises **seven** heterogeneous cadence sources (recurring tasks, agent heartbeats, work schedules, mission ticks, source validation, data sync, inbound triggers) into a single row shape, with per-source fault isolation. | No first-class page. The home "Soon" block deliberately drops 5 of the 7 kinds. | [AW-10](./AW-10-schedules-calendar/) |
| **S19** | **Platform-admin cross-user × cross-Work usage view** — exists, guarded, throttled for PII. | No nav entry, no index page, and no way to discover a tenant id from the product at all. Three finished admin tools are undiscoverable. | [AW-01](./AW-01-command-palette/) |

## 2. Built at one scope, needed at another

| Ref | What exists | What is missing | Epic |
| --- | --- | --- | --- |
| **S8** | **Tool grants across four scopes** — resolve / check / upsert / delete for tenant, organization, work and agent, with narrow-only merge semantics over a permissive default. | UI exists only at agent scope. The org-scope card pattern already exists elsewhere and can be copied. | [AW-15](./AW-15-connections-scopes/), [AW-24](./AW-24-safety-rails/) |
| **S12** | **Task workflow templates** — instantiate a parent Task plus one sub-task per step with `dependsOn` blocker edges, agent assignees and approvers, in one transaction, with acyclic validation at write time. | It is buried under a page that also renders an older, unrelated catalog. Promote it. | [AW-21](./AW-21-capability-catalog/) |
| **S13** | **Inbound triggers** — HMAC-SHA256 signed public delivery, a 5-minute replay window, 24-hour rotation grace, a `(triggerId, dedupeKey)` idempotency ledger, event-matcher mode, template and single-task modes, test-fire, fire-now, and a fire log. | Nothing to build. It is under-surfaced and has a competing reduced UI. | [AW-10](./AW-10-schedules-calendar/) |
| **S15** | **Knowledge retrieval trail** — every retrieval logged, every consumption attributed by consumer type and id, with an existing panel component. This answers "why did the model see this document", which very few products can. | Surfacing beyond the workbench. | [AW-06](./AW-06-knowledge-library/), [AW-09](./AW-09-runs-receipts/) |
| **S18** | **Digest, personal and organization** — deterministic counts across runs, tasks, PRs, ingested events, goals and open escalations; an optional narrative that degrades with a visible reason; org-additive semantics; a quiet window that deliberately does *not* suppress open escalations. | Its dispatch summary is computed, logged, and surfaced nowhere. | [AW-13](./AW-13-attention-controls/) |

## 3. Stronger than expected — protect these, do not flatten them

| Ref | Strength | Why it matters to this program |
| --- | --- | --- |
| **S17** | **The streaming terminal stack** — attach-token minting, a WS gateway that refuses tokens in the query string, an in-memory relay with byte-bounded scrollback replay, retained pre-attach error banners, a pinned non-evictable exit frame, sequence dedup, driver/viewer/worker roles, persisted transcripts with GC, and xterm.js with a dependency-free DOM fallback. | [AW-11](./AW-11-agent-computers/) does not need a new streaming architecture. It needs this pointed at a node instead of a run, plus cross-replica fan-out (already a declared seam). |
| **S7** | **The job-runtime provider layer is finished** — 6 provider plugins, a binding factory routing all 11 dispatcher symbols, a per-tenant bring-your-own/override overlay with credential rotation, versioning and an append-only audit trail, and an operator per-tenant allow-list *with* a UI. | Two docs still claim this is unbuilt. The win here is deleting the stale docs. Every epic's background work rides this. |
| **S16** | **Two production vector stores behind a real port** — pgvector (bundled, row-filtered) and Qdrant (registry-installed, collection-per-Work), plus a coordinates table that drives re-embedding when the model or its dimensions change. | [AW-07](./AW-07-memory-context/) inherits multi-tenant RAG infrastructure rather than designing it. |
| **S9** | **Billing is fully implemented** — plan / pack / licence checkout, setup-intent payment methods, subscription mutation, seat quantity, pay-as-you-go meter events, invoice sync and webhook signature verification, behind a vendor-neutral provider abstraction. | The "coming soon" cards are a deployment flag, not missing code. [AW-17](./AW-17-costs-caps/) is mostly surfacing. |
| **S6** | **An OpenAI-compatible completions endpoint** that resolves providers, injects knowledge, redacts secrets and returns clean 422s on a bad model or key. It already serves two clients. | A shippable third-party API surface today; only docs and key scoping are outstanding. |
| **S10** | **Whole-account export / import / GitHub sync** — export as JSON with per-section toggles, preview an import with conflict resolution, apply it, and push/pull the account as a GitHub-backed config repo. | [AW-22](./AW-22-backup-export/) is largely *marketing an existing feature*, not building one. |
| **S20** | **Account-level repository registry** — repos independent of Works, one-click import, a `credentialMode` that is always a pointer and never a token, and encrypted per-path seed env files behind an owner-gated endpoint. | "Give this agent this repo with these env files" is already solved. |
| **S21** | **Machine-readable platform self-description** — an agent card advertising `register_work` over both REST and MCP, plus a works schema generated from the same schema the server validates with, so the two cannot drift. | Agent-to-agent onboarding is one unblocked pipeline away. |
| **S22** | **21 locales with a real translation pipeline** — cookie-based locale with no URL prefix, English deep-merge fallback, RTL support, a parity-sync script that seeds full paths, and an automated translation pass. | Every epic's i18n cost is lower than it looks. Note the parity script exists *because* a missing **parent** key collapses a whole subtree. |

---

## 4. How to use this document

1. **Before estimating an epic**, check whether its backend is in §1 or §2. If it is, the epic is a
   binding exercise and should be re-sized down.
2. **Before designing a mechanism**, check §3. We have production-grade streaming, RAG, billing,
   job-runtime and i18n substrate. Reusing it is faster *and* keeps behaviour consistent.
3. **Do not remove any of it** (NN #20). Several of these are invisible today; the fix is a route,
   a tab entry, a nav link or an i18n key — never a rewrite.
4. **Anything you surface must earn its keep**: if you bind a backend to a screen, it also needs
   its i18n keys, an empty state, and a test — the reason these never shipped was almost certainly
   that last mile.

> A recurring hazard worth naming: several of these features are invisible **because a route
> constant, a tab entry, or an i18n key is missing** — not because anything is broken. When an
> epic says "add the page", check first whether the page already exists and is simply unlinked.
