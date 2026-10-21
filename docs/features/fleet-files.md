---
id: fleet-files
title: Files on computers (browse, download, upload, delete)
sidebar_label: Files on computers
description: The Files tab of a Fleet computer — only the folders the machine shares (its checkouts, the node's workspace folder, folders listed with --files-root), downloads and uploads streamed through the node link, conflicts listed before anything is replaced, credential-shaped files gated, delete by typed name; nothing stored.
---

# Files on computers

A computer's page in the [Fleet hub](./fleet-hub.md) has a **Files** tab for the moments you need to get a
file on or off a machine — a log bundle out, a config in — without a second tool. It shows **only the folders
the machine lets Ever Works see**, moves bytes **through the platform over the node link**, and **stores
nothing**: a listing is read from the machine when you open it, a download passes through to your browser, an
upload passes through to the machine.

Files need two things:

- the deployment switched it on — `FLEET_MACHINE_FACTS_ENABLED=true` (with the hub, `FLEET_HUB_ENABLED`, and
  the node link, `FLEET_NODE_LINK_ENABLED`); off, the tab shows that it is switched off and the routes answer
  404;
- the computer started with machine management on: `ever-works-node start --manage`. Without it the tab shows
  that exact command — nothing is ever read from a machine whose owner did not switch this on.

## Which folders are visible (allowed roots)

The **Root** picker lists the machine's allowed roots, and nothing outside them is ever shown:

| Root               | What it is                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Each checkout      | Every [checkout](./fleet-checkouts.md) on the machine that is ready                          |
| **Workspace root** | The node's own workspace folder (its Task worktrees, `--workspace-root`)                     |
| Each listed folder | A folder the machine's owner shared with `ever-works-node start --manage --files-root <dir>` |

The **home directory is never a root** unless the owner lists it, and a filesystem root (`/`, `C:\`) can
never be one. Roots are set **on the machine only** — there is no way to add one from the web. A machine with
`--manage` but no root shows _"build-01 has no folders Ever Works may show"_ and the flag to add one. The
footer always says which roots are visible: _"Only these roots are visible on build-01: 3 checkouts, the
workspace root, /srv/shared."_

Every path is checked **on the machine**: `..`, an absolute path, another drive, and a link whose target
leaves its root are refused (_"That path leaves its root"_). A link is listed as a link — _"stays inside the
root"_ or _"points outside the root"_ — and only a folder link that stays inside opens.

## Browsing

The list shows each entry's name, size, modification time and kind (file, folder, link, other), folders
first. Hidden entries (names starting with a dot) are off by default; **Hidden files** shows them and is
remembered for you in this browser. A folder lists at most **5 000** entries — more, and the list says so.

The list is a keyboard grid: **↑ / ↓** move, **Space** selects, **Enter** opens a folder, **Backspace** goes
one folder up; every action is reachable with **Tab**.

## Download and upload

- **Download** brings one file as itself, or several entries (or a folder) as **one `.zip`** named after the
  selection, keeping relative paths; links inside the selection stay links, links pointing out of it are
  skipped and counted. Your browser shows the download as usual.
- **Upload files** / **Upload a folder** (or drop files on the list) writes into the folder you are in.
  Before anything is written, every entry that already exists there is listed with its size and time — each is
  **Skip** by default, with **Replace**, **Replace all** and **Skip all**. Nothing is written until you choose.
- Uploads are written into a hidden partial folder on the machine and moved into place at the end, so a
  **cancelled, failed or interrupted upload leaves nothing partial** behind.

Transfers stream in 64 KiB chunks with flow control, so a slow receiver slows the sender and the platform
never holds more than 8 MiB of a transfer. Limits: **2 GiB and 5 000 entries per transfer**, refused before
any byte moves; **2 transfers at once per computer and 4 per person**. The **Operations** strip shows each
transfer with its progress, speed and **Cancel**, and how it ended (_"Done — 1.2 GB in 26 s"_, _"Cancelled —
420 MB moved; nothing partial was left on build-02."_). **Transfers spend no credits**; the footer shows how
much moved through Ever Works for this computer today.

## Credential-shaped files

Names that look like credentials — environment files (`.env`, `.env.*`), private keys and certificates
(`*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*.ppk`), keystores (`*.p12`, `*.pfx`, `*.jks`, `*.keystore`,
`*.kdbx`), package-manager and cloud credential files (`.npmrc`, `.pypirc`, `.netrc`, `credentials`,
`.aws/credentials`, `service-account*.json`, `.docker/config.json`, `kubeconfig`, `.kube/config`), and
`*.gpg` / `*.asc` — carry a lock and _"credential-shaped"_ in the list. Downloading one (or a folder with one
inside) first asks _"This looks like a credential file (.env). Download it anyway? It is sent only to your
browser."_ **An Agent can never download one.** Only names are checked, never contents.

## Delete

**Delete** asks you to type the entry's name — or, for several entries, the folder's name — and names the
computer: _"Delete old-build from build-01? Type its name to confirm."_ The button enables only on an exact
match. A link is removed as a link; its target is never touched.

## Who can browse

Files are the `files` family of the computer's control policy — **owner** by default; an owner can open it to
Organization admins or members on the computer's settings. Someone who can see the computer but not its files
sees the tab with _"Only the owner of build-01 can browse its files"_. While all computers are stopped (the
fleet kill switch), every files request is refused and running transfers are cancelled.

## What is recorded

One audit row per list of a root (once per visit), per download, per upload and per delete
(`node.files.list`, `node.files.read`, `node.files.write`, `node.files.delete`) with the root, the path, the
counts, the bytes and who asked — **never file contents**.

## Agents, MCP and the CLI

Agents get read-only tools — `fleet_files_roots`, `fleet_files_list`, `fleet_files_stat` — returning exactly
what the tab shows, flags included. MCP has the same three. Copying between computers, deleting from an Agent
(held for your approval) and pasting text into a desktop arrive with the next phase.
