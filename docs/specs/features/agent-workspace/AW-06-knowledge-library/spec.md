# AW-06 — Knowledge library

**Program:** [Agent Workspace](../README.md) · **Epic ID:** `AW-06-knowledge-library`
**Feature ID:** `knowledge-library` · **Branch:** `feat/knowledge-library`
**Status:** `Draft` · **Size:** L · **Depends on:** —
**Created:** 2026-09-06 · **Last updated:** 2026-09-06
**Audience:** Product, Engineering (backend + frontend), Design

> Behaviour-first per [Constitution IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code in this document — those live in [plan.md](./plan.md).
> **Additive only** (program rule #1): nothing in the Knowledge Base is removed, renamed or
> consolidated away. Every capability below is added on top of what ships today.

---

## 1. Overview

The **Knowledge library** turns the Knowledge Base from a per-Work filing cabinet into a shelf a
person can actually keep up with. It gives every organization one place that lists **all** its
Knowledge Base documents across every Work, organized into **folders the team chooses** rather than
only by document class; lets each person **pin** the handful they live in; shows a **NEW** badge on
documents they have never opened and an **UPDATED** badge on documents that changed since they last
read them, with a **rollup dot** on every folder that contains something they have not seen;
supports **archive** and **restore** so the shelf can be pruned without destroying anything;
**exports** any document or folder; and makes a document referenceable from **any composer in the
product** by typing `#`, so that the human sees a link and the agent receives the document's actual
content at run time.

The load-bearing idea is that agents write documents on a schedule and nobody announces it. A
library that mutates silently becomes unreadable within weeks — people stop opening it because they
cannot tell an absorbed document from one that quietly changed at 06:00. Read state is what keeps a
machine-written corpus legible to a human.

## 2. Why now

### 2.1 The question our users cannot answer today

> *"My agents have been writing to the knowledge base for three weeks. What is worth reading, and
> what changed since Tuesday?"*

They cannot answer it. Here is what they do instead.

| What the user wants | What Ever Works gives them today | What they do instead |
| --- | --- | --- |
| One shelf for everything the team knows | The organization-wide knowledge page is a **flat ranked list** with facet chips (type / Work / source / status). No folders, no personal ordering. | Scroll, then re-run the search they ran yesterday. |
| Group documents the way the team thinks | Documents are organized by **document class** and a git path (`<class>/<slug>`). Folders exist in the product — but only for **uploaded files**, only per-person, and documents cannot go in them. | Encode structure in document titles (`SUPPORT — refund policy`). |
| "These five are the ones that matter" | No pin anywhere in the Knowledge Base. | Keep a browser bookmark per document. |
| "What is new?" | Nothing. `updatedAt` is visible, but it also moves when a background job re-mirrors or re-embeds a document, so it is not trustworthy as a "someone changed this" signal. | Re-read documents from the top, hunting for the diff. |
| "Get this off my shelf, but keep it" | A document can be **archived** — and then it is stuck. There is no restore-to-shelf path; the only endpoint called "restore" restores a *body from an old commit*, which is a different thing. | Never archive anything. The shelf grows without bound. |
| "Send this to someone without an account" | No export of any kind for Knowledge Base documents. | Copy-paste out of the editor. |
| "Agent, use the voice guide" | `@kb:<reference>` works — in exactly **one** surface (the AI conversation composer), scoped to **one** Work, with **no picker**, so the reference has to be typed from memory and silently no-ops when mistyped. | Paste the whole document into the prompt every time. |

### 2.2 Why this is the right moment

1. **The substrate is already built.** Documents, classes, tags, locking, version history,
   citations, retrieval trail, org-level inheritance, the review queue and the two-layer
   (row + git) persistence all ship today. The library is a *reading and curation* layer on top —
   it adds one small table and five columns, not a new store.
2. **Scheduled agent writing already exists.** Works run on schedules and write documents; the
   consolidation tick proposes synthesized documents weekly. The volume that makes read state
   necessary is already being generated.
3. **The reference plumbing already exists but is stranded.** Reference parsing and resolution are
   implemented and tested; they are wired into one composer. Extending the same resolution to every
   composer and to agent runs is a wiring job, not a new mechanism.
4. **It compounds.** Every hour spent writing a good document is an hour subtracted from every
   future prompt that would otherwise have to re-explain the same thing. The library is the surface
   that makes that trade visible and therefore worth making.

### 2.3 The three shapes of living document we must support

These are the shapes our users already produce, and each implies different update semantics:

| Shape | Example | Update semantics | Which badge earns its keep |
| --- | --- | --- | --- |
| **Refreshed on a cadence** | A market brief a scheduled Work rewrites every Monday | Rewritten in place | `UPDATED` |
| **Written once, read forever** | A support playbook, a voice guide, an audience profile | Human- or agent-authored, then stable and heavily cited | Neither — but pinning matters |
| **Accumulating series** | A weekly report, one document per week, filed together | New sibling documents appear in a folder | `NEW` + the folder rollup dot |

All three must be first-class. That is why the spec ships `NEW` *and* `UPDATED` *and* folder
rollups: the three shapes stress different parts of the same mechanism.

---

## 3. User scenarios

Written as Given / When / Then. Unhappy paths are numbered in the same sequence, not appended as an
afterthought.

### 3.1 Happy paths

**S-1 — The morning skim.**
**Given** an owner whose agents wrote to four documents overnight and created one new one,
**when** they open the Knowledge page's Library view,
**then** they see the four changed documents carrying an `UPDATED` badge and the new one carrying a
`NEW` badge, the two folders containing them carrying a rollup dot, their pinned documents at the
top of the list, and a header reading `5 unread`.

**S-2 — Reading clears the badge, for me only.**
**Given** a document carrying `UPDATED` for two teammates,
**when** one of them opens it and it stays on screen for 2 seconds,
**then** the badge clears for that person, the folder's rollup dot clears if nothing else in that
folder's subtree is unread for them, and the other teammate's badge is untouched.

**S-3 — Filing a document into a folder.**
**Given** a document created by an agent and sitting in **Unfiled**,
**when** an editor drags it onto the `Playbooks` folder (or presses `f` and picks the folder),
**then** the document moves, the list updates without a full reload, and an entry appears in the
activity log naming the document and the destination folder.

**S-4 — Pinning.**
**Given** a person who consults the same three documents daily,
**when** they press `p` on each,
**then** those three sort to the top of every library list for that person under a `Pinned` heading,
independent of folder, and stay there across sessions and devices. Nobody else's list changes.

**S-5 — Archiving and restoring.**
**Given** a stale document cluttering a folder,
**when** an editor archives it,
**then** it leaves the default list, stops appearing in the reference picker, stops being injected
into agent context, and remains fully readable under **Archived**. **When** they later restore it,
**then** it returns to the folder it was archived from, with its history and read state intact.

**S-6 — Referencing a document in a composer.**
**Given** a person writing a message to an agent in any composer in the product,
**when** they type `#vo`,
**then** a picker appears within 150 ms listing at most 8 matching documents, most-recently-read
first; **when** they press `Enter`,
**then** a reference chip reading `Voice guide` is inserted; **when** they send,
**then** the human-visible message shows a link to that document and the agent's run receives the
document's content, and the run's receipt lists it as a resolved reference.

**S-7 — Export.**
**Given** a person who needs to hand a playbook to somebody outside the workspace,
**when** they choose **Export → Markdown** on the document,
**then** they get a single `.md` file containing the document's front matter and body, named after
its slug, within 3 seconds.

**S-8 — Bulk export of a folder.**
**Given** a folder with 60 documents,
**when** the person exports the folder,
**then** the export is queued, they see `Preparing export — we will notify you`, and within a few
minutes a download link valid for 24 hours arrives in their notifications, resolving to a `.zip`
whose internal directory structure mirrors the folder tree.

**S-9 — Mark all as read.**
**Given** a folder with 31 unread documents the person has decided not to read,
**when** they choose **Mark folder as read**,
**then** every document in that folder's subtree is recorded as read at its current revision for
that person only, the rollup dot clears, and the action is undoable for 10 seconds via
`Undo — 31 documents marked read`.

**S-10 — Nesting.**
**Given** the `Playbooks` folder,
**when** an editor creates `Playbooks / Support` and moves 8 documents into it,
**then** the `Playbooks` rollup dot reflects unread documents anywhere in its subtree, and the
breadcrumb in the document header reads `Playbooks / Support / Refund policy`.

### 3.2 Unhappy paths, races and empty states

**S-11 — A background job touches a document (must not fire UPDATED).**
**Given** a document a person has already read,
**when** the git mirror job writes a new commit reference to it, or the embedding job stamps a new
index timestamp, or the org-overlay fan-out re-writes its sidecar,
**then** **no** badge appears for anybody. Only a change to the document's title, description,
tags, class, or its whitespace-normalized body counts as a change.

**S-12 — A whitespace-only edit (must not fire UPDATED).**
**Given** a document a person has read,
**when** an editor reformats it — reflows paragraphs, changes indentation, adds trailing newlines —
without altering a single non-whitespace character,
**then** no `UPDATED` badge appears for anyone.

**S-13 — An agent reads a document (must not clear anything).**
**Given** a document carrying `UPDATED` for a person,
**when** an agent run resolves and reads that document as context,
**then** the person's badge is unchanged. Agent reads never touch human read state.

**S-14 — Read/write race on the same document.**
**Given** a person with a document open and reading,
**when** a scheduled agent run rewrites it mid-read,
**then** a non-blocking banner appears reading
`This document changed while you were reading it. Reload to see the new version.` with a **Reload**
action; the person's read mark is **not** advanced past the version they actually saw, so it will
still show `UPDATED` in the list until they reload and dwell.

**S-15 — Concurrent human edit and agent rewrite.**
**Given** a document being edited in the workbench,
**when** a scheduled run tries to rewrite it,
**then** the existing lock semantics decide the outcome — a locked document rejects the agent write
and the rejection is logged; an unlocked document is rewritten and the human editor gets the S-14
banner. The library adds no new conflict model; it surfaces the outcome.

**S-16 — Reference to a document the person cannot see.**
**Given** a person without view access to Work B,
**when** they type `#` in a composer,
**then** Work B's documents never appear in the picker; **and** if they paste a reference to one by
hand, **then** it renders as literal text, resolves to nothing at run time, and the run receipt
records `1 reference could not be resolved` — with no hint that the document exists.

**S-17 — Ambiguous or dangling hand-typed reference.**
**Given** two documents whose slugs both match a hand-typed short reference,
**when** the message is sent,
**then** the reference is **not** resolved (no guessing), it stays literal text, and the composer
shows an inline hint before sending: `#refunds matches 2 documents — pick one from the list.`
A reference matching nothing behaves identically with `#nope matches no document.`

**S-18 — Reference budget exceeded.**
**Given** a message containing 9 references,
**when** it is sent,
**then** the first 5 (in document order) are resolved, the rest are left as links only, and the
composer warns before sending:
`Only 5 documents can be attached to one message. The other 4 will be links, not context.`

**S-19 — A referenced document is longer than the budget.**
**Given** a referenced document whose body exceeds 6 000 tokens,
**when** an agent resolves it,
**then** the first 6 000 tokens are injected followed by a visible truncation marker, the run
receipt records the truncation, and the human sees no error.

**S-20 — Archiving a document another document references.**
**Given** document A whose body contains a reference to document B,
**when** B is archived,
**then** the archive succeeds, the reference in A renders with a muted `archived` affix, hovering it
reads `Archived — restore it to make agents read it again`, and B is no longer injected into agent
context.

**S-21 — Deleting a non-empty folder.**
**Given** a folder holding 12 documents,
**when** an editor deletes it,
**then** they are asked to confirm with
`Delete "Playbooks"? The 12 documents inside move to Unfiled. Nothing is deleted.` and on confirm
the folder is removed and its documents become unfiled. **Documents are never deleted by a folder
delete.**

**S-22 — Folder depth and name limits.**
**Given** a folder already 5 levels deep,
**when** someone tries to create a child inside it,
**then** the action is refused with `Folders can be nested up to 5 levels deep.` A folder name
longer than 120 characters, or empty, or duplicating a sibling's name, is refused with
`A folder called "Support" already exists here.`

**S-23 — Moving a folder into its own subtree.**
**Given** `Playbooks` and its child `Playbooks / Support`,
**when** somebody drags `Playbooks` onto `Playbooks / Support`,
**then** the drop is rejected with `A folder cannot be moved inside itself.` and nothing changes.

**S-24 — Permission denial on curation.**
**Given** a person with view-only access to a Work,
**when** they open one of its documents in the library,
**then** they **can** pin it, mark it read, export it and reference it; the **File**, **Archive**
and **Restore** controls are visible but disabled with the tooltip
`You need edit access to this Work to change how it is filed.`

**S-25 — Empty library.**
**Given** a brand-new organization with no Knowledge Base documents,
**when** somebody opens the Library view,
**then** they see an empty state headed `Nothing on the shelf yet` with the body
`Ask an agent to write something down. The better your documents, the shorter your prompts.`,
a **Ask an agent to write a document** button that opens a composer pre-filled with a starter
request, and a **New folder** button.

**S-26 — Empty folder.**
**Given** a folder somebody just created,
**when** they select it,
**then** they see `This folder is empty` with `Move documents here, or ask an agent to file its
next write into it.` and a **Move documents here** button.

**S-27 — Export over the cap.**
**Given** a request to export 2 400 documents,
**when** it is submitted,
**then** it is refused with
`An export can include up to 2000 documents. Narrow the selection and try again.` An export whose
assembled archive would exceed 200 MB fails during assembly and the person is notified with
`Export too large — 200 MB limit. Try exporting one folder at a time.`

**S-28 — Export while the git source is unreachable.**
**Given** an export that must read bodies from the source-of-truth repository,
**when** the repository is unreachable for some documents,
**then** the export still completes, the archive contains a `MISSING.txt` naming each document that
could not be read, and the notification says `Export finished — 3 of 60 documents could not be read.`

**S-29 — Loading and slow states.**
**Given** a library with 2 000 documents,
**when** the Library view is opened,
**then** the folder rail and the first 50 rows render within 1.5 s at P95; the rollup dots may
arrive up to 500 ms later and animate in rather than shifting layout; further rows load on scroll.

**S-30 — Marking unread.**
**Given** a document a person has read,
**when** they choose **Mark as unread**,
**then** it shows `UPDATED` again for them (never `NEW` — they have opened it before), the folder
rollup dot returns, and nobody else is affected.

---

## 4. Functional requirements

Every default, limit, threshold and permission below is a number, not an adjective.

### 4.1 The library surface

- **FR-1** The system MUST provide a **Library** view listing every Knowledge Base document visible
  to the viewer across every Work in the active Organization, plus the organization-scoped
  documents.
- **FR-2** The Library view MUST default to excluding archived documents.
- **FR-3** The Library view MUST default to sorting **pinned first** (most recently pinned first),
  then by last substantive change descending.
- **FR-4** The Library view MUST offer sorts: `Recently changed` (default within each group),
  `Title A→Z`, `Unread first`. The chosen sort MUST persist per person across sessions.
- **FR-5** The Library view MUST return at most **50** documents per page by default and MUST NOT
  accept a page size above **200**. Further pages MUST load on scroll.
- **FR-6** The Library view MUST offer filters: folder, `Unread only`, `Pinned only`, document
  class, Work, and free text over title, description and slug.
- **FR-7** Free-text search MUST return at most **50** results and MUST match on title prefix,
  title substring, and slug, in that rank order.
- **FR-8** The per-Work knowledge workbench MUST show the same badges, pin control, folder
  breadcrumb, archive/restore control and export control on its document header, so a person never
  has to leave the workbench to curate.

### 4.2 Folders

- **FR-9** The system MUST let an editor create, rename, move and delete **shared folders** that are
  visible to every member of the Organization.
- **FR-10** A document MUST belong to at most **one** folder. A document with no folder MUST appear
  under **Unfiled**.
- **FR-11** Folders MUST nest to a maximum depth of **5** levels. An attempt to exceed it MUST be
  refused with a message, not silently truncated.
- **FR-12** A folder name MUST be 1–120 characters and MUST be unique among its siblings
  (case-insensitive).
- **FR-13** An Organization MUST NOT hold more than **500** shared folders.
- **FR-14** Deleting a folder MUST move its documents (recursively) to **Unfiled** and MUST NOT
  delete any document.
- **FR-15** Moving a folder into its own subtree MUST be refused.
- **FR-16** Filing MUST support moving up to **100** documents in one action.
- **FR-17** A document MUST only be filed into a folder belonging to the same Organization; an
  attempt to file across organizations MUST be refused.
- **FR-18** The existing per-person folders for uploaded files MUST keep working exactly as they do
  today and MUST NOT become visible to other people as a side effect of this feature.

### 4.3 Pinning

- **FR-19** Pinning MUST be **per person**: a pin changes only the pinner's ordering.
- **FR-20** A person MUST NOT hold more than **20** pins; pinning a 21st MUST be refused with
  `You can pin up to 20 documents. Unpin one first.`
- **FR-21** Pinning MUST require only view access to the document.
- **FR-22** Archiving a pinned document MUST keep the pin, so that restoring it returns it to the
  pinned group.

### 4.4 Read state

- **FR-23** Every document MUST carry a **revision counter** that starts at 1 and increases by 1 on
  each substantive change.
- **FR-24** A change MUST be treated as substantive if and only if it alters the document's title,
  description, tags, document class, or the hash of its **whitespace-normalized body** (all runs of
  whitespace collapsed to one space, leading and trailing whitespace removed).
- **FR-25** The system MUST NOT bump the revision for index timestamps, commit references,
  mirroring, re-embedding, chunk-coordinate updates, or any other bookkeeping write.
- **FR-26** For a given person and document, the read state MUST be exactly one of:
  `NEW` (never opened), `UPDATED` (opened before, and the revision has increased since), or
  `READ`.
- **FR-27** A document MUST be recorded as read for a person **2 seconds** after its body renders
  on their screen, or immediately when they edit it — whichever comes first.
- **FR-28** An agent reading a document MUST NOT change any person's read state.
- **FR-29** A person MUST be able to **mark as read** without opening, and to **mark as unread**
  after reading. Marking unread MUST produce `UPDATED`, never `NEW`.
- **FR-30** **Mark folder as read** MUST apply to the folder's entire subtree, MUST affect only the
  actor, and MUST be undoable for **10 seconds**.
- **FR-31** Every folder row MUST show a **boolean rollup dot** — not a count — that is true when at
  least one document anywhere in that folder's subtree is `NEW` or `UPDATED` for the viewer.
- **FR-32** The Unfiled group MUST carry the same rollup dot.
- **FR-33** The Library navigation entry MUST carry one library-wide rollup dot with the same
  semantics.
- **FR-34** The header of the Library view MUST show an exact unread **count** (`5 unread`) — counts
  at the top level, dots on folders.
- **FR-35** Rollup computation MAY be cached per person for at most **30 seconds**; a person's own
  read action MUST invalidate their cache immediately.
- **FR-36** Read state MUST be per person and MUST NOT be visible to, or alterable by, anyone else.

### 4.5 Archive and restore

- **FR-37** An editor MUST be able to **archive** a document and later **restore** it, with no time
  limit on restoring.
- **FR-38** Archiving MUST remember the folder the document was in and restoring MUST return it
  there; if that folder no longer exists, the document MUST restore to **Unfiled**.
- **FR-39** An archived document MUST be excluded from the default library list, from the reference
  picker, and from agent context injection — and MUST remain fully readable, exportable, and
  present in the **Archived** filter.
- **FR-40** Archiving and restoring MUST be idempotent.
- **FR-41** Archiving MUST NOT delete anything, and MUST NOT alter the document's version history.

### 4.6 Export

- **FR-42** Any document a person can view MUST be exportable as **Markdown**, with its metadata as
  YAML front matter, named `<slug>.md`.
- **FR-43** A folder (recursively) or an explicit selection MUST be exportable as a `.zip` whose
  internal directories mirror the folder tree.
- **FR-44** An export of **25 documents or fewer** MUST be delivered synchronously. A larger export
  MUST be accepted immediately, processed in the background, and delivered via a notification with
  a download link valid for **24 hours**.
- **FR-45** An export MUST NOT exceed **2 000 documents** or **200 MB**; both limits MUST produce a
  clear message rather than a partial silent result.
- **FR-46** An export whose sources are partly unreadable MUST still complete and MUST enumerate
  every document it could not read inside the archive.
- **FR-47** Export MUST be rate limited to **10 requests per minute per person**.
- **FR-48** The system SHOULD offer **PDF** as a second export format. PDF rendering MUST be
  provided by a plugin, never by an inline vendor client.

### 4.7 Referencing a document from a composer

- **FR-49** Typing `#` in **any** composer in the product MUST open a document picker.
- **FR-50** The picker MUST debounce input by **150 ms**, return at most **8** documents, exclude
  archived documents, exclude documents the viewer cannot see, and rank most-recently-read-by-me
  first, then title prefix, then title substring.
- **FR-51** Selecting from the picker MUST insert a reference that renders to the human as the
  document **title** hyperlinked to the document.
- **FR-52** The existing `@kb:<reference>` form MUST keep working, unchanged, in every surface that
  supports it today.
- **FR-53** A hand-typed `#<reference>` MUST resolve only when it matches **exactly one** visible,
  non-archived document. Zero matches or two-or-more matches MUST leave it as literal text and MUST
  surface an inline hint in the composer before sending.
- **FR-54** `#` MUST NOT be interpreted as a reference when it is followed by whitespace (so
  Markdown headings are untouched) or when it is preceded by a word character.
- **FR-55** When a message carrying references reaches an agent, the system MUST inject the resolved
  documents' content into that run's context.
- **FR-56** At most **5** referenced documents MUST be injected per message; the composer MUST warn
  before sending when more are present.
- **FR-57** Explicit references MUST have a context budget of **6 000 tokens**; a single document
  exceeding it MUST be truncated at the boundary with a visible marker rather than dropped.
- **FR-58** Explicit references MUST take precedence over retrieval-selected context when the
  combined context budget is exceeded.
- **FR-59** Every run MUST record which documents it resolved and which references it failed to
  resolve, and the run's receipt MUST list them.
- **FR-60** A reference MUST NOT reveal the existence of a document the viewer cannot see; an
  unresolvable reference and an inaccessible one MUST be indistinguishable to the sender.

### 4.8 Permissions

- **FR-61** Seeing a document in the library MUST require view access to its Work, or membership of
  the Organization for organization-scoped documents.
- **FR-62** Pinning, marking read/unread, exporting and referencing MUST require only view access.
- **FR-63** Filing, archiving, restoring, and folder create/rename/move/delete MUST require edit
  access to the affected document's Work, or Organization-admin for organization-scoped documents
  and for folders.
- **FR-64** Agents MUST be able to create and update documents, and MUST NOT be able to archive,
  restore, delete, pin, or move documents between folders.

### 4.9 Auditing, limits and observability

- **FR-65** Filing, archiving, restoring, folder create/delete and export MUST each produce an
  activity-log entry naming the document or folder and the actor.
- **FR-66** Marking read/unread and pinning MUST NOT produce activity-log entries (they are personal
  and high-frequency).
- **FR-67** Folder writes MUST be rate limited to **60 requests per minute per person**; mark-read
  to **120 per minute**; reference search to **120 per minute**.
- **FR-68** The Library view MUST render the folder rail and the first page of documents within
  **1.5 s at P95** for a library of 2 000 documents.

---

## 5. Key entities

| Concept | Status | Description |
| --- | --- | --- |
| **Knowledge Base document** | **Exists** | The living document. Already has a title, description, class, tags, status (`draft` / `active` / `archived`), lock, review state, decision state, version history and a source-of-truth body in the Work's repository. This epic adds: a folder, a revision counter, a normalized-body fingerprint, and who archived it and when. |
| **Folder** | **Exists, extended** | Ever Works already has folders for uploaded files, scoped to one person. This epic adds a **shared (organization) scope** to the same concept so a folder can hold documents and be seen by the whole team. It is the *same* noun with a new scope — not a second folder concept. |
| **Reader state** | **NEW** | One record per (person, document) capturing when they last opened it, which revision they last read, and whether they pinned it. This is the only genuinely new entity in this epic. It is justified because read state and pins are irreducibly **per person**: they cannot live on the document (which is shared), and they cannot be derived from the activity log (which is an append-only audit, not a queryable per-person cursor). It is added to the program vocabulary table in the same change. |
| **Document reference** | **Exists, extended** | The `@kb:` reference and its parse-and-resolve behaviour already exist in one composer. This epic adds the `#` trigger, the picker, resolution in agent runs, and per-run reference accounting. No new entity. |
| **Export job** | **Exists (pattern)** | A background job producing an archive. Uses the platform's existing background-work mechanism and notification delivery; no new user-facing noun. |
| **Run** | **Exists** | The receipt surface (epic AW-09) gains a "documents resolved" section fed by FR-59. |

### 5.1 Document read state — states and transitions

```
                       (document created, or first seen by this person)
                                        │
                                        ▼
                                   ┌─────────┐
                                   │   NEW   │  badge: NEW
                                   └────┬────┘
                                        │ person opens it and it stays
                                        │ on screen ≥ 2 s  (or they edit it)
                                        ▼
        ┌──────────────────────────►┌─────────┐◄────────────────────────┐
        │                           │  READ   │  no badge               │
        │                           └────┬────┘                         │
        │ person opens it ≥ 2 s          │ document revision increases  │
        │                                │ (substantive change only)    │
        │                                ▼                              │
        │                          ┌───────────┐                        │
        └──────────────────────────┤  UPDATED  │  badge: UPDATED        │
                                   └───────────┘                        │
                                        ▲                               │
                                        └── person chooses "Mark as unread" ─┘

  Never reachable: NEW after READ.  "Mark as unread" always lands on UPDATED,
  because the person has demonstrably opened the document before.
```

### 5.2 Shelf membership — orthogonal to read state

```
   ┌──────────────┐   archive    ┌────────────┐   restore   ┌──────────────┐
   │ on the shelf │─────────────►│  archived  │────────────►│ on the shelf │
   │  (default    │              │  readable, │             │  back in its │
   │   listing)   │◄─────────────│  excluded  │             │  old folder  │
   └──────────────┘              │ from agent │             └──────────────┘
                                 │  context   │
                                 └────────────┘
     Read state, pins, history, citations and version history survive both moves.
```

### 5.3 Prominence — orthogonal again

```
   pinned (≤ 20 per person, sorts first)  ⇄  not pinned
```

### 5.4 The three axes are independent

A document can be `UPDATED` + pinned + archived at the same time. The list applies them in this
order: **archived filter → folder filter → unread/pinned filters → sort**.

---

## 6. UX

Copy in these wireframes is the **exact** user-visible string unless bracketed as `[…]`.

### 6.1 Library view — populated

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│  Knowledge                                    [ List ]  [ Library ]  [ Files ]  [ … ] │
│  Everything your agents know, in one place.                          5 unread         │
├──────────────────────────┬────────────────────────────────────────────────────────────┤
│  ⌕ Search documents  /   │  ⌕ Search this library…              Sort: Recently changed │
│                          │  [ Unread only ]  [ Pinned only ]  [ Class ▾ ]  [ Work ▾ ] │
│  ▾ 📚 All documents      │                                                             │
│      124                 │  ── Pinned ─────────────────────────────────────────────── │
│    ▾ 📁 Playbooks    ●   │  📌 Voice guide                      Brand · Marketing      │
│        18                │       Tone, banned words, examples.       read 2 days ago   │
│      📁 Support      ●   │  📌 Refund policy            UPDATED  Playbooks / Support   │
│          8               │       When we refund, when we don't.      changed 06:04     │
│      📁 Onboarding       │                                                             │
│          6               │  ── Playbooks ──────────────────────────────────────────── │
│    ▾ 📁 Reports      ●   │  ● Escalation ladder             NEW  Playbooks            │
│        41                │       Written by Research agent           created 06:02     │
│      📁 Weekly       ●   │  ○ Handover checklist                 Playbooks            │
│         38               │       Steps for passing a case on.        read 6 days ago   │
│    📁 Research           │                                                             │
│        22                │  ── Reports ────────────────────────────────────────────── │
│    📁 Unfiled        ●   │  ● Weekly report — 1 Sep          NEW  Reports / Weekly     │
│        37                │       Written by Reporting agent          created Mon 07:00 │
│                          │  ○ Weekly report — 25 Aug             Reports / Weekly     │
│  ── Views ──             │       Written by Reporting agent          read 5 days ago   │
│    Archived   9          │                                                             │
│                          │                          [ Load more ]                      │
│  + New folder            │                                                             │
└──────────────────────────┴────────────────────────────────────────────────────────────┘
       ● = rollup dot: something in here is new or changed for you
```

Row anatomy, left to right: unread marker (`●` filled = unread, `○` = read, `📌` = pinned),
title, badge (`NEW` or `UPDATED`), folder breadcrumb, one-line description, relative timestamp.

### 6.2 Badges — exact rendering and copy

```
  NEW      solid pill, high contrast          tooltip: "You have never opened this."
  UPDATED  outlined pill, same size           tooltip: "Changed since you last read it."
  (none)   nothing rendered
  ●        4 px dot on a folder row           tooltip: "Something in here is new or changed."
```

Badges are never shown to a person for a document they cannot see, and never reflect anyone else's
reading.

### 6.3 Row hover controls and the overflow menu

```
  ○ Handover checklist                        Playbooks       [📌] [📁] [⋯]
                                                               │    │    │
  ┌────────────────────────────────────────────────────────────┘    │    │
  │  Pin  (p)                                                       │    │
  ┌─────────────────────────────────────────────────────────────────┘    │
  │  File into folder…  (f)                                              │
  ┌──────────────────────────────────────────────────────────────────────┘
  │  Open                                     Enter
  │  Mark as read                             r
  │  Mark as unread                           Shift+R
  │  ────────────────────────────────────────────────
  │  Export as Markdown                       Ctrl/Cmd+E
  │  Export as PDF                                        [P3]
  │  ────────────────────────────────────────────────
  │  Archive                                  a
  └──────────────────────────────────────────────────
```

Disabled state for a view-only member:

```
  │  File into folder…                        ⓘ You need edit access to this Work
  │                                             to change how it is filed.
  │  Archive                                  ⓘ You need edit access to this Work
  │                                             to archive it.
```

### 6.4 Folder rail — states

```
LOADING                      EMPTY ORGANIZATION            OVER FOLDER LIMIT
┌────────────────────┐       ┌────────────────────┐        ┌────────────────────────────┐
│  ▒▒▒▒▒▒▒▒▒▒  ▒▒    │       │  ▾ 📚 All documents│        │  + New folder              │
│    ▒▒▒▒▒▒▒▒  ▒     │       │        0           │        │  ⓘ You have 500 folders,   │
│    ▒▒▒▒▒▒    ▒▒    │       │                    │        │    the maximum. Delete one  │
│  ▒▒▒▒▒▒▒▒▒▒▒       │       │  + New folder      │        │    to add another.          │
└────────────────────┘       └────────────────────┘        └────────────────────────────┘
 skeleton rows, no dots      no folders yet                 button disabled
```

Folder context menu:

```
  📁 Playbooks   [right-click / ⋯]
  ├─ Rename…                       F2
  ├─ New subfolder…
  ├─ Mark folder as read           Shift+A
  ├─ Export folder…
  └─ Delete folder…
```

### 6.5 Empty and error states in the document list

```
EMPTY LIBRARY
┌───────────────────────────────────────────────────────────────────────┐
│                              📚                                        │
│                     Nothing on the shelf yet                          │
│      Ask an agent to write something down. The better your            │
│      documents, the shorter your prompts.                             │
│                                                                       │
│        [ Ask an agent to write a document ]   [ New folder ]          │
└───────────────────────────────────────────────────────────────────────┘

EMPTY FOLDER
┌───────────────────────────────────────────────────────────────────────┐
│                     This folder is empty                              │
│      Move documents here, or ask an agent to file its next            │
│      write into it.                                                   │
│                        [ Move documents here ]                        │
└───────────────────────────────────────────────────────────────────────┘

NO SEARCH RESULTS
┌───────────────────────────────────────────────────────────────────────┐
│              No documents match "refnud policy".                      │
│              [ Clear search ]   [ Search archived too ]               │
└───────────────────────────────────────────────────────────────────────┘

FAILED TO LOAD
┌───────────────────────────────────────────────────────────────────────┐
│              We could not load your library.                          │
│              [ Try again ]                                            │
└───────────────────────────────────────────────────────────────────────┘

ALL READ  (shown when "Unread only" is on and nothing is unread)
┌───────────────────────────────────────────────────────────────────────┐
│              You are all caught up.                                   │
└───────────────────────────────────────────────────────────────────────┘
```

### 6.6 Archived view

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  Archived                                                        9 documents   │
│  Archived documents keep their history and stay out of the way. Restore any    │
│  time — agents stop reading them until you do.                                 │
├───────────────────────────────────────────────────────────────────────────────┤
│   Q2 pricing experiment            Research      archived 12 Aug by Dana       │
│                                                       [ Restore ]  [ Export ]  │
│   Old refund policy                Playbooks     archived  4 Aug by an agent   │
│                                                       [ Restore ]  [ Export ]  │
├───────────────────────────────────────────────────────────────────────────────┤
│  EMPTY:  Nothing archived. Archiving keeps history without cluttering          │
│          the shelf.                                                            │
└───────────────────────────────────────────────────────────────────────────────┘
```

Restore confirmation toast: `Restored "Old refund policy" to Playbooks.` with `Undo`.
If the old folder is gone: `Restored "Old refund policy" to Unfiled — its folder no longer exists.`

### 6.7 Move-to-folder picker

```
┌─────────────────────────────────────────────────┐
│  File 3 documents into…                     ✕   │
├─────────────────────────────────────────────────┤
│  ⌕ Type a folder name…                          │
│  ────────────────────────────────────────────── │
│  📁 Playbooks                                    │
│    📁 Support                                    │
│    📁 Onboarding                                 │
│  📁 Reports                                      │
│    📁 Weekly                                     │
│  📁 Research                                     │
│  ────────────────────────────────────────────── │
│  ⤺ Unfiled  (remove from any folder)             │
│  ＋ New folder "Refunds"        [appears when    │
│                                  the query has   │
│                                  no exact match] │
├─────────────────────────────────────────────────┤
│                          [ Cancel ]   [ File ]  │
└─────────────────────────────────────────────────┘
   ↑/↓ move · → expand · ← collapse · Enter file · Esc cancel
```

Over-limit: `You can file up to 100 documents at once. 143 selected.`

### 6.8 Export dialog

```
┌─────────────────────────────────────────────────────────────┐
│  Export "Playbooks"                                     ✕   │
├─────────────────────────────────────────────────────────────┤
│  60 documents, including subfolders.                        │
│                                                             │
│  Format     ( • ) Markdown (.zip)                           │
│             (   ) PDF (.zip)          [P3]                  │
│                                                             │
│  ☑ Include archived documents            (9 more)           │
│  ☐ Include the original uploaded files                      │
│                                                             │
│  ⓘ Exports over 25 documents are prepared in the            │
│    background. We will notify you with a download link      │
│    that works for 24 hours.                                 │
├─────────────────────────────────────────────────────────────┤
│                              [ Cancel ]     [ Export ]      │
└─────────────────────────────────────────────────────────────┘

QUEUED TOAST      Preparing export — we will notify you.
READY NOTICE      Your export of "Playbooks" is ready.   [ Download ]
PARTIAL NOTICE    Export finished — 3 of 60 documents could not be read.  [ Download ]
OVER CAP          An export can include up to 2000 documents. Narrow the
                  selection and try again.
TOO LARGE         Export too large — 200 MB limit. Try exporting one folder
                  at a time.
EXPIRED LINK      This download link has expired. Run the export again.
```

### 6.9 The `#` reference picker in a composer

```
┌────────────────────────────────────────────────────────────────────────┐
│  Draft a reply to this customer using #vo|                             │
│                                        ┌─────────────────────────────┐ │
│                                        │ 📄 Voice guide              │ │
│                                        │    Brand · read 2 days ago  │ │
│                                        │ 📄 Voice — social           │ │
│                                        │    Style · never opened  NEW│ │
│                                        │ 📄 Volume forecast          │ │
│                                        │    Research · read 12 Aug   │ │
│                                        ├─────────────────────────────┤ │
│                                        │ ↑↓ move · ↵ insert · esc ✕  │ │
│                                        └─────────────────────────────┘ │
│  [📎]  [🎙]                                              [ Send  ↵ ]   │
└────────────────────────────────────────────────────────────────────────┘

AFTER INSERT
┌────────────────────────────────────────────────────────────────────────┐
│  Draft a reply to this customer using (📄 Voice guide) |               │
└────────────────────────────────────────────────────────────────────────┘

PICKER — NO MATCH
│ No documents match "vzz".                                              │
│ Keep typing, or press esc to leave it as plain text.                   │

PICKER — LOADING
│ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                                                       │
│ ▒▒▒▒▒▒▒▒▒▒                                                             │

PICKER — EMPTY LIBRARY
│ You have no documents yet. Ask an agent to write one.                  │
```

Pre-send hints, rendered under the composer, non-blocking:

```
ⓘ #refunds matches 2 documents — pick one from the list.
ⓘ #nope matches no document.
ⓘ Only 5 documents can be attached to one message. The other 4 will be
  links, not context.
```

### 6.10 How a reference renders after sending

```
HUMAN VIEW (in the message)
   Draft a reply to this customer using 📄 Voice guide
                                        ╰── hyperlink; hover card shows
                                            title, class, last changed,
                                            and the first 200 characters

ARCHIVED TARGET
   … using 📄 Voice guide (archived)
                          ╰── tooltip: "Archived — restore it to make
                              agents read it again."

UNRESOLVED
   … using #vzz
           ╰── plain text, no link, no hover card

AGENT-SIDE (surfaced on the run receipt, epic AW-09)
   ┌──────────────────────────────────────────────────────────────┐
   │  Documents this run read                                     │
   │   📄 Voice guide            1 240 tokens                     │
   │   📄 Refund policy          3 902 tokens   truncated at 6 000│
   │   ⚠ 1 reference could not be resolved                        │
   └──────────────────────────────────────────────────────────────┘
```

### 6.11 The "changed while you were reading" banner

```
┌───────────────────────────────────────────────────────────────────────┐
│ ⓘ This document changed while you were reading it.   [ Reload ]   ✕   │
└───────────────────────────────────────────────────────────────────────┘
```

Non-blocking, appears at the top of the reader, does not steal focus, and dismissing it leaves the
person's read mark at the version they actually saw.

### 6.12 Keyboard affordances

| Key | Where | Action |
| --- | --- | --- |
| `/` | Library view | Focus the search box |
| `↑` `↓` | Document list | Move the selection |
| `Enter` | Document list | Open the selected document |
| `Space` | Document list | Toggle selection for bulk actions |
| `p` | Document list / reader | Pin or unpin |
| `f` | Document list / reader | Open **File into folder…** |
| `r` | Document list | Mark as read |
| `Shift+R` | Document list / reader | Mark as unread |
| `a` | Document list / reader | Archive (or restore, in the Archived view) |
| `Ctrl/Cmd+E` | Document list / reader | Export as Markdown |
| `Shift+A` | Folder rail | Mark folder as read |
| `F2` | Folder rail | Rename folder |
| `←` `→` | Folder rail | Collapse / expand a folder |
| `Esc` | Anywhere | Close the dialog, picker or banner |
| `#` | Any composer | Open the document picker |
| `↑` `↓` `Enter` `Esc` | Reference picker | Move, insert, dismiss |
| `Tab` | Reference picker | Insert the highlighted document |

Every control listed above has a visible focus ring, an accessible name, and the badges expose
their meaning to assistive technology as text (`New`, `Updated`), not colour alone.

---

## 7. Out of scope

- **Rich collaborative editing.** Real-time multiplayer editing of a document body. The existing
  editor and lock semantics are unchanged; this epic adds a banner when a document changes under
  you, not operational transforms.
- **A diff view.** `UPDATED` tells you *that* something changed. Showing *what* changed is a
  natural follow-up but needs a rendered diff over the version history and is not in this epic.
  See §9.
- **Tags as a second organizing axis.** Documents already carry tags and the tag catalogue is
  unchanged. Folders are the shelf; tags stay a filter.
- **A document in more than one folder.** Single-parent only.
- **Automatic archiving.** No staleness sweep, no "archive after N days untouched". Archiving is a
  human curation act.
- **Hard delete from the library.** The existing delete endpoint is untouched; the library offers
  archive, never delete.
- **Importing documents from external document tools.** Uploads and extraction already exist and
  are unchanged; two-way sync with an external documents product is a separate connector epic.
- **Per-document permissions.** Access continues to follow the document's Work or Organization.
  There are no private documents inside a shared library.
- **Organization-wide pinning** ("featured for everyone"). Pins are personal in this epic.
- **Read state for agents.** Agents have no read state and no badges.
- **Changing how retrieval selects context.** Explicit references are additive to retrieval; the
  retrieval ranking itself is untouched.
- **Replacing the per-Work knowledge workbench.** It stays exactly where it is and gains the same
  curation controls.

---

## 8. Acceptance criteria

A reviewer should be able to run this list top to bottom against the merged change.

**Library and folders**

- [ ] The Library view lists documents from every Work in the Organization plus organization-scoped
      documents, and excludes archived documents by default.
- [ ] Creating, renaming, moving and deleting a shared folder works, and every member sees the same
      folder tree.
- [ ] Deleting a folder holding documents moves them to Unfiled and deletes no document.
- [ ] Creating a folder at depth 6 is refused with the exact message in §6.
- [ ] Moving a folder into its own subtree is refused.
- [ ] Filing 100 documents in one action succeeds; 101 is refused with a message.
- [ ] The existing per-person folders for uploaded files behave exactly as before, and are not
      visible to other members.

**Read state**

- [ ] A never-opened document shows `NEW`; opening it for 2 seconds clears the badge for that person
      only.
- [ ] A substantive edit produces `UPDATED` for everyone who had read it and leaves `NEW` in place
      for everyone who had not.
- [ ] A whitespace-only edit produces no badge for anyone.
- [ ] A background mirror, re-embed or index write produces no badge for anyone.
- [ ] An agent run that reads a document changes no person's badge.
- [ ] Every folder containing an unread document in its subtree shows a dot; the dot clears when the
      last unread document in that subtree is read.
- [ ] The Library header shows an exact unread count; folders show dots, never counts.
- [ ] Mark-folder-as-read affects only the actor and is undoable for 10 seconds.
- [ ] Mark-as-unread produces `UPDATED`, never `NEW`.

**Pinning**

- [ ] Pinning sorts a document to the top for the pinner only.
- [ ] A 21st pin is refused with the exact message in §4.3.

**Archive and restore**

- [ ] Archiving removes a document from the default list, the reference picker and agent context,
      and keeps it readable under Archived.
- [ ] Restoring returns it to its previous folder; if that folder is gone it lands in Unfiled with
      the message in §6.6.
- [ ] Archiving twice, and restoring twice, are both no-ops.

**Export**

- [ ] A single-document Markdown export downloads with YAML front matter and the `<slug>.md` name.
- [ ] A 20-document export returns synchronously; a 60-document export returns immediately and
      arrives as a notification with a link valid 24 hours.
- [ ] A 2 400-document export is refused with the exact message in §6.8.
- [ ] An export with unreadable sources completes and enumerates them in the archive.

**References**

- [ ] `#` opens the picker in the chat composer, the shared prompt composer, task comments, and the
      document editor.
- [ ] The picker returns at most 8 results within 150 ms of the last keystroke, excludes archived
      documents, and excludes documents the viewer cannot see.
- [ ] Selecting inserts a reference that renders as the document title, hyperlinked.
- [ ] `@kb:` references written before this change still resolve.
- [ ] `# Heading` in a Markdown body is not treated as a reference.
- [ ] An ambiguous hand-typed reference stays literal and shows the pre-send hint.
- [ ] An agent run receives the content of referenced documents and its receipt lists them with
      token counts, truncations and unresolved references.
- [ ] A message with 9 references injects 5 and warns before sending.
- [ ] A reference to an inaccessible document is indistinguishable from a reference to a
      nonexistent one.

**Permissions, audit and performance**

- [ ] A view-only member can pin, read, export and reference, and sees File / Archive disabled with
      the tooltip in §6.3.
- [ ] An agent cannot archive, restore, delete, pin or move a document.
- [ ] Filing, archiving, restoring, folder create/delete and export each appear in the activity log;
      marking read and pinning do not.
- [ ] The Library view renders the rail and first 50 rows within 1.5 s at P95 against a 2 000
      document library.
- [ ] All functional requirements have a passing unit, controller or end-to-end test.

---

## 9. Open questions

- `[NEEDS CLARIFICATION: Should the library also offer an organization-wide "featured" flag on top
  of personal pins? Personal pins solve the "my three documents" problem; a shared flag solves the
  "everyone should read this" problem. Shipping both at once risks two rival prominence signals
  fighting for the top of one list.]`
- `[NEEDS CLARIFICATION: The UPDATED badge promises the reader will not have to hunt for what
  changed, but a badge alone cannot deliver that. Do we (a) ship a rendered diff against the
  reader's last-read revision, (b) ask the writing agent to append a one-line "what changed" note
  on every rewrite, or (c) accept the badge alone in v1? Option (b) is cheap and reads better than
  a diff for prose, but it depends on agent cooperation and cannot be enforced.]`
- `[NEEDS CLARIFICATION: Should a scheduled Work run be able to declare a document as its standing
  output target from the library side (a "this document is refreshed weekly by X" affordance), or
  does that binding stay entirely on the schedule? Owning it on the schedule keeps one source of
  truth; showing it on the document is what makes the library legible.]`
- `[NEEDS CLARIFICATION: Should folders be able to carry a default document class, so an agent
  filing into "Playbooks" automatically writes a playbook-class document? Attractive, but it makes
  folders semantically load-bearing rather than purely organizational.]`
- `[NEEDS CLARIFICATION: Should the reference picker search document bodies as well as titles and
  slugs? Title-only is fast and predictable; body search finds more but makes the ranking hard to
  explain and the latency budget hard to hold.]`
- `[NEEDS CLARIFICATION: Retention for background-produced export archives. 24 hours for the link
  is specified; how long do the bytes live in storage before a sweep removes them, and does the
  sweep belong to this epic or to the platform-wide storage reconcile?]`
- `[NEEDS CLARIFICATION: When an organization has hundreds of members, is a per-person reader-state
  record per opened document acceptable at steady state, or do we need a retention rule (for
  example, prune reader state for documents nobody has opened in 18 months)?]`

---

## 10. Constitution gates

- [x] **I — Plugin-first.** The only external capability this epic could need is PDF rendering; it
      is specified as a plugin-provided capability (FR-48) and is deferred to P3. Markdown and zip
      export use first-party code paths.
- [x] **II — Capability-driven resolution.** No plugin id appears anywhere in this behaviour; PDF
      rendering is requested as a capability.
- [x] **III — Source-of-truth repositories.** Document bodies stay in the Work's repository.
      Folders, pins, read state and revision counters are metadata about documents, which is
      exactly what the platform database is for.
- [x] **IV — Background work via the job runtime.** Only bulk export runs in the background, and it
      runs as a job on the configured provider.
- [x] **V — Forward-only migrations.** Every schema change is additive; the one index change is a
      widening, not a narrowing. Details in [plan.md](./plan.md) §3.
- [x] **VI — Tests are a prerequisite.** §8 requires a test per functional requirement.
- [x] **VII — Secret hygiene.** No new secret is introduced. Export download links are
      capability-scoped and expire in 24 hours.
- [x] **VIII — Plugin counts.** No plugin is added in P1/P2. A P3 PDF plugin would update the
      canonical plugin doc.
- [x] **IX — Behaviour-first.** This document contains no class names, file paths or code.
- [x] **X — Backwards compatibility.** `@kb:` references keep working unchanged (FR-52); every new
      field is additive; the existing per-person file folders are untouched (FR-18).

---

## 11. Cross-references

- Program overview: [../README.md](../README.md)
- Implementation plan: [plan.md](./plan.md)
- Task breakdown: [tasks.md](./tasks.md)
- Knowledge Base (documents, classes, git mirroring): [../../knowledge-base/](../../knowledge-base/)
- Memory (facts, consolidation, review queue): [../../memory/](../../memory/)
- Agent memory: [../../agent-memory/](../../agent-memory/)
- Skills (the other reusable-capability store): [../../skills/](../../skills/)
- Runs and receipts (where resolved references are shown): `AW-09-runs-receipts`
- Memory, context files and the load meter: `AW-07-memory-context`
- Notification matrix (how export-ready notices are delivered): `AW-13-attention-controls`
