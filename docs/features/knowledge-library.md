---
id: knowledge-library
title: Knowledge Library
sidebar_label: Knowledge Library
description: The Library view of the Memory page — every Knowledge Base document of your organization on one shelf, organized into shared folders, with archive, restore and Markdown export.
---

# Knowledge Library

Your agents write documents all the time — playbooks, weekly reports, research notes, decisions. Each one lands in the [Knowledge Base](./knowledge-base.md) of the Work it belongs to, which is exactly right for the agents, but it leaves you with a question the per-Work view cannot answer on its own: _where is everything, and how do I keep it tidy?_

The **Knowledge Library** is the answer. It is the **Library** view of the [Memory](./memory.md) page: every Knowledge Base document of every Work in your organization, plus the organization's own documents, on one shelf that the whole team organizes into **shared folders**.

It is not a second store. A document on the shelf is the same document the Work's workbench edits — filing, archiving or restoring it from the Library is visible in the workbench straight away, and the other way round.

## Opening the Library

Go to **Memory** in the sidebar and switch the view toggle at the top of the page from **Overview** to **Library**. The page remembers the view you last used, and the address gains `?view=library`, so you can share a link that opens straight onto the shelf.

The Overview — search, facet chips, files, agent memory, meetings, the review queue and consolidation — is unchanged and stays the default.

The Library belongs to an organization. In your personal workspace the view explains that and shows an empty shelf; switch to an organization to see its documents.

## The shelf

The Library has two parts.

**The folder rail** on the left lists:

- **All documents** — every document on the shelf, with a count.
- **Shared folders** — nested up to five levels, each with the number of documents in it and in its subfolders.
- **Unfiled** — documents that are not in any folder yet.
- **Archived** — the documents taken off the shelf (see below).

**The document list** on the right shows the documents of whatever you picked in the rail. Each row carries the title (which opens the document in its Work's workbench), its class, the folder it is filed in, the Work it belongs to, a one-line description and when it last changed.

"Last changed" means the last **substantive** change — a new title, description, tags or class, or a body that says something different. Background housekeeping (syncing to Git, re-indexing) and pure reformatting never move a document up the list.

### Search, sort and filter

- **Search this library…** matches the title, description and slug of each document in the current view.
- **Sort** by **Recently changed** (the default) or **Title A→Z**. Your choice is remembered.
- **Class** and **Work** narrow the list to one document class or one Work.

When a search finds nothing, you can clear it or **Search archived too**.

The list loads 50 documents at a time; more load as you scroll, or with **Load more**.

## Shared folders

Shared folders are visible to everyone in the organization. Organization admins create and change them; everyone else sees the same controls, disabled, with the reason.

- **New folder** at the bottom of the rail creates a top-level folder.
- Each folder's **⋯** menu (or a right-click) offers **Rename…**, **New subfolder…** and **Delete folder…**.
- Folder names are 1–120 characters, and two folders side by side cannot share a name, even with different capitalization.
- Folders nest at most **5** levels deep, and an organization can hold at most **500** of them. The Library tells you when you reach either limit instead of silently doing something else.
- **Deleting a folder never deletes a document.** Every document in the folder and its subfolders moves to Unfiled.

Shared folders are separate from the personal folders of the **Files** area on the Overview: a shared folder never appears in anyone's Files, and a personal folder never appears on the shelf.

## Filing documents

To put a document in a folder, use the **folder** button on its row (or press **f** on a focused row). To file several at once, tick their boxes and choose **File into folder…** in the bar that appears.

The **File into folder** dialog lists the shared folders. Type to find one by name; if nothing matches exactly and you can manage folders, the last option creates that folder and files into it in one step. **Unfiled** removes documents from any folder.

- You can file up to **100** documents in one go.
- Filing a document needs edit access to its Work (organization documents need organization admin access).
- A document can only be filed into a folder of its own organization.

## Archive and restore

Archiving takes a document off the shelf without deleting anything. Use **Archive** in a row's **⋯** menu (or press **a** on a focused row).

An archived document:

- leaves the default shelf and stops being part of the context agents always receive;
- stays readable, exportable and in its folder, with its full history;
- is listed in the **Archived** view, which shows when it was archived.

**Restore** in the Archived view puts the document back on the shelf, in the folder it was archived from. If that folder has been deleted in the meantime, the document is restored to Unfiled and the confirmation says so. Both actions offer **Undo** for a moment afterwards, and both need edit access to the document's Work.

## Export

**Export as Markdown** (in a row's **⋯** menu, or in the Archived view) downloads one document as `<slug>.md`. The file starts with the document's metadata — title, description, class, tags, status, source, Work, folder and revision — as YAML front matter, followed by the body. Exporting needs only view access.

## In the Work's workbench

You do not have to leave a Work to curate its documents. In the Knowledge Base workbench at `/works/:id/kb`:

- **The document header** shows the folder the document is filed in, and **File**, **Archive** / **Restore** and **Export** buttons.
- **The tree's right-click menu** gains **File into folder…**, **Restore** (for an archived document) and **Export as Markdown**, next to the existing entries.

Archive and Restore work for every Work. Filing and export belong to an organization's library, so for a Work opened from your personal workspace those two stay visible but disabled, and say why. A member without edit access sees File, Archive and Restore disabled the same way.

## Activity

Filing, archiving, restoring, exporting, and creating, renaming or deleting a shared folder each leave an entry in the [Activity](./activity.md) log naming the document or folder and who did it.

## Coming later

- **Unread and changed badges, and pins** — marking which documents are new or changed since you last read them, and pinning the ones you use most to the top of your shelf.
- **Referencing a document with `#`** from any composer, so an agent reads it for that request.
- **Exporting a whole folder or a selection** as a `.zip`, and **PDF** export.

## API reference

| Method   | Endpoint                                                | What it does                                                                                      |
| -------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/knowledge/library`                                | One page of the shelf — `folderId`, `archived`, `q`, `class`, `workId`, `sort`, `limit`, `cursor` |
| `GET`    | `/api/knowledge/tree`                                   | The folder rail with counts, Unfiled and Archived totals                                          |
| `GET`    | `/api/knowledge/documents/:docId`                       | One document as a shelf row (folder, Work, whether you can edit it)                               |
| `PATCH`  | `/api/knowledge/documents/file`                         | File up to 100 documents into a shared folder, or `folderId: null`                                |
| `POST`   | `/api/knowledge/documents/:docId/archive`               | Archive a document                                                                                |
| `POST`   | `/api/knowledge/documents/:docId/unarchive`             | Restore an archived document to its folder                                                        |
| `GET`    | `/api/knowledge/documents/:docId/export?format=md`      | Download one document as Markdown with YAML front matter                                          |
| `GET`    | `/api/memory/files/tree?scope=organization`             | The organization's shared folders                                                                 |
| `POST`   | `/api/memory/files/folders` (`"scope": "organization"`) | Create a shared folder                                                                            |
| `PATCH`  | `/api/memory/files/folders/:id`                         | Rename or move a shared folder                                                                    |
| `DELETE` | `/api/memory/files/folders/:id`                         | Delete a shared folder (its documents move to Unfiled)                                            |
| `POST`   | `/api/works/:id/kb/documents/:docId/unarchive`          | Restore an archived document from inside its Work                                                 |

Every `/api/knowledge` call works on the organization in your session scope; a document outside it is reported as not found.
