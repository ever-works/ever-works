# FL-11 — Files & clipboard: browse allowed roots, move files, paste into a desktop

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no code. The only file references are the substrate citations program rule 13
> requires in §2; implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-11-files`
**Program:** [Fleet](../README.md) · Wave 2
**Branch:** `feat/fl-11-files`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** M · **Blocked by:** FL-02 (node link, `files` and `clip` channel families, operations) · **Related:** FL-01 (computer page shell, roles), FL-07 (the desktop a paste lands on), FL-14 (checkouts are roots), FL-19 (tool parity), FL-08 (shares the root rule, R-18)
**Extends (existing Ever Works nouns):** Node / Computer · Fleet · Checkout · Agent · Run · Activity Log · Fleet audit · Organization

---

## 0. TL;DR

A person who runs their own machines eventually needs to get a file on or off one — a log bundle
out, a config in, a build artefact from `build-01` to `build-02` — and to paste a snippet into a
window they are looking at. Today Ever Works can do none of that: the node's only file surface is
the per-Task worktree it provisions for itself, and every clipboard combination is deliberately
blocked on the live view. This epic adds a **Files** tab on the computer page limited to **allowed
roots** — the machine's checkouts, the node's workspace root, and any root the owner lists on the
machine; never the home directory by default — with list and stat, **upload and download streamed
through the link** with credits, progress and cancel, **machine-to-machine copy relayed through the
platform** (never node to node), same-name conflicts listed **before** anything is replaced, delete
behind a typed confirmation, credential-shaped file names flagged and refused for download until
the owner confirms, and a **clipboard paste** into a desktop view — text only, ≤ 256 KiB, opt-in per
view, never broadcast, never read back from the machine. Agents get the same as tools, marked
destructive where they write.

```
 ONE COMPUTER  (/fleet/computers/:id?tab=files)
 ──────────────────────────────────────────────────────────────────────────────────────────
 ← Fleet   build-01   ● online · Linux                                           [⋯]
 ┌ Overview │ Sessions │ Desktop │ Logs │ Services │ Docker │ Processes │ Ports │ Files ◀ │ … ┐
 │ Root: [ acme/api (checkout) ▾ ]   /  src  /  server                      [☐ Hidden files] │
 │ ┌─────────────────────────────────────────────────────────────────────────────────────┐ │
 │ │ ☐  Name                       Size      Modified            Kind                      │ │
 │ │ ☐  ..                                                                                 │ │
 │ │ ☐  📁 routes                            today 09:12          folder                   │ │
 │ │ ☐  📄 app.ts                  4.1 KB    today 09:40          file                     │ │
 │ │ ☑  📄 server.log              18 MB     today 09:41          file                     │ │
 │ │ ☐  🔒 .env                    312 B     12 Oct               file · credential-shaped │ │
 │ │ ☐  🔗 current → ../releases/42          yesterday            link (stays inside root) │ │
 │ └─────────────────────────────────────────────────────────────────────────────────────┘ │
 │ 1 selected · 18 MB     [ ⬇ Download ] [ ⬆ Upload ] [ ⇄ Copy to another computer… ] [ 🗑 Delete ] │
 │ Operations:  ⬇ server.log → your browser   62%   11.2 MB/s   [ Cancel ]                     │
 │ Only these roots are visible on build-01: 3 checkouts, the workspace root, /srv/shared.   │
 │ Transfers spend no credits; this one has moved 11 MB through Ever Works.                   │
 └──────────────────────────────────────────────────────────────────────────────────────────┘

 PASTE INTO A DESKTOP  (from the Desktop tab's ⋯ menu, FL-07)
 ┌ Paste text into design-mac ───────────────────────────────┐
 │ Goes to whatever has focus on design-mac's screen. Nothing │
 │ is read back from that computer.                           │
 │ ┌────────────────────────────────────────────────────────┐ │
 │ │ export DATABASE_URL=…                                  │ │
 │ └────────────────────────────────────────────────────────┘ │
 │ 1.2 KB of 256 KB                   [ Cancel ]  [ Paste ]  │
 └────────────────────────────────────────────────────────────┘
```

Two phases behind `FLEET_MACHINE_FACTS_ENABLED`:

| Phase | Ships                                                                                                                                                                                                                  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1 — Browse and move** | Allowed roots and the `--files-root` flag; the Files tab with list, stat, hidden toggle, breadcrumb; download and upload streamed with credits, progress, cancel; same-name conflicts listed first; credential-shaped names flagged and gated; delete with typed confirmation; read-only Agent tools; audit. |
| **P2 — Between machines, and paste** | Machine-to-machine copy relayed through the platform as one operation; the clipboard paste into a desktop view (opt-in per view, text ≤ 256 KiB); Agent copy/delete tools raising approvals; the paste tool, default denied. |

---

## 1. Overview

The **Files** tab shows a machine's files the way a careful administrator would want: only inside a
small set of **allowed roots** the machine itself declares — every Checkout on it (FL-14), the
node's workspace root, and any folder the owner adds on the machine with a flag. The home directory
is not a root unless the owner lists it; system folders never are. Paths are canonicalised on the
machine, and a link that points outside its root is shown but never followed.

Moving a file is an **operation**: it starts at once, shows progress and speed, and can be
cancelled; its bytes travel **through the platform over the node link** in bounded chunks with
credits, so a slow receiver never floods a sender and nothing is buffered without limit. Download
brings a file (or a folder, as an archive) to the browser; upload sends files from the browser to
a folder on the machine; **copy** moves files from one machine to another — the platform reads from
one node and writes to the other, and the two machines never speak to each other. Before anything is
replaced, the tab lists every same-name entry at the destination and asks.

Two guards are built in. Names that look like credentials — environment files, private keys,
keystores, cloud credential files — are **flagged** in the list and **refused for download** until
the owner confirms; Agents can never download them. **Delete** requires typing the target's name.

**Paste** is the clipboard's one sanctioned direction: text from the viewer's own clipboard into a
desktop view (FL-07), only while the viewer holds control, only when they switched it on for that
view, at most 256 KiB, and never the other way — the machine's clipboard is never read.

---

## 2. Why now

### 2.1 The user's question

> _"Get that log off build-01. Put this config on build-02. Paste this token into the window I am
> looking at. Why do I need a second tool for any of that?"_

### 2.2 What they do today, and what breaks

| To answer…                                   | Today they must…                                                                   | What breaks, with the substrate that proves it                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Show me the files on that machine."        | Open a shell session (FL-04) and `ls`.                                             | The node has no file surface. Its only root is the per-Task worktree pool: `--workspace-root` is "the absolute directory the per-Task worktrees of agent tasks" live in (`apps/node/README.md:65-67`), defaulting to `~/.ever-works/fleet-workspaces` (`apps/node/src/core/workspaces/fleet-task-workspace.ts:523-528`). The node core has `executors`, `model-execution`, `packaging`, `screen`, `windows-job-launcher`, `workspaces` — and no files module. |
| "Download that log."                        | Push it to a repo, or use another tool.                                            | Nothing streams a file off a node; the only streams are pictures and terminal frames (`apps/node/src/core/screen/frame-outbox.ts:14-38`).                                                                                                                                                                                                                                                                                      |
| "Copy it from build-01 to build-02."         | Nothing.                                                                           | No platform-relayed transfer exists; the trust model forbids node-to-node contact (README D2).                                                                                                                                                                                                                                                                                                                             |
| "Paste this into the window."                | Type it by hand while in control.                                                  | Clipboard combinations are deliberately blocked on the live view — "Clipboard combinations would move clipboard contents between the viewer's computer and the Agent's" (`packages/contracts/src/computer/computer-control.types.ts:140-146, 168-171`) and the injector refuses "a clipboard payload" outright (`apps/node/src/core/screen/input-injector.ts:20-22`). Right call for a bridge; this epic adds the one-way, opt-in paste instead. |
| "Let my Agent fetch that file."              | Nothing.                                                                           | The only Agent fleet tool lists nodes (`packages/agent/src/fleet/agent-fleet-tools.ts:39-42`); MCP exposes reads, affinity and drain (`apps/mcp/src/openapi-tools/whitelist.ts:475-530`); the CLI has one file, `apps/cli/src/main.ts`, and no fleet command.                                                                                                                                                                 |
| "Which files must never leave the machine?"  | Remember.                                                                          | The secret scanner knows credential *values* (`packages/contracts/src/secret/secret-patterns.ts:1-40`); nothing knows credential-shaped *names*.                                                                                                                                                                                                                                                                             |

### 2.3 The gaps this epic closes

1. **No file surface on a Node.** The root rule (R-18) and the `files` link family (CONTRACTS §3.3)
   are defined; nothing implements them.
2. **No bounded transfer.** Chunks, window, per-operation cap and entry cap are fixed in CONTRACTS
   §10; this epic is their first user.
3. **No sanctioned paste.** The live view blocks the clipboard for good reason; the owner still
   needs to put text into a window. One direction, opt-in, capped.
4. **Agents cannot move files.** Tool parity with the usual gates.

### 2.4 Why this epic is additive only

Nothing is removed or renamed. The blocked-shortcut list stays blocked; paste is a new, separate act
on a new channel. No entity is added — files are read from the Node and never stored as rows (README
§1); only audit rows and operation records (FL-02) are kept. There is no schema change (CONTRACTS
§13 reserves no slot for FL-11).

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Browse a root (owner).**
  **Given** `build-01` is online with `--manage` and has three checkouts and one `--files-root`,
  **when** the owner opens its **Files** tab,
  **then** the root picker lists the three checkouts by name, _"Workspace root"_ and `/srv/shared`,
  the first checkout opens at its top folder within 2 seconds, and the footer reads _"Only these
  roots are visible on build-01: 3 checkouts, the workspace root, /srv/shared."_

- **S2 — Download a file.**
  **Given** the owner selects `server.log` (18 MB),
  **when** they click **Download**,
  **then** the browser's download starts within 2 seconds, the Operations strip shows percent,
  speed and **Cancel**, the file arrives byte-identical, and an audit row records the read with the
  path and size.

- **S3 — Download a folder.**
  **Given** the owner selects the folder `routes`,
  **when** they click **Download**,
  **then** a single archive named `routes.zip` arrives containing the folder's files with their
  relative paths, links inside the folder preserved as links, links pointing outside it skipped and
  counted in the completion notice.

- **S4 — Upload with a conflict.**
  **Given** the owner drops `app.ts` and `README.md` onto the list, and `app.ts` already exists,
  **when** the upload is about to start,
  **then** a dialog lists `app.ts — 4.1 KB, modified today 09:40 on build-01` with **Replace**,
  **Skip** and **Replace all**; nothing is written until the owner chooses; after **Replace** the
  operation runs with progress and the list refreshes.

- **S5 — Copy between machines (P2).**
  **Given** `build-01` and `build-02` are both online with `--manage`,
  **when** the owner selects `dist/` on `build-01`, clicks **Copy to another computer…**, picks
  `build-02` → `acme/api` checkout → `/`,
  **then** same-name entries at the destination are listed first, the copy runs as one operation
  with progress visible on both computer pages and in Activity, the bytes pass through the platform
  only, and one audit row per machine records the copy.

- **S6 — Delete.**
  **Given** the owner selects `old-build/`,
  **when** they click **Delete**,
  **then** a dialog reads _"Delete old-build from build-01? Type its name to confirm."_, the button
  enables only on an exact match, the deletion runs, and an audit row records it.

- **S7 — Credential-shaped file.**
  **Given** `.env` is in the list,
  **then** it carries a lock glyph and _"credential-shaped"_; **Download** on it opens _"This
  looks like a credential file. Download it anyway?"_ with **Download** only after the owner
  confirms; the audit row records `confirmed: true`.

- **S8 — Paste into a desktop (P2).**
  **Given** the owner holds control of `design-mac`'s desktop view and has switched on **Allow
  paste into this desktop** for it,
  **when** they press `Ctrl/⌘+Shift+V` or choose **Paste text…**, approve the browser's clipboard
  read, and click **Paste**,
  **then** the text lands in the focused window on `design-mac` within 1 second, the dialog shows
  the size against the 256 KB cap, nothing is read from the machine's clipboard, and an audit row
  records the paste with its byte count only.

- **S9 — An Organization member browses (files audience).**
  **Given** the Node's `files` audience is `org-admins` and the viewer is an admin,
  **when** they open the tab,
  **then** they can list, download and upload under the same rules; delete still confirms by name;
  their name appears in every audit row.

- **S10 — An Agent lists files (read-only tool).**
  **Given** `Nina` may read the `files` family on `build-01`,
  **when** it calls the list tool for a checkout path,
  **then** it receives the same entries a person sees, credential-shaped names flagged, the Run's
  receipt shows the tool call and its tokens, and an audit row records `agent:<id>`.

- **S11 — An Agent copies between machines (P2).**
  **Given** `Nina` has the copy tool granted,
  **when** it asks to copy `dist/` from `build-01` to `build-02`,
  **then** the conflicts are listed in the tool result first, a replace needs an explicit flag, the
  operation runs under the Agent's Run, and the receipt shows bytes moved.

### 3.2 Edge cases, failures and refusals

- **U1 — Node offline.** The tab shows _"build-01 is offline — last heard from 2 h ago"_, an
  in-flight operation ends as `interrupted` with the bytes written so far named, and the open is
  refused `unreachable`.
- **U2 — Consent missing.** Without `--manage` the tab reads _"Machine management is switched off
  on build-01"_ with `ever-works-node start --manage` and the server answers `consent_missing`.
- **U3 — No roots.** A Node with `--manage` but no checkout, no workspace root and no `--files-root`
  shows _"build-01 has no folders Ever Works may show"_ and the exact flag to add one; `files` is
  not advertised.
- **U4 — Path escapes a root.** A request for `../../etc` or for a link whose target resolves
  outside its root is refused `invalid` with _"That path leaves its root"_; the link is listed with
  _"points outside the root"_ and no arrow to follow.
- **U5 — Permission denied.** A viewer outside the `files` audience sees the tab and _"Only the
  owner of build-01 can browse its files"_; the server refuses `permission_denied` with the hint.
- **U6 — Kill switch.** Opens are refused `kill_switch`; in-flight operations are cancelled within
  5 seconds with partial files removed on the receiving side; the fleet banner shows.
- **U7 — Link drops mid-transfer.** The operation pauses for the link's reconnect window; if the
  channel resumes it continues from the acknowledged byte, otherwise it ends `interrupted`, the
  partially written destination file is removed, and the notice says how much was moved.
- **U8 — Over a limit.** More than 5 000 entries → `limit_exceeded` _"Select fewer than 5 000
  items"_; more than 2 GiB → `limit_exceeded` naming the cap; a paste over 256 KiB is refused in
  the dialog before sending.
- **U9 — Destination not writable.** `operation_failed` with the first line of the machine's error
  and nothing half-written.
- **U10 — Same source and destination.** Copy to the same path on the same machine is refused
  `invalid` _"Source and destination are the same folder"_.
- **U11 — Paste without control or opt-in.** **Paste text…** is disabled with _"Take control
  first"_ or _"Switch on paste for this desktop first"_; the server refuses `permission_denied`
  with the same reason.
- **U12 — Paste with a credential-shaped value.** The text is sent as the owner asked; the dialog
  shows _"This looks like it contains a secret. It is sent only to design-mac and never stored."_
  and the audit row records only the byte count.
- **U13 — An Agent downloads a credential-shaped file.** Refused `permission_denied` with _"Only a
  person can download a credential-shaped file, after confirming"_ — no override.
- **U14 — Hidden files.** Off by default; the toggle persists per viewer; credential-shaped hidden
  files are still flagged when shown.
- **U15 — Cancel mid-way.** Cancel on a download stops the stream within 1 second; on an upload or
  copy the partially written file is removed and the notice reads _"Cancelled — 420 MB of 1.2 GB
  moved; nothing partial was left on build-02."_

---

## 4. Functional requirements

### 4.1 P1 — Roots and browsing

- **FR-1** The Files tab MUST show only paths inside the Node's allowed roots: every Checkout on the
  Node, the node's workspace root, and each folder the owner listed with `--files-root` on the
  machine (R-18).
- **FR-2** The home directory MUST NOT be a root unless the owner lists it explicitly.
- **FR-3** The Node MUST canonicalise every requested path and MUST refuse with `invalid` any path
  whose canonical form, or whose link target's canonical form, lies outside its root.
- **FR-4** The Node MUST advertise the `files` tag exactly when `--manage` is on and at least one
  allowed root exists.
- **FR-5** Listing a folder MUST return each entry's name, kind (file, folder, link, other), size,
  modification time, whether it is hidden, whether it is credential-shaped and, for links, whether
  the target stays inside the root.
- **FR-6** A listing MUST be capped at 5 000 entries and MUST say when it was truncated.
- **FR-7** Hidden entries MUST be excluded by default and MUST be included when the viewer switches
  the toggle, which MUST persist per viewer.
- **FR-8** A name MUST be flagged credential-shaped when it matches the program's fixed list of
  credential-file patterns (environment files, private keys and certificates with private material,
  keystores, cloud and package-manager credential files, shell history is not included).
- **FR-9** Browsing MUST require the viewer to be in the Node's `files` family audience (default
  `owner`), and the `view` audience alone MUST see the tab with the reason, never the entries.

### 4.2 P1 — Download, upload, delete

- **FR-10** Download MUST stream the selected entries through the node link to the viewer's browser
  in 64 KiB chunks under an 8 MiB credit window, and MUST never buffer more than the window on the
  platform.
- **FR-11** A single file MUST download as itself; several entries or any folder MUST download as
  one archive named after the selection, preserving relative paths and in-set links and skipping
  out-of-set links with a count.
- **FR-12** Upload MUST write only into an allowed root and MUST list every same-name entry at the
  destination, with size and modification time, before writing anything.
- **FR-13** The conflict choice MUST be per entry (Replace, Skip) with a Replace-all shortcut, and
  the default MUST be Skip.
- **FR-14** Every transfer MUST be an operation with percent, bytes, speed and **Cancel**, visible
  on the computer page and in Activity, and MUST end as `done`, `cancelled`, `interrupted` or
  `failed` with the bytes moved.
- **FR-15** A cancelled or interrupted write MUST remove the partially written destination file.
- **FR-16** One operation MUST NOT exceed 2 GiB or 5 000 entries; exceeding either MUST be refused
  `limit_exceeded` before any byte moves.
- **FR-17** Downloading a credential-shaped entry MUST require a `confirm` dialog for a person and
  MUST be refused `permission_denied` for an Agent.
- **FR-18** Delete MUST be `confirm-destructive`: the dialog MUST require typing the entry's name
  (for several entries, the parent folder's name) and MUST name the computer.
- **FR-19** Every list (first per root per visit), download, upload and delete MUST write an audit
  row — `node.files.list`, `node.files.read`, `node.files.write`, `node.files.delete` — with the
  root, the path, the byte count and the requester, never file contents.
- **FR-20** The tab MUST state that transfers spend no credits and MUST show the bytes moved
  through Ever Works for the current operation and for the day.
- **FR-21** Every refusal MUST carry one of the program's error codes with a `hint`, identical in
  the UI, the API and the tools.
- **FR-22** Every user-visible string MUST be an i18n key under the `fleet` namespace.
- **FR-23** When the kill switch is on, every `files` request MUST be refused `kill_switch` and
  every in-flight operation MUST be cancelled within 5 seconds (R-24).

### 4.3 P2 — Copy between machines

- **FR-24** Copy MUST read from the source Node and write to the destination Node through the
  platform only, and the two Nodes MUST never connect to each other.
- **FR-25** Copy MUST honour the destination's credits so the source never runs more than one window
  ahead.
- **FR-26** Copy MUST list same-name entries at the destination before writing, as upload does.
- **FR-27** Copy MUST write `node.files.copy` on both Nodes, each row naming the other Node.
- **FR-28** Copy MUST require the `files` audience on **both** Nodes and `--manage` on both.
- **FR-29** Copy of a folder MUST preserve relative paths, file modes where the destination supports
  them, and in-set links; it MUST skip out-of-set links with a count.

### 4.4 P2 — Clipboard paste

- **FR-30** Paste MUST send text only, at most 256 KiB, from the viewer's browser into the desktop
  view's machine through the `clip` channel, and MUST require `--attend`.
- **FR-31** Paste MUST be refused unless the viewer holds control of that desktop view **and** has
  switched on paste for that view; the switch MUST default to off and MUST reset when the view ends.
- **FR-32** The machine MUST place the text on its clipboard and send the platform's paste chord to
  the focused window; it MUST never send its clipboard contents to the platform.
- **FR-33** Paste MUST never be broadcast: exactly one view on one Node receives a paste.
- **FR-34** The paste dialog MUST show the size against the cap, MUST warn (without blocking) when
  the text looks like it contains a secret, and MUST say nothing is read back.
- **FR-35** Every paste MUST write `node.clip.paste` with the byte count only (see §8b for the
  CONTRACTS addition).

### 4.5 Agent tools (both phases)

- **FR-36** `fleet_files_list` and `fleet_files_stat` MUST be read-only tools returning what a
  person sees, with credential-shaped names flagged.
- **FR-37** `fleet_files_copy` MUST be marked destructive, MUST list conflicts in its result before
  any write, and MUST write only with an explicit replace flag.
- **FR-38** `fleet_files_delete` MUST be marked destructive with class `confirm-destructive` and,
  because an Agent cannot type a name, MUST raise an approval (Decision) the owner confirms instead
  of executing.
- **FR-39** `fleet_clip_paste` MUST be marked destructive, MUST be denied unless granted per Agent,
  and MUST follow FR-31 with the Agent as the controller.
- **FR-40** Tool results MUST enter the Run's receipt with their size and tokens, so an Agent's file
  listing answers "what did it cost?".

### 4.6 Accessibility and keyboard

- **FR-41** The list MUST be a keyboard-navigable grid with row selection by `Space`, open by
  `Enter`, up by `Backspace`, and the actions reachable by `Tab`; `Ctrl/⌘+Shift+V` MUST open the
  paste dialog only while controlling a desktop.
- **FR-42** Operation state changes MUST be announced through a live region.

---

## 5. UX

Copy below is the exact user-visible string (keys in the plan).

### 5.1 Files tab — loaded (see §0 mock)

Footer line 1: _"Only these roots are visible on build-01: 3 checkouts, the workspace root,
/srv/shared."_ with **How roots work**. Footer line 2: _"Transfers spend no credits; this one has
moved 11 MB through Ever Works. Today: 1.4 GB."_

### 5.2 Conflicts

```
┌ 2 of 5 items already exist in acme/api / src ───────────────────────────────────┐
│ app.ts        4.1 KB · modified today 09:40 on build-01     [ Replace ] [ Skip ]│
│ README.md     2.0 KB · modified 12 Oct on build-01          [ Replace ] [ Skip ]│
│ The other 3 items are new.                                                      │
│                                     [ Cancel ]  [ Skip all ]  [ Replace all ]   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Delete

```
┌ Delete old-build from build-01? ──────────────────────────────────┐
│ 1 folder · 212 files · 1.3 GB. This cannot be undone.             │
│ Type its name to confirm:  ┌──────────────┐                       │
│                            │ old-build    │                       │
│                            └──────────────┘                       │
│                                           [ Cancel ]  [ Delete ]  │
└───────────────────────────────────────────────────────────────────┘
```

Several entries: _"Delete 4 items from acme/api / src on build-01? Type the folder's name (src) to
confirm."_

### 5.4 Credential-shaped download

_"This looks like a credential file (.env). Download it anyway? It is sent only to your browser."_
`[ Cancel ] [ Download ]`

### 5.5 Copy to another computer

```
┌ Copy 1 item (1.2 GB) from build-01 ─────────────────────────────────────────┐
│ To computer   [ build-02 ▾ ]        ● online · Linux · management on       │
│ Root          [ acme/api (checkout) ▾ ]                                     │
│ Folder        /  dist                                     [ Browse… ]      │
│ Goes through Ever Works; build-01 and build-02 never talk to each other.   │
│                                              [ Cancel ]  [ Check and copy ] │
└─────────────────────────────────────────────────────────────────────────────┘
```

Offline or unmanaged destinations are listed greyed with their reason.

### 5.6 Operations strip and Activity

`⬇ server.log → your browser · 62% · 11.2 MB/s · [Cancel]`;
`⇄ dist/ · build-01 → build-02 · 420 MB of 1.2 GB · 48 MB/s · [Cancel]`.
Ended: _"Done — 1.2 GB in 26 s"_ / _"Cancelled — 420 MB of 1.2 GB moved; nothing partial was left on
build-02."_ / _"Interrupted — build-02 went offline after 900 MB."_ Activity shows the same rows
under the computer and in the owner's feed.

### 5.7 Unavailable states (each is the one reason)

_"build-01 is offline — last heard from 2 h ago"_ `[Wake] [Try again]` ·
_"Machine management is switched off on build-01"_ `ever-works-node start --manage` ·
_"build-01 has no folders Ever Works may show"_ `ever-works-node start --manage --files-root <dir>` ·
_"Only the owner of build-01 can browse its files"_ ·
_"Not available on this kind of computer yet"_ (desktop-node kind) ·
_"All computers are stopped — "<reason>" · since 08:55"_.

### 5.8 Paste (see §0 mock)

Disabled reasons on the menu item: _"Take control first"_, _"Switch on paste for this desktop
first"_. The desktop view's `⋯` menu gains **Allow paste into this desktop** (off; resets on end).
Secret warning line: _"This looks like it contains a secret. It is sent only to design-mac and
never stored."_

### 5.9 Palette

_"Files on build-01"_, _"Upload to build-01"_, _"Copy files to another computer"_.

---

## 6. Non-functional requirements

- **Performance:** a 1 000-entry listing renders ≤ 1.5 s p95; transfers sustain ≥ 20 MB/s through
  one API replica on a LAN-grade link; cancel stops the stream ≤ 1 s; paste lands ≤ 1 s.
- **Reliability:** no partial destination file survives a cancel, an interruption or a failure; an
  operation survives one link reconnect; credits make a stalled receiver pause the sender within one
  window.
- **Security & privacy:** paths canonicalised on the machine; link escapes refused; no file content
  in logs or audit; credential-shaped names gated; Agents never download them; paste is one-way and
  capped; the machine's clipboard is never read.
- **Observability:** audit per §4; Activity rows per operation; metrics for bytes moved, operations
  by kind and outcome, refusals by code.
- **Compatibility:** Linux, macOS and Windows nodes (paths shown with the machine's separators,
  compared canonically); the Node without `--manage` advertises nothing and loses nothing.

---

## 7. Key entities & concepts

| Entity / concept        | New?         | Description                                                                                                                   |
| ----------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **Node / Computer**     | Existing     | Declares its allowed roots; advertises `files`; gains `files` in its control policy map (FL-01 shape).                        |
| **Checkout**            | Existing (FL-14) | Each one is an allowed root.                                                                                               |
| **Allowed root**        | **New (concept, not stored)** | A folder the Node lets the platform see: a Checkout, the workspace root, or an owner-listed folder. Read live.    |
| **Entry**               | **New (not stored)** | One file, folder, link or other object in a listing, with its flags. Never a row.                                      |
| **Operation**           | Existing (FL-02) | A transfer in flight: kind, source, destination, bytes, state, cancel.                                                     |
| **Credential-shaped name** | **New (concept)** | A file name matching the fixed credential-file pattern list; flagged and gated.                                        |
| **Paste**               | **New (concept)** | One text payload into one desktop view's machine; opt-in, capped, audited by size.                                     |
| **Fleet audit**         | Existing     | `node.files.*`, `node.clip.paste`.                                                                                            |

---

## 8. Out of scope

- A file **viewer or editor**; previews; search across files (a Session's shell does that).
- Browsing outside allowed roots, or adding a root from the web UI (it is a flag on the machine).
- Clipboard **from** the machine, images or files on the clipboard, clipboard sync between machines.
- Drag-and-drop from the browser onto a computer card in the hub (drop onto the Files list only).
- Resumable uploads across browser reloads; a transfer is bound to its tab.
- Compression choices; archives are plain zip.
- Quotas beyond the per-operation caps.

## 8b. Open questions

- `[NEEDS CLARIFICATION: CONTRACTS change — §7 has no audit name for a paste; proposed `node.clip.paste` (details: bytes only). Also §3.3 lists `files.pack`/`files.unpack`/`files.delete` but no `files.cancel`; this spec uses FL-02's operation cancel — confirm `operation.cancel` and `DELETE /api/fleet/operations/:id` exist in FL-02.]`
- `[NEEDS CLARIFICATION: CONTRACTS §3.3 opens `clip` with `{ sessionId }`. This spec reads it as the **desktop view's** id (an AW-11 computer session, FL-07), not a `FleetSession`; a paste needs a focused desktop, which a PTY session does not have. Confirm, or rename the param to `viewId`.]`
- `[NEEDS CLARIFICATION: Should an owner be able to add `--files-root` from the node drawer (platform → node config) rather than only on the machine? R-18 says "in the node's local config"; this spec keeps it machine-only.]`
- `[NEEDS CLARIFICATION: Should `node.files.list` be audited at all (noise), or only once per root per visit as this spec proposes?]`
- `[NEEDS CLARIFICATION: Credential-shaped pattern list — fixed in contracts (proposed) or owner-extendable per Node?]`
- `[NEEDS CLARIFICATION: Daily bytes shown in the footer — per owner, per Node, or per Organization?]`

---

## 9. Acceptance criteria

- [ ] **ACC-FL11-01** (FR-1, FR-2, FR-4) The root picker lists exactly the checkouts, the workspace root and `--files-root` folders; home is absent; `files` is advertised iff a root exists.
- [ ] **ACC-FL11-02** (FR-3) `..`, absolute escapes and out-of-root link targets are refused `invalid` with the hint; in-root links open.
- [ ] **ACC-FL11-03** (FR-5–FR-8) Entries carry kind, size, time, hidden, credential-shaped, link-inside flags; 5 001 entries truncate with a notice; hidden toggle persists.
- [ ] **ACC-FL11-04** (FR-9) `view`-only viewers see the tab and the reason; the server refuses `permission_denied`.
- [ ] **ACC-FL11-05** (FR-10, FR-11) A 1 GiB download arrives byte-identical through 64 KiB chunks; the platform never holds more than 8 MiB; a folder arrives as `name.zip` with skipped out-of-set links counted.
- [ ] **ACC-FL11-06** (FR-12, FR-13) Upload lists conflicts first; default Skip; Replace all works; nothing is written before the choice.
- [ ] **ACC-FL11-07** (FR-14, FR-15) Operations show progress and cancel; cancelled/interrupted writes leave no partial file.
- [ ] **ACC-FL11-08** (FR-16) 5 001 entries or 2 GiB + 1 byte are refused `limit_exceeded` before any byte moves.
- [ ] **ACC-FL11-09** (FR-17) `.env` download confirms for a person and is `permission_denied` for an Agent.
- [ ] **ACC-FL11-10** (FR-18) Delete enables only on an exact name match and names the computer.
- [ ] **ACC-FL11-11** (FR-19) Audit rows for list (once per root per visit), read, write, delete carry root/path/bytes/requester and no content.
- [ ] **ACC-FL11-12** (FR-20–FR-23) No-credits statement and bytes moved shown; codes + hints identical across surfaces; no literal strings; kill switch cancels within 5 s.
- [ ] **ACC-FL11-13** (FR-24–FR-29) Copy moves bytes only through the platform (network capture shows no node-to-node connection), honours destination credits, lists conflicts, audits on both Nodes, needs both audiences and consents.
- [ ] **ACC-FL11-14** (FR-30–FR-35) Paste works only with control + opt-in, caps at 256 KiB, lands in the focused window, never reads back, audits bytes only, and the opt-in resets on view end.
- [ ] **ACC-FL11-15** (FR-36–FR-40) Tools carry the right annotations; delete raises a Decision; paste is default-denied; receipts show size and tokens.
- [ ] **ACC-FL11-16** (FR-41, FR-42) Keyboard grid operation and announcements verified; axe sweep clean.
- [ ] **ACC-FL11-17** Every FR has a passing test named in the plan.

---

## 10. Constitution gates

- [x] **I — Plugin-first.** No external integration; OS files on the owner's machine inside the
      node app (D8).
- [x] **II — Capability-driven.** No plugin id named anywhere.
- [x] **III — Source-of-truth repos.** Nothing from a machine is stored in the database; bytes
      stream through and are gone.
- [x] **IV — Job runtime.** No background job; operations are link-bound and FL-02 records them.
- [x] **V — Forward-only migrations.** No schema change (no FL-11 slot in CONTRACTS §13).
- [x] **VI — Tests.** Named per package in the plan.
- [x] **VII — Secrets.** No file content in logs or audit; credential-shaped names gated; paste
      audited by size only and never read back.
- [x] **VIII — Plugin counts.** Untouched.
- [x] **IX — Behaviour-first.** This document names no class or endpoint; §2 cites substrate only
      as program rule 13 requires.
- [x] **X — Backwards compatibility.** New tag, new link families (FL-02), new routes and tools;
      nothing existing changes shape.

---

## 11. References

- Program: [Fleet README](../README.md) (D2, D7, D8, §1 "machine's facts … never stored as rows",
  §3 "Broadcast clipboard" refused) · [CONTRACTS](../CONTRACTS.md) (R-18, R-24; §1, §2, §3.2–3.3
  `files`/`clip`, §7, §8, §9, §10) · [CAPABILITY-MAP §D](../CAPABILITY-MAP.md)
- Siblings: FL-02 node link and operations · FL-07 desktop view (paste target, control grant) ·
  FL-14 checkouts (roots) · FL-19 tools
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
- Constitution: `.specify/memory/constitution.md`
