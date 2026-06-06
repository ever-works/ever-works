---
id: user-guide
title: Knowledge Base — User Guide
sidebar_label: User Guide
---

# Knowledge Base — User Guide

The **Work Knowledge Base (KB)** is the durable, structured memory of a
Work. It's where you put the things every Agent needs to know — brand
voice, style guide, glossary, audience personas, legal copy, prior
research, transcripts, competitor lists — and where Agents write back
the artifacts they produce.

This page is the end-user perspective: what the KB stores, how to put
things in, how to lock things down, what gets inherited from your
organization, and how to find it again.

For a higher-level introduction, see
[Knowledge Base & Memory (Features)](../features/knowledge-base.md). For
machine-driven access (Claude / GPT / Gemini sessions, scripts, CI),
see the [MCP & CLI Reference](./mcp-cli-reference.md).

## Where the KB lives

Every Work has a KB at **`/works/:id/kb`**. The workbench is a
two-pane interface:

- **KB pane** — agent-readable, typed Markdown documents. Each
  document has a path (e.g. `brand/voice`), a class, tags, a status,
  and a lock state.
- **Originals pane** — the verbatim source files you uploaded
  (PDFs, Word docs, MP4s, MP3s, images, URLs). Agents never read these
  directly; the platform produces a Markdown **extract** from each
  original and that's what lands in the KB pane.

The center of the workbench is a Markdown editor for KB documents and
an inline viewer (PDF, video, image, spreadsheet) for originals. A side
panel runs a KB-scoped chat — `@kb:brand/voice` pins a document into
the prompt and answers come back with citations.

## What lives in the KB — document classes

Every KB document has a **class**. The class drives how Agents treat
it:

| Class         | Meaning                       | How Agents use it                                                                  |
| ------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| `brand`       | Brand voice, identity, tone   | Soft guidance — "write in this voice", retrieved on every relevant run             |
| `style`       | Editorial style guide         | Grammar, banned words, tense, voice — applied as constraints                       |
| `legal`       | Legal copy, disclaimers       | Verbatim or omitted — Agents copy exactly, never paraphrase                        |
| `seo`         | SEO conventions, keywords     | Constraints — target keywords + structured-data patterns per page type             |
| `glossary`    | Approved terminology          | Term substitution — Agents always use these terms, never invent synonyms           |
| `personas`    | Audience personas             | Targeting — Agents write for these readers                                         |
| `competitors` | Competitor list + rules       | Inclusion / exclusion — drives comparisons and the do-not-mention rule             |
| `research`    | Background research, notes    | Retrieved by semantic similarity when relevant to the task at hand                 |
| `transcripts` | Audio / video transcripts     | Treated as research — extracted by Whisper-class transcription, retrieved by topic |
| `output`      | Agent-authored artifacts      | Reports, summaries, decks — Agents write here, you can promote / archive           |
| `freeform`    | Catch-all notes               | Retrieved by similarity or explicit `@mention`                                     |

You don't have to use every class. A common starting setup is `brand`
+ `style` + `glossary` + `personas` — enough for Agents to sound like
you. Add `research` and `transcripts` once you start ingesting source
material.

## Uploading sources

Drop a file into the Originals pane (or call `POST
/api/works/:id/kb/uploads`, or run `ever works kb upload`). The platform
runs the same pipeline regardless of where the file came from:

1. **Store the original** verbatim via the active **storage plugin**
   (default `local-fs`; switchable to `aws-s3`, `minio`, or
   `github-storage` — see
   [Storage plugins](../architecture/plugins.md#storage-plugins-in-detail)).
2. **Sniff the MIME type** from the file's magic bytes (the
   client-supplied MIME is never trusted).
3. **Normalize media** when the file isn't text:
   - Video → MP4 + extracted MP3 audio track.
   - Audio → MP3.
   - PDF / DOCX / XLSX → text via the configured content-extractor
     plugin.
4. **Transcribe audio** (MP3 from a video, or a directly-uploaded
   podcast / call recording) via the AI provider that advertises the
   `transcribe` capability — OpenAI Whisper today, Groq's Whisper-large
   in operator-pin mode. The transcript becomes a `transcripts`-class
   KB document.
5. **Extract** the text from the original and classify it. You can
   choose the target class on upload (`--class brand`, `targetClass=brand`)
   or let the AI suggest one.
6. **Write the extract** into the KB as a Markdown document, tagged
   with `source-upload-id:<id>` and linked back to the original.
7. **Index** the document for retrieval (lexical + semantic).

Agents only ever read the extract, never the binary original. That
means a 200-page PDF turns into a chunked, citable Markdown document
that fits in a prompt window. The original stays in storage for human
review.

### Transcription pipeline (audio / video)

When you upload an audio file or a video with an audio track:

1. **Storage** keeps the original.
2. The **media-normalize** service produces an MP3 (or extracts the
   audio track from video) and stores it as a derived asset.
3. The **transcribe** service calls
   `AiFacadeService.transcribe(...)`. If the operator has pinned a
   provider via `KB_TRANSCRIPTION_PROVIDER_ID` that one wins; otherwise
   the facade walks the standard
   [provider-selection chain](../architecture/plugins.md#how-aifacadeservice-selects-a-provider)
   for plugins that advertise the `transcribe` capability.
4. The transcript lands as a `transcripts`-class KB document
   (`transcripts/<slug>.md`) with a YAML sidecar that records the
   source upload id, audio duration, and language.
5. A `kb-transcription-completed` (or `kb-transcription-failed`)
   activity-log event is recorded and a matching PostHog event fires
   for observability.

If no provider supports transcription, the upload row is marked
`extractionStatus='failed'` with
`extractionError='no transcription provider'` and the workbench shows
a banner asking the operator to configure or pin one.

## Editing and creating documents

The Markdown editor in the workbench supports:

- WYSIWYG and raw-Markdown modes.
- `@kb:<path>` cross-references — these become first-class links and
  drive the citation graph.
- `@upload:<id>` references — embeds a viewer for the original.
- Front-matter for class, tags, status, and lock state — you can edit
  the YAML directly or use the metadata side panel.

Creating a document from scratch is `kb.create` (MCP), `ever works kb
upload` (CLI, for files), or the "+ New document" button in the
workbench. Documents are written into the Work's git data repo under
`.content/kb/<class>/<slug>.md` + `.content/kb/<class>/<slug>.yml` so
every change is a git commit with full history.

## Locks

A **lock** stops Agents from changing a document during scheduled
regeneration or autonomous runs. Two modes:

| Mode              | Effect                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `full`            | All agent edits are rejected. Humans can still edit via the workbench.                                       |
| `additions-only`  | Agents may **append** new content (typically new research notes) but cannot modify existing body or metadata. |

Lock / unlock is exposed in the workbench (the padlock icon), via the
CLI (`ever works kb lock <workId> <idOrPath> --mode=full`), and via
the MCP `kb.lock` / `kb.unlock` tools. Every lock change is recorded
as a `kb-document-locked` / `kb-document-unlocked` activity-log event
with the actor, the mode, and the previous state, so you can audit
when content went read-only and who did it.

Use `full` for legal copy and approved brand statements that must
never drift. Use `additions-only` for research dossiers where you
want the Agent to keep gathering material but never rewrite what it
already gathered.

## Inherited docs from your organization

`legal`, `style`, and `seo` documents can be published once at the
**organization scope** and inherited by every Work in that
organization. The pattern:

1. An org admin creates the doc at `/orgs/:id/kb` (UI mirrors the
   per-Work workbench).
2. Every Work in the org sees that doc in its KB list with an
   "Inherited" badge. Agents pull it on every relevant run.
3. A Work can **override** the inherited doc by creating a doc with
   the same path at the Work scope. The Work-scoped version wins for
   that Work; the org-scoped version still applies everywhere else.
4. Locks set at the org scope cascade — a `full`-locked org doc is
   never overridable until the org admin unlocks it.

This is how a single, lawyer-approved disclaimer or a single house
style guide spans dozens of Works without copy-paste drift. See
[Tenants & Organizations](../advanced/multi-tenancy.md) for the
broader scoping model.

## Search

The KB exposes three lookups:

- **Lexical** — title / description / body string match. Fast, exact,
  used by the workbench search bar's default mode and by `kb.list` /
  `ever works kb list --q "..."`.
- **Semantic** — embedding similarity over chunked document bodies.
  Used by Agents during retrieval-augmented runs and by the workbench
  search bar's "smart search" toggle.
- **Filter** — class / tag / status / lock state. The most common
  way operators slice the KB ("show me everything `legal` that's
  `additions-only`-locked", "show me all `research` tagged
  `competitor:acme`").

Citations from Agent runs back-link to the exact chunk that produced
the output. Open any generated page in the dashboard, hover the
citation marker, and you jump straight to the source KB document — a
full audit trail with no hand-tracing.

## What's coming next

The KB is built-in and intentionally opinionated, but it leaves room
for plugins to extend it:

- **External memory systems** (Mem0, custom vector stores) plug in via
  the same `IStoragePlugin` + retrieval-plugin contract — additive,
  never a replacement for the built-in KB.
- **Custom extractor plugins** swap out the default content extractor
  for one tuned to your domain (legal contracts, medical literature,
  internal wikis).

## See also

- [Knowledge Base & Memory (Features)](../features/knowledge-base.md) — high-level pitch
- [KB MCP & CLI Reference](./mcp-cli-reference.md) — machine access
- [Plugin System (End-to-End)](../architecture/plugins.md) — how storage / transcribe / extractor plugins back the KB
- [Activity Log](../api/activity-log.md) — KB events surface here
- [MCP Server](../features/mcp-server.md) — the broader MCP surface
