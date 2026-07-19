# Ever Works — Concepts & Taxonomy (canonical glossary)

**Status:** Reference · **Owner:** Product/Architecture · **Date:** 2026-07-19

This is the single canonical description of Ever Works' domain concepts and how they relate.
Its purpose is to keep everyone (and every agent) using **one vocabulary** and to prevent
building a second thing that already exists under a different name. When proposing a new
feature, check it against this map first: many "new" ideas are an existing concept viewed from
a different angle.

> **Naming law.** Routes, DB tables, API, and chat vocabulary use these exact words. In
> particular: a **Work is never called a "Project"** internally (it is both a project *and* a
> workflow in one), the internal **Tenant** is never surfaced in the UI, and "Company" is only
> the user-facing label for an **Organization** — same row.

## 1. The core chain

```
Tenant (internal, 1 per user)
└── Organization  ── UI: "Company"  ── an AI-staffed org; many per account
    ├── Mission ── an ongoing GOAL that continuously produces Ideas
    │   └── Idea  ── an atomic, one-shot proposal (1 Idea : 1 Work)
    │       └── Work ── the deployed, self-updating artifact
    │           └── Item(s) ── the content rows inside a Work (directory entries, posts, …)
    ├── Agent(s)  ── AI "employees" that do the work
    ├── Team(s)   ── optional grouping of Agents + members (org chart)
    ├── Task(s)   ── work tickets (can be recurring)
    └── Skill(s)  ── capability documents attached to agents/generators
```

- **Tenant** — internal isolation boundary, lazily created, **1 : 1 with a User**. Never shown
  in the UI (no "Personal"/"Workspace"/"Tenant" labels). Owns the scope columns on every row.
- **Organization** (UI: **Company**) — the tenant-scoped container an account works inside;
  many per account, switched via the header selector. Registering a legal entity (e.g. via a
  formation provider) is modelled as **a Work of `kind: company`** that links back to the Org.
- **Mission** — the most ambitious unit: a goal or project that **continuously drives Idea
  generation**, one-shot or on a schedule (cron), with an outstanding-Ideas cap and an
  optional `autoBuildWorks`. States: active / paused / completed / failed.
- **Idea** (entity: `WorkProposal`) — an **atomic, one-shot** proposal to build a single Work.
  Always **1 : 1** with the Work it becomes. Dismissed/accepted Ideas are kept but hidden.
- **Work** — the deployable, self-updating artifact (directory, blog, marketing site, store,
  app, awesome-list, …). **A Work is simultaneously what other tools split into "project" and
  "workflow."** Carries: Items, a per-Work Knowledge Base, deployments, generation history,
  schedules, members, a git data repo. `kind`: `default | company`. Status:
  `draft | active | registered | archived`. Built from a **blueprint** (see §4).
- **Item** — a content record inside a Work (a directory listing, a blog post, …). Items have
  source-validation and markdown editing.

## 2. The AI workforce

- **Agent** — a named, persistent AI "employee" (CEO, CTO, Researcher, …). **Scope** is one of
  `tenant | mission | idea | work` (an org/company scope is deliberately *not* in the enum;
  org association is via Team membership and stamping, not scope). An Agent has: a heartbeat
  cadence (or `manual`), a budget, permissions, attached Skills, identity files
  (`SOUL.md/AGENTS.md/HEARTBEAT.md/TOOLS.md/agent.yml`), runs + run-logs, and
  `reportsToAgentId` (its manager, for the Org Chart). Agents coordinate **only through
  Tasks** — there is no separate agent-to-agent message channel today.
- **Task** — a unit of work. Can be **recurring** (RRULE). Has assignees / reviewers /
  approvers / blockers / watchers, each an actor that is a **user or an agent**. `createdBy`
  is a user or an agent. Exactly 0-or-1 of `missionId | ideaId | workId`.
- **Skill** — a small Agent-Skills markdown document (frontmatter + instructions). Owned by one
  of `tenant | mission | idea | work | agent`. A **SkillBinding** injects a Skill into an agent
  and/or the generator's system prompt (priority-ordered).
- **Team** — an **optional** grouping of Agents **and** human members inside one Organization,
  with a `parentTeam` hierarchy, an optional manager agent, and an **Org Chart**. Teams never
  nest between Orgs.
- **team_resources** — the polymorphic association letting **Works / Tasks / Agents / Missions
  / Ideas belong to Teams** ("this Work is the Growth team's"). Distinct from Team *membership*
  (which is the agent/human roster) and from `agent_memberships` (an agent's reach).

## 3. Knowledge, scheduling, money, activity

- **Knowledge Base (KB)** — per-Work documents (chunked + embedded) edited in the KB workbench.
- **Memory** — the org-wide view over all KB across an Organization's Works, plus a **`memory`
  / RAG plugin category** so indexing/retrieval/synthesis frameworks are pluggable.
- **Schedules** — the unified read-model over everything that runs on a cadence: recurring
  Tasks, Agent heartbeats, Work schedules, Mission ticks, item source-validation, data-sync.
  Surfaced as the **Schedules** view on the Activity page (which itself renders the
  **Activity Log**).
- **Budget** — spend caps at the **Agent** and the **Work** level (warn %, hard-stop pause).
- **Activity Log** — the append-only event feed (UI: "Activity"). Scheduled/automated runs
  emit events here so they are visible, not just as run records.
- **Notification** — multi-channel (email + channels) per-user notifications.

## 4. Extensibility & catalogs

- **Plugin** — the unit of extensibility. Categories: `ai-provider`, `ai-gateway`, `search`,
  `content-extractor`, `screenshot`, `git-provider`, `deployment`, `data-source`, `pipeline`,
  `prompt-provider`, `connector` (bidirectional comms channels), `memory` (RAG), `utility`.
  Plugins declare metadata (`everworks.plugin`), settings (JSON-schema with `x-secret` etc.),
  and are distributed per the dynamic-plugin-distribution design.
- **Connector** — a first-party plugin category for communication channels, designed
  **bidirectional**: outbound actions **and** inbound control (route an inbound message to an
  Agent/Team) with pairing-code auth + per-conversation sessions.
- **Catalog repos (ADR-014)** — every curated dataset lives in its own GitHub repo, read by a
  paired platform service (no hardcoded catalogs):
  - **`ever-works/agents`** — Agent templates (CEO/CTO/…).
  - **`ever-works/orgs`** — prebuilt **Companies** (agentcompanies/v1 packages).
  - **`ever-works/works`** — Work **blueprints** (each points at an external template *code*
    repo to fork; type-tagged by `chipType`).

## 5. How to avoid building duplicates

Before adding a concept, ask:
- Is it a **Work** viewed differently? (project, workflow, pipeline, generated site → all Work.)
- Is it a **Mission** viewed differently? (recurring goal, campaign, "keep X updated" → Mission.)
- Is it an **Agent** viewed differently? (assistant, worker, bot, specialist → Agent.)
- Is it a **Task**, **Skill**, **Team**, or **Schedule** already? (ticket/issue → Task;
  capability/tool-recipe → Skill; squad/department → Team; cron/routine → Schedule.)
- Is it **extensibility**? Then it is almost certainly a **Plugin** in one of the categories
  above, and its curated content is a **catalog repo** — not new core tables.

Genuinely new concepts are rare. When one is, add it here in the same PR.
