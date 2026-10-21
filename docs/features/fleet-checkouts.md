---
id: fleet-checkouts
title: Checkouts on computers
sidebar_label: Fleet checkouts
description: See every git clone and worktree on your computers, create new ones, fetch, pull and push from the dashboard, and tidy them away safely — a delete never throws away work without telling you.
---

# Checkouts on computers

"Where is this repository checked out, on which of my machines, on what branch, and is anything uncommitted there?"
The **Checkouts** tab of the [Fleet hub](./fleet-hub.md) answers that in one glance: every git clone and worktree on
every computer you can see, grouped by repository, each with its **git line** — branch, lines changed, files,
ahead/behind, uncommitted — and its size on disk.

```
 FLEET › CHECKOUTS                                       [Scan computers]  [+ New checkout]  Bin (2)
  Work "API" · acme/api                                     3 checkouts on 2 computers
   build-01   ~/code/api                     main        ✓ clean   ↓2        Found 2 h ago   [Fetch] [Pull] [Push] …
   build-01   …/checkouts/acme-api/fix-login nina/fix-login ⎇ +214 −38 · 6 files ↑3  Seen 1 min ago
   build-02   …/checkouts/acme-api/notes     ops/release-notes ⎇ ✓ clean ↑1
  ○ win-lab is offline — its 2 checkouts are shown as last known (3 h ago)
```

:::info Status: shipped behind a flag

Checkouts need `FLEET_CHECKOUTS_ENABLED=true` on the deployment (default off) and the [node link](./fleet-node-link.md)
(`FLEET_NODE_LINK_ENABLED=true`). With the flag off the tab says it is switched off and every `/api/fleet/checkouts`
route answers 404.

:::

## Where checkouts come from

- **Found on the computer** — the machine's owner lists the folders they keep code in, on the machine itself:

  ```bash
  ever-works-node start --manage --code-folder ~/code --code-folder ~/work
  ```

  **Scan now** walks those folders three levels deep for git clones (it stops at a clone's own folder, skips
  `node_modules`, build output and hidden folders, never follows a link, and stops at 300). Your home folder as a
  whole is never scanned, and the platform never chooses the folders.
- **The computer's own Task worktrees** — the worktrees Task runs use are listed too (badge **Task**), with a note
  when the computer's clean-up would tidy one. They are kept in sync by their runs.
- **Made by Ever Works** — **New checkout** makes a fresh clone, or a worktree of a checkout on the same computer on a
  new branch (a name already used gets `-2`, `-3`, …). New checkouts go under the computer's own checkouts folder,
  never inside another checkout.

A clone whose remote matches one of your repository Works shows that Work's name. A remote that carried a password
or token is stored with it removed, and the row says so.

## Fetch, pull, push

- **Fetch** needs no confirmation and works while a session runs in the checkout.
- **Pull** (fast-forward only) and **Push** ask once, naming the branch and the remote. Pull is refused while
  anything is uncommitted; both wait for a session working in the checkout.
- On a clone found on the computer these run exactly as your own terminal would, with your git login. On a checkout
  Ever Works made they use a **short-lived credential for that one repository**, minted through the GitHub App for
  that one operation and revoked when it ends — never the computer's own saved login. A repository no installation
  covers can be cloned and fetched anonymously, but not pushed.

## The bin, delete and forget

- **Archive** moves a checkout to the bin; the folder is not touched and **Restore** brings it back while the folder
  is still there.
- **Delete** (checkouts Ever Works made) first asks the computer what would be lost. When nothing would be, it asks
  once; otherwise it says exactly what — "2 uncommitted files and 1 commit not on any remote would be lost" — and
  asks you to type the checkout's name. The computer checks again before it deletes and refuses if more would be
  lost than you were shown. A worktree's branch is always kept; the bin shows the row as "folder removed".
- **Forget** removes the row of a checkout found on the computer; its folder is never touched (a scan finds it
  again).
- Rows in the bin whose folder was removed are dropped after 30 days.

## Container checkouts

Tick **Run sessions in a container** in New checkout and every session and command for that checkout runs inside a
fresh container with the folder mounted at `/workspace`. It needs Docker on the computer and is not available on
Windows. The image is the deployment's default (`FLEET_CHECKOUT_CONTAINER_IMAGE`).

## Shared folders

A new worktree can **link** folders of its parent that git ignores — `node_modules`, `.env.local`, a build cache —
instead of copying them. Tracked folders are never linked.

## Agents, MCP and the CLI

The same acts are Agent tools and MCP tools — `fleet_checkouts_list`, `fleet_checkouts_get`, `fleet_checkouts_create`,
`fleet_checkouts_sync`, `fleet_checkouts_archive`, `fleet_checkouts_delete` — checked against the computer's
**checkouts** audience for the Agent's owner, and a CLI group:

```bash
ever-works fleet checkouts list --node <computer id>
ever-works fleet checkouts create --node <id> --worktree-of <checkout id> --branch nina/fix-login
ever-works fleet checkouts sync <id> push --confirm
ever-works fleet checkouts delete <id> --confirm-name fix-login
```

## Who can do what

Reading checkouts follows the computer's **view** audience; scanning, creating, syncing, archiving and deleting
follow its **checkouts** audience (the owner by default — change it in the computer's Settings). While all computers
are stopped (Settings → Fleet), every act on a computer is refused; the list still shows the last-known rows. Every
act is written to the Fleet audit trail (`node.checkout.*`), never with a credential or a remote that carried one.
