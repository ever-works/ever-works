---
id: creating-an-agent
title: Creating an Agent
sidebar_label: Creating an Agent
---

# Creating an Agent

This page walks the **`/agents/new`** wizard end to end. For what an Agent _is_ — scope, memory,
heartbeats, definition files, budgets — read [Agents (Your AI Employees)](./agents.md) first.

:::warning Agent runs need a background job runtime
Creating an Agent works on any installation. **Running** one does not: agent runs are dispatched by a
background job runtime, and where none is configured the dashboard shows a banner across the top —
_"Background job runtime is not configured. Agent runs cannot execute on this install until a job
runtime (e.g. Trigger.dev credentials) is set up."_

If you see that banner, treat it as an install prerequisite rather than a per-Agent problem: nothing
you configure on the Agent itself will make it run. Configure the runtime under **Settings → Job
Runtime**, or see [Workers](./workers.md). The banner is dismissible per browser, so its absence is
not proof a runtime is configured — a colleague may have dismissed it.
:::

## The three steps

### 1. Start from a template (optional)

The wizard opens on a grid of role templates plus **Start from scratch**. On the hosted platform
there are twelve:

- Project Manager
- Coder
- Researcher
- Copywriter
- Marketer
- Sales SDR
- Customer Support
- Directory Curator
- Growth/SEO Strategist
- Designer (UI/UX)
- DevOps/SRE
- Founder/Product Strategist

Picking one **pre-fills the Agent's name**, and its title from the template's description, then moves
you to the scope step. Nothing is locked in — both fields stay editable on the last step, and a
template never overwrites something you have already typed.

**Start from scratch** skips the pre-fill and moves on with empty fields.

The template catalogue is served by the platform rather than baked into the page, so the list depends
on your installation. A self-hosted install, or one whose catalogue cannot be reached, falls back to
a built-in set of role starters instead — trust the grid in front of you over any list, including
this one. If no templates are available at all, the wizard opens on the scope step.

### 2. Pick a scope

Scope decides where the Agent shows up and what it may act on. Four choices:

| Card                           | Scope                             |
| ------------------------------ | --------------------------------- |
| _Acts on your whole Workspace_ | **Tenant** — everything you own.  |
| _Locked to one Mission_        | One [Mission](./missions.md).     |
| _Locked to one Work_           | One [Work](./creating-a-work.md). |
| _Locked to one Idea_           | One [Idea](./ideas.md).           |

The workspace-wide card is the **Tenant** scope the rest of the documentation and the API refer to;
the wizard describes it by what it does rather than by its name, and it needs nothing else.

The other three then ask you to pick **which** Mission, Work or Idea, from a list of the ones you
already own — you never have to remember a UUID. **Next** stays disabled until you choose one, and
says why.

If you own none of the kind you picked, the step tells you so (_"You don't have any Missions yet —
create one to scope an Agent here."_) instead of showing an empty picker.

Scope is worth thinking about rather than defaulting: an Agent can only create or assign work at its
own scope or narrower. See [Agent scope](./agents.md#agent-scope).

### 3. Name your Agent

The last step is short:

| Field          | Notes                                                                       |
| -------------- | --------------------------------------------------------------------------- |
| **Name**       | Required, up to 120 characters — e.g. _CEO_, _Reviewer_, _Content Drafter_. |
| **Title**      | Optional, up to 120 characters. Pre-filled from the template's description. |
| **Team**       | Optional. Shown only when you have an active Organization with Teams.       |
| **Reports to** | Optional. Shown only when that Organization already has other Agents.       |

A banner above the fields restates the scope you chose, and the parent you picked, so you cannot
create a Mission-scoped Agent against the wrong Mission by accident.

**Team** and **Reports to** are how you place an Agent on an org chart. Both are hidden entirely if
you have no Organization — see [Teams & Organizations](../advanced/teams-and-organizations.md).
Reporting lines can only be drawn to Agents inside the same Organization.

**Create Agent** finishes and takes you to the new Agent.

## The Agent detail pages

An Agent's detail surface is split across several sub-pages, reachable from the Agent itself:

| Page             | Route                       |
| ---------------- | --------------------------- |
| **Activity**     | `/agents/<id>/activity`     |
| **Budgets**      | `/agents/<id>/budgets`      |
| **Inbox**        | `/agents/<id>/inbox`        |
| **Instructions** | `/agents/<id>/instructions` |
| **Settings**     | `/agents/<id>/settings`     |
| **Skills**       | `/agents/<id>/skills`       |
| **Terminal**     | `/agents/<id>/terminal`     |

The pages that have their own documentation are covered elsewhere: **Instructions** edits the Agent's
definition files ([Agents](./agents.md#agent-definition-files)), **Budgets** sets the per-Agent spend
cap ([Budgets & Usage](./budgets-and-usage.md)), **Skills** attaches reusable guidance
([Creating a Skill](./creating-a-skill.md)), and **Inbox** is the Agent's mailbox
([Agent Email & Inboxes](./agent-email.md)).

## Where to go next

- Give the Agent something to do — [Tasks](./tasks.md).
- Scope it to a long-running goal — [Missions](./missions.md).
- Cap what it can spend — [Budgets & Usage](./budgets-and-usage.md).
- Watch it work, or interrupt it — [Sessions & Steering](./sessions-and-steering.md).
- API reference: [Agents](../api/agents.md)
