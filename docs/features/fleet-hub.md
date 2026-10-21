---
id: fleet-hub
title: Fleet hub (your computers in one place)
sidebar_label: Fleet hub
description: The Fleet hub — one sidebar entry for every computer you have, what needs a look first, one page per computer, and who in your Organization may do what on each one.
---

# Fleet hub

The **Fleet hub** is where your computers live in the app: one **Fleet** entry in the sidebar, directly below Teams, opening a hub with six tabs — **Overview**, **Computers**, **Sessions**, **Checkouts**, **Commands** and **Usage** — and one page per computer. It is built on the [Fleet](./fleet.md) registry: the same enrolled machines, the same API, the same audit trail.

:::info Status: shipped behind a flag

The hub ships behind `FLEET_HUB_ENABLED` (default off), on top of `FLEET_ENABLED`. With it off, the sidebar, **Settings → Fleet**, the runner pill and the command palette are exactly what they were. **Sessions**, **Checkouts**, **Commands** and **Usage**, and most computer-page tabs, say which part of the Fleet program brings them until it ships — never a spinner that waits for nothing.

The hub itself spends no tokens or credits.

:::

## Turning it on

| Variable            | Default | What it does                                                                                                                                                          |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLEET_ENABLED`     | on      | The Fleet registry (unchanged).                                                                                                                                       |
| `FLEET_HUB_ENABLED` | off     | The sidebar entry, every `/fleet` route, the hub's palette screens, the runner pill's **Manage** link to the hub, and **Settings → Fleet** in its policies-only form. |

With the flag off, `/fleet` and every page under it answer 404.

## Overview — what needs you first

The Overview answers "which of my computers need me?" before anything else.

- **Needs a look** lists what the registered checks found, critical first, then warnings, then notes, the longest-standing first. Each row names the computer, says the problem in plain words and offers at most one action. If the list cannot be read it says so and offers **Try again**; the cards below keep working. If one check could not run, the list says it may be incomplete rather than claiming nothing needs a look.
- **One card per computer**: favourites first, then online computers by most recent check-in, then the rest. A VM or container is listed under the computer it runs on ("VM on build-01"). Each card says its state in words beside the coloured dot (Online, Busy, Offline · last seen 2 h ago, Paused, Disabled, …), its OS, its health cells ("—" until a reading exists, marked when older than the last check-in) and when it last checked in. A computer someone else shares with you says **Shared with you**.
- A fleet with no computers explains what a computer is for and how to add one.

## Computers — the machine table

The **Computers** tab is the machine table that used to live on **Settings → Fleet**, moved as it was: the same columns, **Details** drawer, rename, disable and remove, the **Add computer** flow (one-time token, ready-to-run command, QR code, hand-off file) and your own cluster nodes. Two additions: a **star** per row (favourites sort first everywhere) and an **Open page** action beside Details.

**Add computer ▾** in the hub header opens the same Add flow preset to the kind you pick.

**Settings → Fleet** keeps the policies — the kill switch, panic controls, execution preferences, the cost ceiling and enrolment tokens — and points at the hub where the table was.

## A computer's page

`/fleet/computers/<id>` is one computer: its header — name, state in words, OS, when it last checked in, how long it has been up — and twelve tabs (**Overview**, **Sessions**, **Desktop**, **Logs**, **Services**, **Docker**, **Processes**, **Ports**, **Files**, **Schedules**, **Checkouts**, **Settings**). A tab that is not shipped yet names what brings it; a tab that needs the machine's management consent shows the exact command that grants it (`ever-works-node start --manage`) with a copy button; a tab that cannot apply to this kind of computer says so. **New session** and **Desktop** in the header are disabled until their parts of the program ship.

A computer that does not exist and a computer you may not see are the same 404 page.

### The ⋯ menu

| Act                                                | Confirmation                                                                                                 | Recorded      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------- |
| **Rename…**                                        | None — edit the name in place                                                                                | `node.rename` |
| **Add to favourites** / **Remove from favourites** | None (yours alone)                                                                                           | —             |
| **Pause** / **Resume**                             | None; a message says what happened                                                                           | `node.pause`  |
| **Drain** / **Return to fleet**                    | Drain asks once and names how many jobs in flight it releases back to the queue; the computer stays enrolled | `node.drain`  |
| **Copy link**                                      | —                                                                                                            | —             |
| **Remove from Fleet…**                             | Type the computer's name; its registration is deleted and nothing on the machine is touched                  | `node.delete` |

An act you may not use is shown disabled with the reason beside it — "Only the owner of build-01 can do this." or "Ask the owner of build-01 to allow org admins: lifecycle." — never hidden.

### Settings tab

**Who can do what on build-01.** A computer's owner decides, per action family, who besides them may act: **Only me**, **Organization admins** or **Organization members**.

| Family                                                                                                       | Covers                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| View                                                                                                         | Seeing the computer in the hub and opening its page (listing only)                               |
| Sessions · Desktop · Logs · Services · Docker · Processes · Ports · Files · Commands · Schedules · Checkouts | The matching tabs and their acts, as each ships                                                  |
| Lifecycle                                                                                                    | Rename, pause, drain, remove (and, as they ship, wake, VMs, cloud computers and Actions runners) |

Defaults: **View** is Organization members; every other family is **Only me**. **Desktop** is the take-over policy computers already had — a computer set to "Organization admins may take control" reads exactly that. Every change writes one `node.policy.change` audit row per family, naming the old and the new audience.

**Machine settings** (owner only) opens the same panel as **Details** on the Computers tab: capability tags, resource limits, the daily cost ceiling, the node's lifecycle and its credential.

## Who sees a computer

Every decision is made by the server, from your role on the computer:

| You are                                                                           | You get                                            |
| --------------------------------------------------------------------------------- | -------------------------------------------------- |
| Its owner                                                                         | Everything, always                                 |
| An admin of the Organization it is bound to (or that Organization's Tenant owner) | What each family allows **Organization admins**    |
| A member of that Organization                                                     | What each family allows **Organization members**   |
| Anyone else                                                                       | Nothing: the computer does not exist for you (404) |

A computer bound to no Organization is its owner's alone. Today nothing in the product binds a computer to an Organization yet, so every computer is visible to its owner only; the roles and the families take effect the day it can be shared.

A computer shared with you shows only what its owner decided to share — never its job history, load, cost ceiling, credential details or the owner's favourites.

## Keyboard and palette

The tab strips are keyboard tab lists (arrow keys, Home, End). The command palette lists **Fleet** and each hub tab.

## API

The hub reads and writes the [Fleet API](./fleet.md#managing-nodes); what it added:

```
GET    /api/fleet/nodes?scope=visible   your computers plus those shared with you, each with viewerRole
GET    /api/fleet/needs-a-look          what needs a look across every computer you may see (X-Fleet-Partial when a check was skipped)
GET    /api/fleet/nodes/:id/needs-a-look   the same for one computer
PATCH  /api/fleet/nodes/:id             + { isFavorite?, controlPolicyFamilies? } — owner only
DELETE /api/fleet/nodes/:id             + body { confirmName } — when sent it must be the computer's name (400 invalid otherwise);
                                        required when someone other than the owner removes it (409 confirmation_required)
```

Without `scope=visible`, `GET /api/fleet/nodes` is the owner-only list it always was, and the owner's `DELETE` without `confirmName` works exactly as before. Rename, pause, drain and remove follow the Lifecycle family: someone the family admits acts on the owner's computer and is recorded as the actor; anyone else gets `permission_denied` naming the family (or the 404, outside View).
