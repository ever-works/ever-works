# Agent Workspace — program overview

**Program ID:** `agent-workspace`
**Status:** `Draft`
**Created:** 2026-09-06
**Audience:** Product, Engineering (backend + frontend), Design
**Governance:** [Spec Kit](../../README.md) · [Constitution](../../../../.specify/memory/constitution.md)

---

## 0. Why this program exists

Ever Works already runs agents. It has Agents, Missions, Tasks, Skills, Memory, Plugins, an
Inbox, an Activity Log, Schedules, Budgets, Teams, and a Fleet of nodes. What it does **not**
yet have is a coherent **operator surface** on top of all of it — one place where a non-technical
owner can hand out work, see what happened, and make the two or three decisions a day that only
they can make.

The gap is not capability. It is **legibility and loop-closure**:

| The user's question | Today | What this program adds |
| --- | --- | --- |
| "What is my team doing right now?" | Scattered across `/agents`, `/tasks`, `/missions`, `/activity` | One board, one feed, one home |
| "What needs *me*?" | Escalations and approvals live in separate places | A single decision queue that unblocks the work when answered |
| "What did it actually do, and what did it cost?" | Partially in agent sessions, partially in usage | One run receipt per execution |
| "How do I stop it?" | Per-surface controls | Pause / caps / approval gates as platform-enforced stops |
| "Where do I go?" | Deep sidebar tree | A command palette that reaches everything |
| "What can it even do?" | Read the docs | An in-product capability catalogue |

This program is **additive** (Non-negotiable #20). It removes nothing, renames no entity, and
introduces **no duplicate concepts** — every epic below maps onto a noun Ever Works already
owns. Where a new noun is genuinely required (Run receipt, Decision queue item, Changelog entry)
the spec says so explicitly and justifies it.

## 1. Vocabulary — no new synonyms

The single largest risk in a parity program is accidentally shipping a second word for a thing
we already have. The mapping is fixed here and every epic spec must honour it.

| Concept | Ever Works noun (canonical) | Do **not** introduce |
| --- | --- | --- |
| A unit of delegated work — the thing on a board card | **Task** | "mission", "job", "assignment", "ticket" |
| A step inside a unit of work | **Task** (a sub-task, via `parentTaskId`) | "sub-mission", "todo" |
| A standing initiative that keeps generating work | **Mission** | "campaign", "program" |
| A person-shaped worker | **Agent** | "teammate", "bot", "employee" |
| A decision only a human can make | **Approval** / **Escalation** → surfaced as **My Decisions** | "ticket", "request" |
| One agent execution | **Run** (`AgentRun`) | "session" as a user-facing word |
| Durable shared knowledge | **Memory** (facts) + **Knowledge Base** (documents) | "brain", "wiki" |
| A reusable capability | **Skill** | "recipe", "macro" |
| An external connection | **Plugin** (installed) + **Connection** (an account) | "integration" as an entity name |
| A machine an agent controls | **Node** (a member of the **Fleet**) | "computer", "VM", "worker" |
| A recurring definition | **Schedule** (+ **Trigger**) | "cron job", "automation" |
| An organisation's container | **Organization** / **Workspace scope** | "team" for the container (Team is a sub-unit) |

> "Computer" is allowed as **UI copy only** for the node-observation surface (epic AW-11),
> because it is the word an owner uses. The entity stays `FleetNode`.

### 1.1 `Task` vs `Mission` — the distinction that matters most

These two are the easiest thing in this program to get backwards, so the difference is settled
here and every epic must honour it. The entity lifecycles decide it:

| | `Task` | `Mission` |
| --- | --- | --- |
| What it is | "a trackable work item assigned to people or Agents" | a long-running initiative that continuously drives Idea generation, and via Ideas, Works |
| Statuses | `backlog · todo · in_progress · in_review · blocked · done · cancelled` | `active · paused · completed · failed` |
| Priority | `p0 · p1 · p2 · p3` | none |
| Cardinality | may be a sub-task of another Task; may be scoped to a Work, Mission, Idea, Team, Agent or Goal, in any combination | 1 Mission → many Ideas → many Works |
| Lifetime | finishes | ongoing until the owner ends it; ticks on a cron when `type = scheduled` |
| Recurrence | `isRecurring` makes the row a template that clones instances | `one-shot` or `scheduled` |

**Therefore:**

- **The board is a board of Tasks.** Backlog / In flight / Needs you / Done maps onto
  `TaskStatus`, not onto `MissionStatus`. A card is a Task.
- **A Mission is a source of Tasks**, alongside schedules, triggers, agents and people. It belongs
  on the board as a *filter* and as a *provenance chip on a card*, never as the card itself.
- "Delegate one sentence" creates a **Task**. "Set up something that keeps producing work"
  creates a **Mission**.

Any spec that puts `Mission` on a Backlog→Done board, or that invents a Mission-scoped comment,
watcher or priority, is wrong and must be rewritten onto `Task`.

## 2. The operating loop this program has to make obvious

```
        ┌───────────────────────────────────────────────────────────┐
        │  YOU DECIDE                        THEY DO                │
        │                                                           │
        │   Home  ──delegate──►   Task   ──picked up──►  Agent      │
        │    ▲                      │                       │       │
        │    │                      │ needs judgement       │ acts  │
        │    │                      ▼                       ▼       │
        │  My Decisions  ◄──opens── Approval        Run  ──►  Receipt│
        │    │                      ▲                       │       │
        │    └──answer──────────────┘                       ▼       │
        │          (the Task unblocks itself)        Live Feed / KB  │
        └───────────────────────────────────────────────────────────┘
```

Every epic below exists to make one arrow in that diagram fast, visible, or safe.

## 3. Epics

Each epic is a Spec Kit feature folder (`spec.md` + `plan.md` + `tasks.md`) under this
directory. `S` = size (S/M/L/XL), `Dep` = blocking dependencies.

| ID | Epic | Extends (existing Ever Works) | S | Dep |
| --- | --- | --- | --- | --- |
| [AW-01](./AW-01-command-palette/) | Command palette & global search | dashboard shell, all entities | M | — |
| [AW-02](./AW-02-task-board/) | Task board (columns, cards, staleness, steering) | `tasks` (Mission as a source + filter) | L | — |
| [AW-03](./AW-03-decision-queue/) | My Decisions — one queue that unblocks work | `agent-approvals`, `escalations` | L | — |
| [AW-04](./AW-04-live-feed/) | Live Feed & "while you were away" | `activity-log`, `events` | M | — |
| [AW-05](./AW-05-agent-email/) | Agent email end to end (drafts, caps, domains) | `inbox`, `mail` | XL | — |
| [AW-06](./AW-06-knowledge-library/) | Knowledge library (living docs, read-state, `#` refs) | `memory-files`, Works KB | L | — |
| [AW-07](./AW-07-memory-context/) | Memory, context files & the load meter | `memory`, `agentmemory` | L | — |
| [AW-08](./AW-08-skills-shelf/) | Skills shelf (badges, requirements, capture-from-run) | `skills` | M | — |
| [AW-09](./AW-09-runs-receipts/) | Runs & receipts (calendar nav, cost microscope) | `AgentRun`, `usage` | L | — |
| [AW-10](./AW-10-schedules-calendar/) | Schedules, calendar, heartbeats, NEVER-RUNS | `schedules`, `triggers` | L | AW-09 |
| [AW-11](./AW-11-agent-computers/) | Agent computers — watch, take over, teach | `fleet`, `apps/node`, `terminal` | XL | — |
| [AW-12](./AW-12-chat-channels/) | Chat, group chats, org channel, agent↔agent | `ai-conversation` | L | — |
| [AW-13](./AW-13-attention-controls/) | Notification matrix & attention budget | `notifications`, `digest` | M | AW-04 |
| [AW-14](./AW-14-whats-new/) | What's new — in-product changelog | *new (small)* | S | — |
| [AW-15](./AW-15-connections-scopes/) | Connections, scope presets, per-agent grants, vault | `plugins`, `tool-grants` | L | — |
| [AW-16](./AW-16-models-tokens/) | Model accounts, priority chains, fallbacks, effort | `job-runtime`, provider plugins | M | — |
| [AW-17](./AW-17-costs-caps/) | Costs, caps and credits (three meters) | `billing`, `budgets`, `usage` | L | AW-09 |
| [AW-18](./AW-18-shared-dashboards/) | Shared read-only dashboards & teammate access | `teams`, `organizations` | M | AW-02 |
| [AW-19](./AW-19-home/) | Home — the morning screen | `(dashboard)/(home)` | M | AW-02,03,04 |
| [AW-20](./AW-20-onboarding/) | First-hour onboarding & provisioning | `onboarding` | M | — |
| [AW-21](./AW-21-capability-catalog/) | "What you can do" — capability & playbook catalogue | `template-catalog` | M | AW-08 |
| [AW-22](./AW-22-backup-export/) | Backup & export the whole workspace | `settings/data` | S | — |
| [AW-23](./AW-23-agent-identity/) | Agent notes, personality, identity, levels | `agents`, instructions | M | AW-07 |
| [AW-24](./AW-24-safety-rails/) | Safety rails & the trust ladder | `policy`, `merge-policy` | M | AW-03,15,17 |
| [AW-25](./AW-25-help-center/) | Help centre in product | *new (small)* | S | AW-01 |

## 4. Where parity is tracked

- **[PARITY-MATRIX.md](./PARITY-MATRIX.md)** — every leaf capability, its current Ever Works
  state, its target, its epic, and its implementation status. This is the scoreboard.
- **[TRACKER.md](./TRACKER.md)** — spec status and implementation status per epic, updated as
  work lands.

## 5. Rules every epic spec in this program must follow

1. **Additive only.** Nothing is removed, renamed, or consolidated away (NN #20).
2. **No duplicate nouns.** Use the vocabulary table in §1. If you need a new entity, justify it
   in the spec's §4 and add it to the table here in the same PR.
3. **Behaviour-first spec, implementation-detail plan** (Constitution IX).
4. **Plugin-first for anything external** (Constitution I) — a new provider is a plugin package,
   never an inline client.
5. **Background work goes through the job-runtime provider** (Constitution IV).
6. **Schema changes ship with a forward-only migration** in the same PR (Constitution V, NN #16).
7. **Tests are a prerequisite** (Constitution VI): unit for logic, controller spec for endpoints,
   an e2e for any new user-visible flow.
8. **i18n**: every user-visible string is a key in `apps/web/messages/en.json`; leaf key names are
   camelCase and must never contain a literal `.`.
9. **Every new surface answers "what did it cost?"** — if a feature can spend money or tokens, its
   receipt links to the run that spent it.
