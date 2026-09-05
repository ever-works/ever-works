---
id: memory
title: Memory (Org-Wide)
sidebar_label: Memory
description: The /memory page — every Work's Knowledge Base plus your organization-level documents in one searchable place, with files, agent memory, meetings, a review queue and a consolidation pass.
---

# Memory (Org-Wide)

Every [Work](./creating-a-work.md) has its own [Knowledge Base](./knowledge-base.md). **Memory** is the layer above them: the `/memory` page fans in every KB document across every Work in the active Organization, adds the documents published at the organization level, and makes the whole thing searchable and faceted in one list.

It also holds the things a single Work's KB has no place for — the files people and agents upload, what the agents themselves remember from their runs, the meetings the platform ingested, a review queue for agent-written material, and a consolidation pass that keeps the pile from silting up as it grows.

Memory is **additive**: it removes and renames nothing. The per-Work workbench at `/works/:id/kb` keeps working exactly as it does today, and an organization that never opens Memory is unaffected.

## Knowledge Base vs Memory

|             | Knowledge Base                                                               | Memory                                                                                       |
| ----------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Route**   | `/works/:id/kb`                                                              | `/memory`                                                                                    |
| **Scope**   | One Work                                                                     | The active Organization — every Work's KB, plus the organization-level documents             |
| **Shape**   | A three-pane authoring workbench: tree, editor, AI panel, locks, Git history | A read-mostly catalog: search, facet chips, ranked list                                      |
| **You can** | Write, edit, classify, lock, restore from Git history                        | Search everything, upload originals, accept or reject proposals, consolidate, organize files |
| **Storage** | `.content/kb/` in the Work's Git data repository, mirrored to the database   | The same rows, aggregated — Memory adds no second copy of your knowledge                     |

**Scoping.** The Organization comes from your session scope, never from a URL parameter. With no active Organization the page renders its empty state ("Select or create an Organization to see its aggregated Memory") rather than scanning anything — there is no unscoped or cross-tenant read. Reads require Organization membership; every write — upload, accept, reject, consolidate, settings — goes through the stricter admin gate.

## Finding it

**Sidebar → Memory**, below Agents. The retired `/meetings` index redirects to `/memory#meetings`, filters and all.

The page is a single column of blocks, in this order:

1. **Header** — the title, and the **Consolidate** action.
2. **Awaiting review** — proposed documents needing a human. Absent when the queue is empty.
3. **Files** — every file you can see, in folders.
4. **Originals** — upload files into org-wide Memory.
5. **Agent Memory** — what the agents remember from their runs.
6. **Meetings** (`#meetings`) — the meetings catalog.
7. **Search, counts, facet chips and the document list.**
8. **Scheduled consolidation** — the settings form, deliberately last: you came here to read documents, not to meet a form.

## Searching and filtering

The search box ("Search across everything the organization knows…") runs a lexical search over document **title and description**, debounced so a fast typist issues one query rather than ten. The header then reads, for example, `428 documents indexed · 12 Works`.

Four chip groups filter the feed. Each chip carries its own count, toggles on click, and **Clear all** resets the search and every chip at once.

| Chip       | Values                                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Type**   | The KB document classes: `brand`, `legal`, `seo`, `style`, `glossary`, `competitors`, `personas`, `research`, `output`, `freeform`, `decision` |
| **Work**   | Every Work in the Organization that has documents. Organization-level documents show an **Organization** badge instead of a Work link          |
| **Source** | `user`, `agent`, `imported`, `seeded` — who or what wrote the document                                                                         |
| **Status** | `draft`, `active`, `archived`                                                                                                                  |

Each row shows the title, a class chip, the description excerpt, the source Work (a link straight into that Work's workbench) or the **Organization** badge, and the last-updated date. Rows also carry the **Promoted** and **Superseded** badges left by the last consolidation pass; a superseded document stays fully readable and simply recedes visually.

A page returns at most 200 documents.

> Mission and Team facets, and the graph view of the same data, are deliberately deferred — they depend on cross-feature prerequisites that are not in place yet. Today Memory is a list.

### How to find something across every Work

1. **Sidebar → Memory**.
2. Type into the search box — results refresh as you type.
3. Narrow with the chips: **Type** for a class, **Work** to stay inside one Work, **Source** to see only what agents wrote, **Status** to include archived material.
4. Click the Work name on a row to open that document's home at `/works/:id/kb`.
5. **Clear all** to start over.

## Adding to Memory

### Uploading originals

The **Originals** panel is the org-wide counterpart of the workbench's originals pane. Press **Upload files**, or drag files onto the panel.

The platform computes a SHA-256, deduplicates against the originals already in Memory, persists the bytes through the configured storage plugin, extracts the text to markdown where an extractor route exists, and materializes an organization-scoped document. Uploads are auto-classified — the server picks the class from the extracted text rather than dumping everything into `freeform`.

Each row then reports its extraction state: **Pending**, **Extracting…**, **Extracted**, **No text extracted**, or **Extraction failed** (hover for the error).

```bash
curl -X POST http://localhost:3100/api/memory/uploads \
  -H "Authorization: Bearer <token>" \
  -F "file=@./board-deck-q3.pdf" \
  -F "autoClassify=true"
```

The size ceiling is the same one the per-Work KB upload route uses (`KB_UPLOAD_MAX_BYTES`, 200 MB by default) — a file acceptable to one and rejected by the other would be arbitrary.

Files you already attached to a platform chat message can be pulled in without re-uploading the bytes: `POST /api/memory/uploads/from-attachments` takes the content hashes the composer already holds, reads the bytes back from the storage spine that wrote them, and reports per-attachment results so one storage hiccup never fails the batch.

### Organization-level documents

There is **no `/orgs/:id/kb` screen**. Documents that belong to the Organization rather than to a single Work are created in one of two ways today:

- **Upload into Memory** (above) — the resulting document is organization-scoped.
- **Over the API** — `POST /api/organizations/:orgId/kb/documents`, which takes the same body as a per-Work document.

The Memory header's **New** document action is intentionally hidden until a dedicated org-memory authoring flow exists; it previously linked to the Works list, which is not where you create a document. Uploading and the API are the two supported paths.

**Inheritance.** Three classes are inheritable at the organization level: `legal`, `style` and `seo`. Brand identity always stays per-Work. When an inheritable organization document is accepted it is overlaid into every Work in the Organization, and any Work can override it with its own document at the same path.

| Endpoint                                      | What it answers                                          |
| --------------------------------------------- | -------------------------------------------------------- |
| `GET /api/works/:id/kb/inheritable`           | Which organization documents this Work actually inherits |
| `GET /api/works/:id/kb/inheritable/*idOrPath` | The body of one inherited document                       |

## The review queue

Anything an agent writes or synthesizes lands as `reviewState: proposed` and is **withheld from context injection** until a human accepts it — an agent cannot bootstrap its own claims into its own future prompts. The **Awaiting review (N)** panel at the top of `/memory` is where the organization-level backlog is cleared. It hides itself when there is nothing waiting.

| Action     | Endpoint                                | Effect                                                                                                                                                                            |
| ---------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Accept** | `POST /api/memory/review/:docId/accept` | The document becomes eligible for context injection; if its class is inheritable, it is overlaid into every Work.                                                                 |
| **Reject** | `POST /api/memory/review/:docId/reject` | **Archives** the document — it leaves the queue and is never injected again, but stays readable. Not a delete. If it had been accepted and inheritable, the overlay is retracted. |

Both are idempotent, and a document belonging to another Organization is indistinguishable from one that does not exist (`404`, never `403`).

### How to clear the queue

1. Open `/memory`. If the **Awaiting review** panel is absent, there is nothing to do.
2. Read the row — title, class and description say where the text came from.
3. **Accept** to let it start feeding agent context, or **Reject** to archive it.
4. A failed action names the verb that failed and leaves the row in place, so a refusal never reads as a no-op.

Per-Work proposals — including the ability to edit the wording before accepting — are handled in the Work's own review queue at `/works/:id/kb/review`. See [Decisions & the Memory Review Queue](./memory-decisions.md).

## Consolidation

An append-only memory gets worse with age: the same fact arrives four times, an old note outranks the current one, and nobody can tell which version is in force. **Consolidation** is the pass that curates it. Three verbs, and **nothing is ever deleted**.

| Verb           | What it does                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Promote**    | The strongest documents (top 20 by default) get a **Promoted** badge. The marker reflects the latest run — a document that misses this run's top-N loses it.                  |
| **Supersede**  | In a near-duplicate group, the weaker documents are **marked** superseded and point at the survivor. Still readable; a document already superseded is never auto-resurrected. |
| **Synthesize** | A duplicate cluster of three or more is merged by the configured AI provider into one organization document, filed as `proposed` — it lands in the review queue, never live.  |

Scoring is a transparent additive formula, so a report is always explainable:

| Signal                                | Contribution                      |
| ------------------------------------- | --------------------------------- |
| Recency                               | up to 40 points, 30-day half-life |
| Substance (body length)               | up to 25 points                   |
| Tags                                  | 3 points each, capped at 5 tags   |
| Citations                             | 2 points each, capped at 5        |
| Always-injected class (brand, legal…) | +10 points                        |

Near-duplicates are found by comparing word 4-gram shingle sets and requiring a Jaccard similarity of at least 0.85 — a threshold high enough that two genuinely different documents on the same topic are not merged.

**Bounds and failure modes.** A run scans the newest 500 documents and says so in its notes when it truncated. At most five syntheses happen per run, each fed a 1,500-character excerpt per source document. If no AI provider is configured, synthesis is skipped with an explanatory note; a provider that throws downgrades to a note as well. The LLM path can never fail the run.

### How to run consolidation on demand

1. Open `/memory` and press **Consolidate** (top right).
2. Read the preview: `N scanned`, `N promoted`, `N synthesized`, `N superseded`, the first few promoted titles, the superseded `loser → survivor` pairs, and any notes. **Nothing has been written yet** — a bare run is always a dry run.
3. Press **Apply** to persist the markers, or **Cancel** to walk away.
4. The feed refreshes with the new **Promoted** / **Superseded** badges. Anything synthesized now sits in **Awaiting review**.

```bash
# Dry run — computes the full report, writes nothing
curl -X POST http://localhost:3100/api/memory/consolidate \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" -d '{}'

# Persist the markers
curl -X POST http://localhost:3100/api/memory/consolidate \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" -d '{"apply": true}'
```

### Scheduled consolidation

The **Scheduled consolidation** panel at the bottom of the page turns the same pass into a cadence.

| Setting               | Values                                                       | Default     |
| --------------------- | ------------------------------------------------------------ | ----------- |
| **Run on a schedule** | on / off                                                     | off         |
| **Every**             | Day / Week / Month                                           | Week        |
| **Mode**              | **Report only** (`dry-run`) / **Propose merges** (`propose`) | Report only |
| Notify                | on / off                                                     | on          |

The panel also shows **Last run**.

The `memory-consolidation-tick` job fires **daily at 08:37 UTC** — offset off the hour, and placed after the digest window so a morning digest never races a consolidation write. It only touches organizations that explicitly opted in, and the per-organization cadence is enforced against the last run, so one schedule serves all three cadences and a weekly organization is not consolidated seven times a week. On a self-hosted install the same job runs on whichever job-runtime plugin you configured: cadence is a job, not a cloud feature.

**Report only** computes and persists nothing. **Propose merges** persists the promote/supersede markers and lands syntheses as `proposed`. Neither mode ever auto-accepts anything, and neither deletes anything.

```
GET  /api/memory/consolidation/settings
PUT  /api/memory/consolidation/settings   { "enabled": true, "cadence": "weekly", "mode": "propose" }
```

Every field on the `PUT` is optional and merges onto what is stored, so you can flip one knob without restating the rest.

## Memory health

Consolidation curates. **Memory health** measures — it is the eval loop that tells you whether the memory is actually working. The metrics are organization-wide (`GET /api/memory/health`), and the panel that renders them sits above the review queue at **`/works/:id/kb/review`**, where "23 documents waiting, the oldest for 41 days" is the context that makes reviewing the queue feel worth doing.

| Metric              | The question it answers                                                              | Computed from                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **Recall hit rate** | Were the documents we injected into prompts actually cited afterwards?               | The retrieval log joined against citation rows over a rolling window (30 days by default, 1–365) |
| **Stale decisions** | How much of the decision log is settled calls nobody has revisited?                  | Accepted `decision` documents untouched past the freshness horizon (90 days by default)          |
| **Review backlog**  | How much agent-written memory is waiting — and therefore excluded from every prompt? | Count, oldest age in days, mean age in days                                                      |
| **Gap topics**      | Which questions did retrieval fail to answer at all?                                 | Retrieval events that returned zero documents                                                    |

Two rules the panel enforces. Every rate is nullable, and a null renders as **"Not measurable yet"** with the reason — never as `0%`, because "we measured zero" and "we cannot measure" are different facts. And the gap topics are not decoration: they are carried into the next consolidation run's synthesis prompt, so the merge is aimed at the holes you actually have.

## Files

The **Files** panel is one list over both upload spines — chat and plain uploads on one side, Knowledge Base originals on the other — organized into folders you define. Filing a file moves no bytes; it sets a folder on the existing row.

- **Scope toggle** — **All**, **Global**, or **Agents**. A folder is either Global or private to a single agent; agent-private folders carry an **Agent** badge.
- **New folder** and **Upload** create and fill folders; breadcrumbs navigate the tree; the search box searches every file you can see, not just the current folder.
- **Per file** — **Preview** (inline, with a download fallback for types that cannot render), **Move to folder** (choosing `— No folder —` unfiles it), **Download**.
- **Per folder** — **Sync now**, **Configure git sync**, **Delete folder**.
- **Provenance** labels tell you where a file came from: Work, Task, Mission, Idea, Agent, or Chat.

**Deleting never destroys bytes.** Removing a file only unfiles it from the Files area; deleting a folder unlinks its files and removes the tree. A non-empty folder refuses the delete until you confirm the recursive variant, and the confirmation says so explicitly: no file bytes are deleted.

**Git sync.** Configure a folder with a repository owner, a repository name, and optionally a branch and a directory inside the repo. **Sync now** then clones, writes the folder's files (and its subtree) under that prefix, commits and pushes, and reports `Synced: N committed, M skipped`. Version 1 targets GitHub through the git provider plugin. Files larger than 5 MB are reported in the skip list rather than committed, and a single unreadable file is marked failed while the rest of the walk continues.

### How to keep a Memory folder in Git

1. `/memory` → **Files** → **New folder**, and name it.
2. On the folder row, press **Configure git sync**.
3. Fill in the repository owner and name; add a branch and a folder-in-repo prefix if you want them, then **Save**.
4. Put files in the folder — **Upload** into it, or **Move to folder** on any existing row.
5. Press **Sync now**. The notice reports how many files were committed and how many were skipped.

The same operations are available over REST at `/api/memory/files`: `tree`, the unified list, `upload`, `folders`, `folders/:id/sync`, `move` and `:id/download`. Uploads on this route are capped at 50 MB.

## Agent Memory

This is the half of Memory that is **not** a knowledge base: what the agents themselves remember from their runs. The panel lists recent memory sessions with their start time and whether each is **Open** or **Closed**.

It is **read-only by design**. Sessions are opened, written and closed by agents during runs; someone browsing the page should be able to see that history without mutating it as a side effect of looking.

Agent memory lives in an external agent-memory backend rather than in Postgres — the only Postgres surface is the `memorySessionId` recorded on an agent run, which correlates the run with its session. Because the capability is plugin-backed and often not configured, the panel does not hide itself when unavailable; it says **"No agent-memory provider is enabled."** That absence is the answer to the question you came with.

| Endpoint                                    | What it does                         |
| ------------------------------------------- | ------------------------------------ |
| `GET /api/agent-memory/check-availability`  | Is a provider loaded, and which one? |
| `POST /api/agent-memory/sessions`           | Open a session                       |
| `GET /api/agent-memory/sessions`            | List recent sessions                 |
| `POST /api/agent-memory/sessions/:id/close` | Close an open session                |
| `POST /api/agent-memory/save`               | Persist an observation               |
| `POST /api/agent-memory/search`             | Search persisted memories            |
| `POST /api/agent-memory/context`            | Build a context payload for a prompt |
| `DELETE /api/agent-memory/entries/:id`      | Forget a single record               |

The first-party provider is the bundled `agentmemory` plugin; enable it from [Plugins](./plugins.md).

## Meetings

Meetings are a memory **source**, not a separate feature — every transcript and summary is ingested straight into Memory — so the catalog renders as a block on this page at `#meetings` rather than owning a sidebar entry. Filter it by source and by the Work a meeting was routed to.

`/meetings` redirects here carrying its query string, so old bookmarks and deep links keep working. `/meetings/new` and `/meetings/:id` are unchanged. See [Integrations → Meetings](./integrations.md#meetings) for how Zoom and Google Workspace feed it. [Meetings](./meetings.md) is the full page for the feature — the record shape, what attaching a transcript triggers, the Zoom and Google Meet sync, and the `list_meetings` / `get_meeting_summary` chat tools.

## Recall injection into runs

Memory only matters if it reaches the prompt. One shared helper resolves and formats the recalled block for every surface, so what an agent "remembers" does not depend on which path invoked it:

- **Agent runs** (task-kind) append the block to the assembled system message and record it on the run log.
- **Self-managed pipeline dispatch** resolves the block once and hands it to the pipeline plugin, so every session-based pipeline splices an identical, pre-fenced string into its preamble with zero per-plugin formatting logic.

Recalled memory is treated as **untrusted** — it replays content from earlier runs that may have processed hostile external text. The helper is the single place that wraps the payload in an `<agent_memory>` fence with an explicit lower-trust preamble, breaks forged fence-boundary tokens, and strips chat-template control markers. The payload is budgeted (about 1,500 tokens, with a hard character cap and deterministic tail truncation, so knowledge-base context and agent memory cannot starve each other) and time-boxed at 10 seconds, because a slow memory backend must never hold up a run.

When a provider **is** configured but returns nothing, the fence carries an explicit "no relevant memory was found" note — so an operator reading the prompt can tell "recall on, store empty" apart from "recall off".

Recall is on by default and can be turned off at two levels:

| Toggle    | How                                                            | Effect                                                                 |
| --------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Per Work  | `PATCH /api/works/:id` with `{ "memoryRecallEnabled": false }` | Self-managed pipeline runs for that Work skip the fenced recall block. |
| Per Agent | The Agent's `memoryRecallEnabled` field                        | Task-kind runs of that Agent skip the block.                           |

Neither touches the write path: sessions still open, save and close, so turning recall off stops the reading, not the remembering.

## Reaching Memory from a machine

The per-Work Knowledge Base — the substrate Memory aggregates — is available over the [MCP server](./mcp-server.md) and the CLI, so an external session or a script can read and write it under the same access controls.

| Operation      | MCP tool    | CLI                                                                |
| -------------- | ----------- | ------------------------------------------------------------------ |
| List documents | `kb.list`   | `ever works kb list <workId> [--class --tag --q --limit --offset]` |
| Read one       | `kb.get`    | `ever works kb get <workId> <idOrPath> [--json]`                   |
| Create         | `kb.create` | —                                                                  |
| Update         | `kb.update` | —                                                                  |
| Upload a file  | —           | `ever works kb upload <workId> <filePath> [--title --class]`       |
| Lock           | `kb.lock`   | `ever works kb lock <workId> <idOrPath> --mode <full\|content>`    |
| Unlock         | `kb.unlock` | `ever works kb unlock <workId> <idOrPath>`                         |

The org-wide surfaces — the aggregation, the review queue, consolidation and Files — are REST-only today. Full argument reference: [KB over MCP & CLI](../kb/mcp-cli-reference.md).

## Coming soon

- **External memory and RAG plugins.** The plugin manifest carries `memory` and `rag` categories with capability contracts (`IMemoryPlugin`, `IRagPlugin`) for pluggable organization memory frameworks and composed retrieval pipelines. **No plugin ships under either category yet** — they are contracts only, sitting beside the existing `vector-store` and `content-extractor` seams rather than replacing them. Built-in retrieval is unchanged and remains the default.
- **Mission and Team facets, and the graph view** of the Memory feed, are deferred behind cross-feature prerequisites.

Everything else on this page is shipped and reachable today.

## API reference

| Method  | Endpoint                                       | What it does                                                                     |
| ------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET`   | `/api/memory`                                  | Faceted aggregation — `q`, `type`, `work`, `status`, `source`, `limit`, `offset` |
| `GET`   | `/api/memory/health`                           | Health metrics — `windowDays`, `staleAfterDays`                                  |
| `POST`  | `/api/memory/consolidate`                      | Dry-run report, or `{"apply": true}` to persist markers                          |
| `GET`   | `/api/memory/consolidation/settings`           | Scheduled-pass settings plus `lastRunAt`                                         |
| `PUT`   | `/api/memory/consolidation/settings`           | Enable, set cadence and mode                                                     |
| `GET`   | `/api/memory/review`                           | The proposed-document queue                                                      |
| `POST`  | `/api/memory/review/:docId/accept`             | Accept a proposal                                                                |
| `POST`  | `/api/memory/review/:docId/reject`             | Archive a proposal                                                               |
| `GET`   | `/api/memory/uploads`                          | Organization-scoped originals with extraction status                             |
| `POST`  | `/api/memory/uploads`                          | Multipart upload into Memory                                                     |
| `POST`  | `/api/memory/uploads/from-attachments`         | Ingest chat attachments you already uploaded                                     |
| `GET`   | `/api/memory/files` · `/api/memory/files/tree` | Unified file list, and the folder tree with counts                               |
| `POST`  | `/api/memory/files/upload`                     | Upload into a folder                                                             |
| `POST`  | `/api/memory/files/folders`                    | Create a folder (Global or agent-private)                                        |
| `PATCH` | `/api/memory/files/folders/:id`                | Rename, move, or set the git-sync target                                         |
| `POST`  | `/api/memory/files/folders/:id/sync`           | "Sync now" — commit the folder to its repository                                 |
| `PATCH` | `/api/memory/files/move`                       | File or unfile documents                                                         |
| `GET`   | `/api/memory/files/:id/download`               | Download a file's bytes                                                          |
| `GET`   | `/api/organizations/:orgId/kb/documents`       | List organization-level documents                                                |
| `POST`  | `/api/organizations/:orgId/kb/documents`       | Create an organization-level document                                            |

## Related

- [Knowledge Base & Memory](./knowledge-base.md) · [Decisions & Review](./memory-decisions.md) · [KB user guide](../kb/user-guide.md)
- [Agents](./agents.md) · [Autonomous Operation](./autonomous-operation.md) · [Advanced Prompts](./advanced-prompts.md)
- [Integrations](./integrations.md) · [Plugins](./plugins.md) · [MCP Server](./mcp-server.md)
- [Activity](./activity.md) · [Data Management](./data-management.md) · [KB over MCP & CLI](../kb/mcp-cli-reference.md)
