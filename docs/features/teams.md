---
id: teams
title: Teams
sidebar_label: Teams
---

# Teams

A **Team** is a named group of [Agents](./agents.md) and people inside one **organization**, plus the Works and Agents that group is responsible for. Teams nest into each other, so you can model a real org structure — Engineering with a Frontend and a Backend sub-team under it — and see the whole thing drawn out on the Org Chart.

Reach for a Team when you have enough Agents that "which one owns this?" has stopped being obvious. Teams are organizational, not permissions: putting an Agent on a team labels it, it does not grant or restrict anything.

:::danger Teams only exist inside an organization — create one first
If your account has no organization, `/teams` shows **"Teams live inside an organization"** and nothing else. The **Create Organization** button in that empty state does **not** open a create form — it links to the dashboard home page.

The real action lives in the **workspace switcher at the top of the dashboard sidebar** (the row showing your logo or organization name, `aria-label` **"Switch Organization"**). Click it, then choose **+ Create Organization**. When the sidebar is collapsed the switcher is just the icon at the top — clicking it still opens the same menu.

Until an organization exists, `/teams`, `/teams/new` and `/teams/org-chart` all stay gated, and `/teams/<id>` returns a 404 page.
:::

## Teams vs. the other groupings

Ever Works has three things that all sound like "who works on this". They do not overlap.

| You want to…                                                       | Use a…                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| Group your Agents into Engineering / Marketing / Support           | **Team**                                                     |
| Draw a chart of who reports to whom across the whole organization  | **Team** hierarchy → **Org Chart**                           |
| Give another human permission to edit one website you are building | **[Work Member](./work-members.md)** (Manager/Editor/Viewer) |
| Say "these three Works belong to Engineering"                      | **Team** → the **Resources** section                         |
| Decide what an Agent is allowed to do (commit, spend, call tools)  | The Agent's own permission set — see [Agents](./agents.md)   |

Team membership carries **no permissions at all**. Work Members is the feature that grants and restricts access; Teams is the feature that describes structure.

## Creating a team

From the dashboard sidebar, open **Teams**, then **New Team** (or **Create a team** from the empty state). The form is one screen:

| Field             | Required | Notes                                                                                 |
| ----------------- | -------- | ------------------------------------------------------------------------------------- |
| **Name**          | Yes      | Up to 200 characters. The field stops you at 200 and the API enforces the same cap.   |
| **Description**   | No       | Up to 4000 characters, enforced by the API only — see the caution below.              |
| **Parent team**   | No       | Defaults to **No parent (top level)**. Lists the existing teams in this organization. |
| **Manager agent** | No       | Defaults to **No manager**. Lists your Agents.                                        |

Submitting takes you straight to the new team's page.

### The slug is derived and permanent

You never type a slug. It is generated from the name — lowercased, accents stripped, spaces turned into dashes, anything that is not a letter, digit, dash or underscore removed, then truncated to 100 characters. It must be unique **within the organization**, and **there is no way to change it later**: the settings page prints it under the title as read-only text, and the update endpoint does not accept a slug at all.

:::caution Two similar names can collide, and the error will not say so
`Engineering`, `engineering` and `Engineering!` all slugify to `engineering`. The second one you create is rejected by the API with a slug conflict, but the page only shows the generic toast **"Could not create the team"** — it does not mention the slug or the team it collided with. If a create fails and the name looks fine, check whether an existing team would produce the same slug.
:::

:::caution The description field does not enforce its own limit
**Name** stops accepting input at 200 characters. **Description** has no such stop in the browser, but the API rejects anything over 4000. Paste a long brief in and the save fails with the same generic **"Could not create the team"** / **"Could not update the team"** toast.
:::

## The team page

Opening a team shows its name, description, a **Manager** chip if one is set, a link up to the parent team, a **Settings** button, and the **Roster** and **Resources** sections. A third section, **Sub-teams**, appears only once the team actually has children — a leaf team shows two sections, not three.

### Roster — adding Agents

The **Add member** row at the bottom of the Roster takes a type, a **Who** picker, a role, and an **Add** button. Each row on the roster gets a **Remove** button, which acts immediately — there is no confirmation step.

:::warning You can only add Agents, and the "Type" dropdown does nothing
The **Type** dropdown lists **Agent** and **Member**, but **Member** is permanently disabled, and the value you pick is never used — the form always sends `agent` regardless. The **Who** picker only ever lists Agents. There is no way to add a human teammate to a team from this screen.

The API does accept human members (`memberType: "user"`), and the Org Chart draws them, so a roster populated another way will display correctly. The UI just has no path in.
:::

:::caution Only your first 100 Agents appear in the pickers
The **Manager agent** select, the roster's **Who** select, and the Resources **Agent** list are all fed by a single request for the first 100 Agents. Past 100, the Agent you want may simply not be in the list. The same 100-item cap applies to the Works offered in the Resources section.
:::

### Roles

| Role       | What it means                                        |
| ---------- | ---------------------------------------------------- |
| **Lead**   | Display label only. Shown as a highlighted chip.     |
| **Member** | Display label only. The default when you add anyone. |

Neither role grants anything. The **Manager agent** on a team is descriptive in the same way — it labels the team and positions the Agent on the Org Chart, it does not give that Agent authority over the roster or the team's Works.

:::note There are no per-organization roles yet
Access to teams is checked at the organization level and is all-or-nothing: if the organization belongs to your account, you can create, edit, re-parent and delete every team in it. There is no admin-vs-member split inside an organization, and the Lead/Member labels above are not part of any check.
:::

## Resources — what a team owns

The **Resources** section records that a Work or an Agent belongs to this team. Attached items are grouped by type, each links to its own detail page, and each has a **Remove** button that detaches it (it never deletes the underlying Work or Agent).

The **Attach a resource** form offers a type (**Work** or **Agent**), a search box, and a picker filtered to items not already attached.

The section displays five groups — **Works, Agents, Missions, Ideas, Tasks**. Missions, Ideas and Tasks can be attached through the API and will render here if they are, but the Attach form only offers Work and Agent.

An attached item must belong to the same organization as the team. Attaching something from elsewhere fails as "not found" rather than "not allowed", so a failed attach on an item you can see in another organization is expected behaviour, not a bug.

## Nesting teams

Set a **Parent team** at creation, or change it later in Settings. A team's sub-teams appear as cards at the bottom of its page, and the parent appears as a chip in the header.

Constraints the API enforces on re-parenting:

| Rule                            | What happens if you break it                                              |
| ------------------------------- | ------------------------------------------------------------------------- |
| A team cannot be its own parent | Rejected.                                                                 |
| No cycles                       | Rejected — moving a team under one of its own descendants is not allowed. |
| Maximum depth of **10** levels  | Rejected with "Team hierarchy exceeds the maximum depth of 10".           |

The depth check counts the **whole** result, not just the new parent's chain: the ancestors above the new parent plus the height of the subtree you are moving must together stay within 10. Moving a deep subtree under an already-deep parent can fail even though the parent itself sits well above the limit.

The Settings page pre-filters the **Parent team** dropdown so the team itself and its descendants are not offered — the cycle and depth checks above still run on the server.

## The Org Chart

**Org Chart**, in the header of the Teams page (also at `/teams/org-chart`), draws the whole organization as one tree:

- The **organization** is the root.
- **Teams** nest by parent. Inside a team: sub-teams first, then Agents, then human members.
- Agents are ordered so an Agent whose manager is on the same team is drawn after that manager.
- Agents with **no team** hang off the root, chained by who they report to.
- Agents that belong to your account but have not been assigned to any organization are shown too, so nothing is silently hidden.

Drag to pan; scroll to zoom, or use the **Zoom in** / **Zoom out** / **Fit** buttons. Clicking a team card opens that team; clicking an Agent card opens that Agent.

If the organization has no teams and no Agents, you get **"Nothing to chart yet"** instead.

## Settings and deleting

**Settings** on a team page lets you change the **Name**, **Manager agent**, **Description**, and **Parent team**. The slug is shown but not editable.

**Delete team** sits in a red **Danger zone** and opens a browser confirmation dialog — the first click never deletes anything. On confirm:

- **Sub-teams are not deleted.** Each moves up one level, taking the deleted team's parent as its own. A sub-team of a top-level team becomes top-level.
- **The roster is removed** — the membership records only.
- **Agents, people, Works and every attached resource survive.** Only the grouping disappears.

Deletion is not reversible; recreating a team with the same name gives you a new, empty team.

## Getting teams pre-built

When you create an organization from a **template** in the Create Organization dialog (the **Start from** list), the template can arrive with its teams, their rosters, their manager Agents and their nesting already set up — up to 20 teams. Imported Agents arrive paused, so review them before turning anything on. See [Company Builder](./company-builder.md) for where that is heading.

## A trap worth knowing

:::warning The Teams pages always use one organization, and you cannot pick which
Every Teams screen resolves the organization itself, by taking the **first** organization on your account — which is the **most recently created** one. The name shown as a chip in the page header is a label, not a picker.

If you have more than one organization, the Teams pages, the New Team form and the Org Chart all stay pointed at that same one. Selecting a different organization in the sidebar switcher does not move them.
:::

:::caution On a narrow window, the AI chat panel can sit over the buttons
On a narrow window — below roughly 768px, so phones and split-screen — the AI chat drawer overlays page content and can cover the **New Team** / **Org Chart** buttons in the page header, and the **Add** / **Attach** / **Save changes** buttons further down. Close the drawer or widen the window if a button will not take a click.
:::

## Related

- [Agents](./agents.md) — the AI workers you put on a roster.
- [Agents Catalog](./agents-catalog.md) — ready-made Agents to staff a team with.
- [Work Members](./work-members.md) — the feature that actually grants people access, per Work.
- [Creating a Work](./creating-a-work.md) — the Works you attach to a team.
- [Missions](./missions.md) · [Ideas](./ideas.md) — attachable to a team through the API.
- [Company Builder](./company-builder.md) — the organization-as-a-business direction Teams feeds into.
- [Teams & Organizations](../advanced/teams-and-organizations.md) — the underlying Tenant/Organization model.
