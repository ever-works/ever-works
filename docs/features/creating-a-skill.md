---
id: creating-a-skill
title: Creating a Skill
sidebar_label: Creating a Skill
---

# Creating a Skill

A **Skill** is reusable guidance an [Agent](./agents.md) can consult — a convention, a checklist, a
house rule written once and read by every Agent that needs it. "How we format commit messages" is a
Skill. "Never paste an API key into a tool result" is a Skill.

This page covers writing your own. For the public catalogue Ever Works installs Skills from, and the
`SKILL.md` format itself, see the [Skills Catalog](./skills-catalog.md).

## The three steps

Go to **`/skills/new`** (Sidebar → **Skills** → new Skill). It is a short wizard: pick a starting
point, choose where the Skill lives, then write it.

### 1. Start from a template (optional)

The first step offers convention starters plus **Start from scratch**. On a default installation
there are three:

| Starter                  | What it is                                                        |
| ------------------------ | ----------------------------------------------------------------- |
| **Cron defaults**        | Conventions for cron expressions used in Work schedules.          |
| **Secret handling**      | How Agents should treat API keys and credentials in tool outputs. |
| **Commit message style** | Conventional-commit format, with examples.                        |

Picking one pre-fills the title and the description — and the body too, when the starter ships one.
Everything stays editable afterwards, and a starter never overwrites something you have already
typed. **Start from scratch** goes straight on with the fields empty. The catalogue is served by the
platform, so the exact list depends on your installation; if there are no templates at all, this step
is skipped and the wizard opens on the scope step.

### 2. Where should this Skill live?

Scope decides who can see the Skill. Five choices:

| Scope         | Meaning                                          |
| ------------- | ------------------------------------------------ |
| **Workspace** | Available across your whole workspace.           |
| **Mission**   | Scoped to a single [Mission](./missions.md).     |
| **Work**      | Scoped to a single [Work](./creating-a-work.md). |
| **Idea**      | Scoped to a single [Idea](./ideas.md).           |
| **Agent**     | Owned by a single Agent.                         |

Every scope except **Workspace** then asks **which** one, from a picker of the Missions, Works, Ideas
or Agents you already have. You cannot continue without choosing a parent — the **Next** button says
so.

If you have none of the kind you picked, the step tells you (_"No Missions yet — create one first, or
pick another scope."_) rather than showing an empty select. **Workspace** always works, so it is the
right answer when you are not sure.

### 3. Describe the Skill

| Field            | Notes                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Title**        | Required — e.g. _Code review checklist_.                                                                         |
| **Description**  | Optional, but do write it: this is the one-line summary **Agents see when deciding whether to load this Skill**. |
| **Instructions** | Optional Markdown body — the actual guidance.                                                                    |

The Description is the highest-leverage field on the page. An Agent reads the summary, not the whole
body, when it decides whether a Skill is relevant to what it is doing. A vague summary means a Skill
that is never consulted.

The Instructions editor has **Write** and **Preview** tabs; clicking the rendered preview flips back
to Write at that spot. You do not have to finish it here — the field's own hint points out that you
can refine the body later on the Skill's detail page.

**Create Skill** finishes. A missing title is refused with _"Title is required."_

## Related pages

- [Skills Catalog](./skills-catalog.md) — the public catalogue and the `SKILL.md` format.
- [Agents](./agents.md) — who reads Skills. · [Creating an Agent](./creating-an-agent.md)
- [Knowledge Base & Memory](./knowledge-base.md) — for institutional context rather than guidance.
- API reference: [Skills](../api/skills.md)
