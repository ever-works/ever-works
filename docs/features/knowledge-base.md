---
id: knowledge-base
title: Knowledge Base & Memory
sidebar_label: Knowledge Base & Memory
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

## Ingest: drop a file, get usable knowledge

Drop a PDF, Word doc, spreadsheet, image, video, or URL into the workbench and the platform:

1. Stores the **original** verbatim in the Work's configured storage plugin (GitHub, S3, MinIO, local FS).
2. Normalizes media (video → MP4, audio → MP3 + transcript) where needed.
3. Runs the configured **content extractor** plugin to produce an agent-readable markdown extract.
4. Classifies and tags it (you choose, or let the AI suggest), writes it into Git, and indexes it for retrieval.

Agents never read the binary original — they read the clean extract.

## How Agents use it

- **Deterministic injection** — `brand`, `legal`, `glossary`, `style`, `personas`, and page-matched `seo` documents are injected into every relevant run, capped by a token budget with class-precedence truncation.
- **Query-driven retrieval** — `research`, `freeform`, and `output` documents are retrieved by semantic similarity for the task at hand, and every use is recorded as a **citation** so you can audit exactly what context produced a given output.
- **Agents write back** — research notes and generated artifacts land in the KB as `output`-class documents, under the same governance (locks, audit trail, Git history) as your own documents.

## Locks, inheritance, and audit

- **Per-document locks** (`full` or `additions-only`) protect a document from being changed by scheduled regeneration or Agent runs.
- **Org-level inheritance** — `legal`, `style`, and `seo` documents can be published once at the organization level and inherited by every Work, with per-Work override. (See [Tenants & Organizations](../advanced/multi-tenancy.md).)
- **Full audit** — every KB mutation flows through the activity log and Git history.

## Reaching the KB from anywhere

The KB is exposed over REST, the [MCP server](./mcp-server.md) (`kb.list`, `kb.read`, `kb.search`, `kb.create`, `kb.update`, `kb.upload`), and the CLI (`ever works kb …`), so external Claude / GPT / Gemini sessions and scripts can read and write it with the same access controls.

> **Built-in, with room to extend.** Memory, wiki, and knowledge management ship _inside_ Ever Works as first-class features rather than something you bolt on. Where you want to connect an external knowledge or memory system, that arrives as a plugin alongside these built-ins — additive, never a replacement.

## See also

- [Agents (Your AI Employees)](./agents.md) · [Advanced Prompts](./advanced-prompts.md)
- [Creating a Work](./creating-a-work.md) · [Autonomous Operation](./autonomous-operation.md)
- [Data Management](./data-management.md) · [MCP Server](./mcp-server.md)
