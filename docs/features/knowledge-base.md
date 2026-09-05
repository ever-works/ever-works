---
id: knowledge-base
title: Knowledge Base & Memory
sidebar_label: Knowledge Base & Memory
description: The per-Work Knowledge Base — typed, Git-backed documents, file ingest and extraction, hybrid lexical plus semantic search over a pluggable vector store, locks and inheritance, and the MCP, CLI and REST surfaces.
---

# Knowledge Base & Memory

Every [Work](./creating-a-work.md) in Ever Works has its own **Knowledge Base (KB)** — a structured, typed, Git-backed store of institutional context: brand voice, legal copy, SEO conventions, glossary, competitor lists, audience personas, prior research, and the artifacts your [Agents](./agents.md) produce. It's the memory that makes the "maintain" half of _research → generate → deploy → maintain_ mean something. Without it, every scheduled run starts from a blank prompt; with it, the runtime accumulates a durable, owned understanding of what your business actually is.

This is the built-in equivalent of an internal wiki and a long-term memory layer — owned by you, versioned in Git, and read by every pipeline automatically.

## What lives in the KB

A **KB document** is one piece of institutional context. Each has a markdown body, a metadata sidecar, a hierarchical path, a class, tags, and a status. Documents are **typed** by class, and the class drives how Agents use the document:

| Class         | How Agents treat it                                                       |
| ------------- | ------------------------------------------------------------------------- |
| `brand`       | Soft guidance — "follow these brand guidelines".                          |
| `legal`       | Verbatim-or-omitted — copied exactly, never paraphrased.                  |
| `seo`         | Constraints — target keywords and structured-data patterns per page type. |
| `glossary`    | Term substitution — always use these terms, never invent synonyms.        |
| `competitors` | Inclusion / exclusion — drives comparisons and the do-not-mention rule.   |
| `personas`    | Audience definitions — write for these readers.                           |
| `style`       | Editorial style guide — grammar, banned words, voice, tense.              |
| `research`    | Reference material — retrieved opportunistically and cited.               |
| `output`      | Agent-authored artifacts — reports, summaries, decks.                     |
| `freeform`    | Catch-all notes — retrieved by similarity or explicit mention.            |

Two more axes travel with every document and are filterable everywhere the KB is listed:

- **Status** — `draft`, `active` or `archived`. An archived document stays readable and stays in Git; it simply stops being injected.
- **Source** — `user`, `agent`, `imported` or `seeded`, so you can always tell what a human wrote from what a run produced.

## Git-backed, two-layer storage

The KB lives in two synchronized places:

- **The Work's Git data repository** under `.content/kb/` — one folder per class, each document a `<slug>.md` + `<slug>.yml` pair, plus an auto-maintained `.index.yml`. This is the durable, portable, diff-able source of truth that every downstream pipeline already reads.
- **The database** — fast queries, search, locks, and audit metadata.

Because the agent-readable layer is always in Git, you own it, you can inspect it, and nothing is locked in.

## The workbench

A dedicated page at **`/works/:id/kb`** gives you:

- A two-pane tree — the **KB** (agent-readable extracts) and the **Originals** (your uploaded source files).
- A center editor — a WYSIWYG markdown editor for `.md` documents, and inline viewers for PDFs, spreadsheets, video, and other originals.
- An **AI side panel** scoped to the KB — `@mention` any document (`@kb:brand/voice`) to pin it into context; answers come back with citations.
- A top bar with search and filters by class, tag, status, and lock state.

A sibling page at **`/works/:id/kb/review`** holds the review queue for agent-written material — see [Memory & Decisions](./memory-decisions.md).

## Ingest: drop a file, get usable knowledge

Drop a PDF, Word doc, spreadsheet, image, video, or URL into the workbench and the platform:

1. Stores the **original** verbatim in the Work's configured storage plugin (GitHub, S3, MinIO, local FS).
2. Normalizes media (video → MP4, audio → MP3 + transcript) where needed.
3. Runs the configured **content extractor** plugin to produce an agent-readable markdown extract.
4. Classifies and tags it (you choose, or let the AI suggest), writes it into Git, and indexes it for retrieval.

Agents never read the binary original — they read the clean extract.

### What gets extracted from what

Files uploaded through the workbench are extracted **in process**, from the bytes the upload already holds — there is no self-referential HTTP round trip, so a private storage backend behaves exactly like a public one. Routing is by MIME type:

| Uploaded file              | What lands in the KB document                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `.md`, `.markdown`, `.txt` | Passthrough, UTF-8 decoded. Document bodies are capped at 1 MiB.                                          |
| `.html`, XHTML             | Converted to Markdown.                                                                                    |
| `.pdf`                     | Text layer extracted and wrapped as a Markdown body.                                                      |
| `.docx`                    | Word OOXML → HTML → Markdown. Legacy binary `.doc` is deliberately not routed — convert it and re-upload. |
| `.xlsx`, `.xlsm`           | One Markdown table per sheet, with the sheet name as an `##` heading.                                     |
| `.csv`                     | A single Markdown table.                                                                                  |
| `.tsv`                     | The same, tab-delimited.                                                                                  |
| `.pptx`                    | One `## Slide N` section per slide, carrying that slide's text.                                           |
| Anything else              | The original is stored and downloadable; the upload is marked **Not extractable** ("no extractor route"). |

The **Originals** pane reports where each file got to:

| Chip                  | Meaning                                                                    |
| --------------------- | -------------------------------------------------------------------------- |
| **Pending**           | Accepted and queued.                                                       |
| **Extracting…**       | Extraction is running.                                                     |
| **Extracted**         | A KB document exists — **Open extracted document** jumps straight to it.   |
| **Not extractable**   | No extractor route for that MIME type. The original is kept, not the text. |
| **Extraction failed** | Something broke; the row offers **Retry extraction**.                      |

### How to upload a source and confirm agents can read it

1. Open **`/works/:id/kb`** and drag the file onto the tree — the empty Originals pane says exactly that: _"No original files yet. Drag a file onto the tree to upload one."_
2. Switch to the **Originals** pane and watch the status chip move **Pending** → **Extracting…** → **Extracted**.
3. On **Extracted**, click **Open extracted document**, then set the document's class and tags in the metadata panel — the class is what decides how the text is used.
4. On **Extraction failed**, hover the chip for the error and press **Retry extraction** (`POST /api/works/:id/kb/uploads/:uploadId/retry-extraction`).
5. On **Not extractable**, use **Download original** to get the file back, convert it to one of the routed formats above, and re-upload.

From a terminal the same upload is one command:

```bash
ever-works kb upload <workId> ./brand-guide.pdf --class brand --title "Brand guide v3"
```

### Extractor plugins — for URLs, not uploads

Source **URLs** processed during generation take the other path: the content-processor facade hands the URL to a [content-extractor plugin](./plugins.md). These are configured at **Settings → Plugins → Content Processors** (`/settings/plugins/content-extractor`).

| Plugin                    | Handles                               | Enabled by default | Notes                                                                                                                 |
| ------------------------- | ------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `local-content-extractor` | General web pages                     | Yes                | Built in and auto-enabled — the default processor.                                                                    |
| `pdf-extractor`           | URLs ending `.pdf`                    | No                 | Text-layer extraction first, with an OCR fallback for scanned PDFs. Built in, off until you enable it.                |
| `officecli-extractor`     | URLs ending `.docx`, `.xlsx`, `.pptx` | No                 | Delegates to the OfficeCLI tool through its official Node SDK. Optional; emits plain text or markdown (`renderMode`). |
| `notion-extractor`        | Notion pages                          | No                 | Installed from the plugin registry.                                                                                   |

**PDF OCR.** `pdf-extractor` measures text density per page. Below the threshold (100 characters per page by default) the PDF is treated as scanned and — **only if a Mistral API key is configured** — re-read with OCR (`mistral-ocr-latest`), and the OCR markdown is used instead. With no key configured the plugin returns the sparse text-layer result rather than failing. Settings: `mistralApiKey` (secret, or `PLUGIN_PDF_EXTRACTOR_API_KEY`), plus hidden knobs for the OCR model, the text-density threshold, a page cap (50) and a timeout.

**Office documents.** `officecli-extractor` is optional and off by default; enable it when your sources include Office files behind URLs. It enforces an SSRF guard on the fetch and a download cap (25 MB by default, `maxBytes`).

Both plugins are additive: enabling one never removes the default processor, it just claims the file types it recognizes.

## Search: lexical, semantic, and both

The workbench search box and `GET /api/works/:id/kb/documents` accept a `q` query. By default `q` matches **title and description**; pass `searchBody=true` to search the body text as well. Filters stack on top: `class` (repeatable), `source` (repeatable), `status`, `tag`, `locked`, `language`, `reviewState`, plus `limit` / `offset`.

Underneath, KB retrieval is **hybrid**. A lexical filter and a vector nearest-neighbour search each produce a ranked list, and the two are fused with **Reciprocal Rank Fusion** — `score(doc) = Σ 1 / (k + rank + 1)`, with `k = 60`. RRF uses ordinal rank rather than raw scores, so swapping the embedding model does not force a re-tune of any weighting, and ties break deterministically by document id so the search palette never flickers between renders.

## Vector stores — where the embeddings live

Document chunks are embedded and stored through a pluggable **vector-store** capability, so semantic search is not tied to one backend. Configure it at **Settings → Plugins → Vector Stores** (`/settings/plugins/vector-store`); a Work can override the choice on its own plugin list at `/works/:id/plugins` (managers and owners only).

| Vector store | Ships enabled                           | Where chunks live                                                                                      | Notable settings                                                                                                                          |
| ------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pgvector`   | Yes — the default                       | The API's own Postgres, in `work_knowledge_chunks`; every query is row-filtered by `work_id`           | `embeddingModel` (default `text-embedding-3-small`), `embeddingDimensions` (1536), `indexType` (`ivfflat` or `hnsw`), `lists`, `efSearch` |
| `qdrant`     | No — installed from the plugin registry | A Qdrant cluster, managed or self-hosted, with one collection per Work (`{collectionPrefix}-{workId}`) | `qdrantUrl`, `qdrantApiKey` (secret), `collectionPrefix`, `vectorSize`, `distance` (`cosine`, `dot`, `euclid`), `upsertBatchSize`         |

Neither backend embeds on write — the platform vectorizes chunks through the AI provider first, then writes them. Which store a query uses is resolved by a fixed chain: a caller-pinned provider, then the operator pin `KB_VECTOR_STORE_PROVIDER_ID`, then the vector-store plugin enabled for that Work, then the registry default (`pgvector`). If nothing resolves, the platform raises a "vector store not configured" error instead of silently degrading. `KB_EMBEDDING_MODE` (`auto` by default, or `pgvector` / `external`) decides whether retrieval takes the built-in Postgres path or the plugin-routed one.

:::warning Changing the embedding model or dimensions is not free
Stored vectors were produced by a specific model at a specific dimension. Change either and you retrieve from a mixed vector space with badly degraded recall. Plan a full re-embed sweep — and for `pgvector`, a column-altering migration — alongside the change. Qdrant cannot resize a collection in place at all; it has to be recreated.
:::

### How to move a Work's embeddings to Qdrant

1. Install the Qdrant plugin from the registry — it is not bundled into the platform image.
2. Go to **Settings → Plugins → Vector Stores** (`/settings/plugins/vector-store`) and open **Ever Works Qdrant Vector Store**.
3. Fill in `qdrantUrl`, and `qdrantApiKey` for a managed cluster or anything behind auth. Leave `collectionPrefix` at `ever-works-kb` unless you share the cluster.
4. Match `vectorSize` and `embeddingModel` to whatever produced your existing vectors — or accept that you are re-embedding from scratch.
5. Enable it for the Work on `/works/:id/plugins`, or pin it installation-wide with `KB_VECTOR_STORE_PROVIDER_ID=qdrant`.
6. Re-embed, then re-run a query you know the answer to in the workbench search box and confirm the expected documents come back.

How this differs from file storage — and why one never implies the other — is covered in [Storage Backends](./storage-backends.md).

## How Agents use it

- **Deterministic injection** — `brand`, `legal`, `glossary`, `style`, `personas`, and page-matched `seo` documents are injected into every relevant run, capped by a token budget with class-precedence truncation.
- **Query-driven retrieval** — `research`, `freeform`, and `output` documents are retrieved by semantic similarity for the task at hand, and every use is recorded as a **citation** so you can audit exactly what context produced a given output.
- **Agents write back** — research notes and generated artifacts land in the KB as `output`-class documents, under the same governance (locks, audit trail, Git history) as your own documents.

In-platform Agents reach the KB through their own tool names — `kb_search`, `kb_read`, `kb_write`, `kb_lock`, `kb_unlock` — which are separate from the MCP `kb.*` tools below. `kb_write` upserts by path, so an Agent creating and then updating the same document is one idempotent call.

## Locks, inheritance, and audit

- **Per-document locks** (`full` or `additions-only`) protect a document from being changed by scheduled regeneration or Agent runs.
- **Org-level inheritance** — `legal`, `style`, and `seo` documents can be published once at the organization level and inherited by every Work, with per-Work override. (See [Tenants & Organizations](../advanced/multi-tenancy.md).)
- **Full audit** — every KB mutation flows through the activity log and Git history.

Organization-level documents are created by uploading into org-wide Memory, or by calling `POST /api/organizations/:orgId/kb/documents` directly; writes go through an organization-admin gate and only the three inheritable classes are accepted. `GET /api/works/:id/kb/inheritable` reports which organization documents a given Work actually inherits — the Work's own organization decides that, never an `orgId` supplied by the caller.

### Beyond one Work: org-wide Memory

The KB is per Work. **[Memory](./memory.md)** (`/memory`) is the layer above it: every Work's KB documents plus the organization-level ones, in one searchable, faceted list, alongside uploaded files, agent memory, meetings, a review queue and a consolidation pass. It adds no second copy of your knowledge — it aggregates the same rows — and the per-Work workbench keeps working exactly as it does today.

## Reaching the KB from anywhere

The KB is exposed over REST, the [MCP server](./mcp-server.md), and the [CLI](../cli/commands.md), so external Claude / GPT / Gemini sessions and scripts can read and write it with the same access controls. Both machine surfaces are thin wrappers over the same `/api/works/:id/kb/*` endpoints.

| Operation     | REST                                             | MCP tool    | CLI                                |
| ------------- | ------------------------------------------------ | ----------- | ---------------------------------- |
| List docs     | `GET /api/works/:id/kb/documents`                | `kb.list`   | `ever-works kb list`               |
| Read one doc  | `GET /api/works/:id/kb/documents/:docIdOrPath`   | `kb.get`    | `ever-works kb get`                |
| Create a doc  | `POST /api/works/:id/kb/documents`               | `kb.create` | —                                  |
| Update a doc  | `PATCH /api/works/:id/kb/documents/:docId`       | `kb.update` | —                                  |
| Lock a doc    | `POST /api/works/:id/kb/documents/:docId/lock`   | `kb.lock`   | `ever-works kb lock --mode <mode>` |
| Unlock a doc  | `POST /api/works/:id/kb/documents/:docId/unlock` | `kb.unlock` | `ever-works kb unlock`             |
| Upload source | `POST /api/works/:id/kb/uploads` (multipart)     | —           | `ever-works kb upload`             |

`kb.list` and `kb.get` are annotated read-only. Every tool takes a `workId` UUID; the document-scoped tools take an `idOrPath` that resolves either a document UUID or a slash-separated KB path such as `brand/voice` — the tool resolves a path to an id before issuing a mutation, so you never have to look one up by hand.

:::note Lock modes differ by surface
The API and the `kb.lock` MCP tool accept exactly two modes, `full` and `additions-only`. The CLI's own validator accepts `full` and `content`, so `ever-works kb lock … --mode full` is the combination that works end to end today. For an additions-only lock, use the workbench toggle, the `kb.lock` MCP tool, or `POST /api/works/:id/kb/documents/:docId/lock` directly.
:::

### How to drive the KB from an MCP client

1. Connect your client to the Ever Works MCP server — see [MCP Server](./mcp-server.md) for the endpoint and credentials.
2. Call `kb.list` with the Work's UUID to see what is there; narrow with `class`, `status`, `tag`, `q`, `limit` and `offset`.
3. Call `kb.get` with an `idOrPath` such as `brand/voice` to read the full body, its metadata, and linked asset summaries.
4. Call `kb.create` with `path`, `title`, `body` and `class` to file something new, or `kb.update` with a `patch` object to amend only the fields you name.
5. Call `kb.lock` with `lockMode: "full"` once the wording is final, and `kb.unlock` to reopen it.

### How to script the KB from the CLI

```bash
ever-works auth login
ever-works kb list <workId> --class brand --limit 50
ever-works kb list <workId> --q "tone of voice"
ever-works kb get <workId> brand/voice --json | jq '.tags'
ever-works kb upload <workId> ./calls/2026-09-01.mp3 --class research
ever-works kb lock <workId> legal/disclaimer --mode full
ever-works kb unlock <workId> legal/disclaimer
```

The binary is `ever-works` (published as `ever-works-cli`), `kb` is a top-level command group, and auth reuses the same token store as the rest of the CLI. Field-by-field tables for both machine surfaces live in the [MCP & CLI Reference](../kb/mcp-cli-reference.md).

> **Built-in, with room to extend.** Memory, wiki, and knowledge management ship _inside_ Ever Works as first-class features rather than something you bolt on. Where you want to connect an external knowledge or memory system, that arrives as a plugin alongside these built-ins — additive, never a replacement. The `memory` and `rag` plugin categories exist as capability contracts today; no plugin ships under either yet, and built-in retrieval remains the default.

## See also

- [Agents (Your AI Employees)](./agents.md) · [Advanced Prompts](./advanced-prompts.md)
- [Creating a Work](./creating-a-work.md) · [Autonomous Operation](./autonomous-operation.md)
- [Data Management](./data-management.md) · [MCP Server](./mcp-server.md)
- [Memory (Org-Wide)](./memory.md) · [Memory & Decisions](./memory-decisions.md)
- [Storage Backends](./storage-backends.md) · [Plugins](./plugins.md) · [Settings map](./settings-map.md)
- Reference: [Knowledge Base user guide](../kb/user-guide.md) · [MCP & CLI Reference](../kb/mcp-cli-reference.md) · [Knowledge Base & Memory guide](../guides/knowledge-base-and-memory.md)
