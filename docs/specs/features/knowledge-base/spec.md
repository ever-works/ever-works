# Knowledge Base

**Status**: `Draft`
**Last updated**: 2026-05-21
**Audience**: Agents and engineers building, reviewing, or integrating with the Knowledge Base subsystem (`apps/api`, `apps/web`, `apps/mcp`, `apps/cli`, `packages/agent`, `packages/plugins/*`, directory templates).
**Scope**: Per-Work, typed, Git-backed institutional context (brand voice, legal copy, SEO, glossary, competitors, personas, research, agent outputs) consumed by every generation pipeline, scheduled regeneration, community PR, comparison, and AI conversation on the platform.

See also: [Architecture: Database & TypeORM](../../architecture/database.md), [Architecture: Plugin SDK](../../architecture/plugin-sdk.md), [AI Facade architecture](../../architecture/ai-facade.md), [Settings system](../../architecture/settings-system.md), the sibling feature specs for `advanced-prompts/`, `ai-conversation/`, `community-pr-processing/`, `scheduled-updates/`, and `data-generator/`, and the Knowledge Base implementation plan in [plan.md](plan.md) + checklist in [tasks.md](tasks.md) + acceptance criteria in [acceptance.md](acceptance.md).

> **Decision log** (resolved 2026-05-21, see §26): platform-managed embedding provider per-org · inheritable classes = `legal` + `style` + `seo` · sidecar `.yml + .md` format · reconcile-and-flag lock enforcement · hybrid heading-aware + fixed-size chunking · fixed palette + auto-derived tag colors · per-format viewer thresholds · single embeddings table with `workId`-prefixed PK · 1 MB body cap · daily sweep with 7-day grace.

---

## 1. Executive summary

Every Work generated and maintained by the Ever Works platform operates against a set of institutional context — brand voice, legal copy, SEO conventions, domain glossary, competitor lists, audience personas, prior research. Today, the only home for this context is the Work's **Advanced Prompts** field: a single text blob. As Works grow, this single-field model breaks down — context becomes lossy, versionless, and impossible to share, structure, or selectively apply.

This spec introduces a **per-Work Knowledge Base** (KB): a first-class, structured, Git-backed corpus of typed knowledge documents that the Work's agents and generation pipelines retrieve from on every run, and that the platform's UI surfaces as an editable workbench. Users upload source material (PDFs, Word docs, spreadsheets, markdown, images, video, URLs); the platform stores originals in the Work's configured Storage plugin and writes a normalized, agent-readable copy of each into the Git data repo at `.content/kb/`. A typed classification (`brand` / `legal` / `seo` / `glossary` / `competitors` / `personas` / `style` / `research` / `output` / `freeform`) gates how each document is used by the agent runtime. A WYSIWYG editor, inline viewers for non-markdown originals, hierarchical folder structure, and an AI side-panel with `@mention`-based retrieval and citations make the KB a primary surface in the Work workbench.

**Strategic intent.** The platform's positioning rests on the _maintain_ half of "research → generate → deploy → maintain". The KB is the substrate that makes "maintain" mean something: it is the institutional context the agent operates from on every scheduled regeneration, every community PR, every comparison, every content refresh. Without it, every run starts from prompt scratch. With it, the runtime accumulates a durable, owned, version-controlled understanding of what each business actually is.

---

## 2. Goals and non-goals

### 2.1 Goals

- **G1.** Give every Work a structured, typed, agent-readable knowledge corpus stored in the Work's Git data repository.
- **G2.** Make ingest of source material a single drag-and-drop action that produces both a stored original (in the Work's Storage plugin) and a normalized agent-readable extract (in Git).
- **G3.** Make the KB the canonical context source consumed by the Work's agents, generators, comparison pipeline, scheduled updates, and community PR flow.
- **G4.** Provide a workbench UI to browse, edit, tag, classify, lock, restore, and search the KB, plus inline viewers for the original uploads in their native formats.
- **G5.** Expose the KB to AI conversation as `@mention`-able context with cited responses.
- **G6.** Let agents write _back_ into the KB — research notes, generated outputs (slides, dashboards, reports) — under the same governance as user-created docs.
- **G7.** Support organization-level inheritance for the classes where it makes sense (`legal`, `style`, `seo`), with Work-level override, reusing the established `PluginSettingsService` 4-level resolution pattern.
- **G8.** Per-document lock semantics (compatible with the existing pattern for scheduled regeneration safety).
- **G9.** Audit trail: every KB mutation flows through `ActivityLog` and Git history.

### 2.2 Non-goals (this phase)

- **N1.** Generic RAG over arbitrary external corpora outside a Work. The KB is scoped to a single Work plus inherited org-level documents — not a tenant-wide search index.
- **N2.** Multi-user real-time co-editing (Operational Transform / CRDT). Soft locks + standard optimistic concurrency only.
- **N3.** Public publishing of KB documents on the Work's deployed site. The KB is platform-internal context; if a user wants a public knowledge page, they place it in `.content/markdown/` or `pages/` as today.
- **N4.** Cross-Work KB sharing in this phase (an org-level "policy" surface for legal text is in scope; arbitrary cross-Work doc sharing is not).
- **N5.** A standalone "knowledge graph" overlay with auto-derived semantic relationships. Wikilinks are explicit; cross-linking is user/agent-driven; semantic auto-link is a v2 candidate.
- **N6.** External KB import from third-party platforms beyond what the existing extractor plugins (`pdf-extractor`, `notion-extractor`, `local-content-extractor`, `scrapfly`) already enable.

### 2.3 Out-of-scope, will-design-later

- Encrypted-at-rest KB content for regulated industries (planned alongside broader platform encryption work).
- Per-paragraph soft locks (current phase is per-document).
- LLM-eval-driven validation of agent KB writes (planned alongside generation-quality eval CI).

---

## 3. Principles

The KB inherits the platform's existing principles. The relevant ones, restated for this feature:

1. **Git-first.** The agent-readable KB layer is _always_ in the Work's Git data repository. Originals may live in any configured Storage plugin; the extracted, normalized KB form is in Git. This guarantees: portable, inspectable, diff-able, versioned, recoverable, and accessible to every downstream pipeline that already reads `.content/`.
2. **Plugin-driven.** Storage of originals uses whatever Storage plugin the Work has configured (`github-storage`, `aws-s3`, `minio`, `local-fs`). Extraction uses the configured Content Extractor plugins (`pdf-extractor`, `local-content-extractor`, `notion-extractor`, `scrapfly`). No new ingest mechanisms.
3. **Two-layer storage.** Originals (binary) and extracted KB (Markdown + sidecar YAML) are conceptually distinct surfaces. They may share a Storage when `github-storage` is selected, but the abstraction is two layers.
4. **Typed classification.** Documents have a `kbDocumentClass` enum that drives how the agent treats them — `legal` is verbatim-or-omitted, `brand` is soft guidance, `glossary` is term-substitution, etc.
5. **Format normalization rules**:
    - `pdf`, `docx`, `pptx`, `odt`, `rtf` → Markdown (text + image references).
    - `xlsx`, `xlsm`, `csv`, `tsv` → Markdown table + preserved raw file.
    - `html`, `htm` → Markdown via configured extractor.
    - Images (`png`, `jpg`, `jpeg`, `webp`, `gif`, `svg`) → kept in original format; image reference inserted into Markdown index.
    - Video (any source format) → normalized to `mp4` (configurable, `mp4` default).
    - Audio (any source format) → normalized to `mp3` (configurable, `mp3` default) + transcript Markdown.
    - URL → Markdown via extractor.
    - Markdown → stored verbatim, frontmatter merged with KB metadata.
6. **Inheritance only where it makes sense.** Brand identity is always per-Work. `legal`, `style`, and `seo` support org-level default + Work-level override. `glossary`, `competitors`, `personas`, `research`, `output`, `freeform` are always per-Work in v1.
7. **Agents are first-class authors.** The KB schema is symmetric — agent-authored documents carry the same shape as user-authored ones, with provenance fields recording which agent run produced them.
8. **Mirror existing conventions.** Entity shapes, migration filenames, API route layout, web route layout, and on-disk YAML/Markdown shape mirror the existing Ever Works codebase — not a parallel universe of its own.

---

## 4. User-facing concepts

### 4.1 The KB document

A **KB document** is the unit of knowledge. One document represents one piece of institutional context. Examples:

- "Our brand voice guidelines, v3" (class: `brand`)
- "GDPR cookie banner copy, EN/DE/FR" (class: `legal`)
- "Target keywords by page type" (class: `seo`)
- "Internal product naming conventions" (class: `glossary`)
- "Competitor list — do-not-mention edition" (class: `competitors`)
- "Buyer persona — 'Skeptical Mid-Market CTO'" (class: `personas`)
- "Q2 2026 market research, source: McKinsey report.pdf" (class: `research`)
- "Generated weekly content review, 2026-05-19" (class: `output`, authored by `content-reviewer-agent`)

Every document has: a Markdown body, a sidecar metadata YAML, a hierarchical path within the KB, a class, multiple tags, multiple categories, a status, and optional links to its original upload and to the agent run that authored it.

### 4.2 The original upload

When a user drops a PDF, Word doc, video, or other source file into the KB, the **original upload** is persisted in the Work's configured Storage plugin. The original is preserved verbatim (with one allowed normalization for video and audio formats — to `mp4` / `mp3` — to keep the platform's media handling consistent).

The original lives separately from the agent-readable KB extract. Both are addressable from the UI ("show me the original" / "show me what the agent reads"). The agent never reads the original directly; it reads the extract.

### 4.3 The KB tree

The KB is **hierarchical**. Documents live at paths like `brand/voice.md`, `legal/privacy.md`, `research/2026-q2/mckinsey-market-sizing.md`. Hierarchy is encoded in the filesystem path; folders are implicit (no separate folder table). The platform seeds a default top-level structure on Work creation (one folder per `kbDocumentClass`); users and agents can create arbitrary subfolders.

A canonical `.index.yml` at the KB root lists every document with its metadata for fast retrieval without walking the tree. The index is auto-maintained on every mutation.

### 4.4 The KB workbench

A dedicated workbench page under the Work's nav (`/works/:id/kb`) provides:

- A two-pane tree: **KB** (left) and **Originals** (right toggle), each independently browsable.
- A center editor pane: Tiptap WYSIWYG when viewing a `.md` document; inline viewer when viewing a non-Markdown original (PDF.js for PDFs, SheetJS-style grid for spreadsheets/CSVs, native `<video>` for normalized MP4, etc.).
- A right side panel for **AI conversation scoped to the KB**, supporting `@mention` of any KB document, returning citation-anchored answers.
- A top bar with search, filter by class/tag/status, "new document", "upload original", and lock/restore controls.

### 4.5 Org-level vs Work-level

By default, all KB documents are **Work-scoped**. Three classes are exceptions and support org-level inheritance: `legal` (master privacy policy, terms, regulated copy), `style` (org-wide editorial style guide, banned words, voice/tense rules), and `seo` (org-wide SEO playbook, structured-data conventions). An organization may publish documents of these classes; all Works in the org inherit them unless the Work overrides with its own document at the same `path`. Resolution follows the existing 4-level pattern used by `PluginSettingsService`: plugin defaults → organization → Work → user (the user level is unused for KB; it remains in the resolution chain for symmetry).

Brand identity, glossary, competitors, personas, research, output, and freeform classes are _not_ inheritable. Each Work owns these. This is a deliberate constraint to prevent cross-Work brand drift and to keep audience/competitive/research material specific to each site.

---

## 5. Architecture overview

```
                  ┌───────────────────────────────────────────────────┐
                  │                    apps/web                       │
                  │   /works/:id/kb   ←  workbench UI (Tiptap, view-   │
                  │                      ers, AI panel, tree, search) │
                  └────────────┬──────────────────────────────────────┘
                               │ REST + SSE
                  ┌────────────▼──────────────────────────────────────┐
                  │                    apps/api                       │
                  │   WorksController                                 │
                  │     /works/:id/kb/...                             │
                  │   ┌─────────────────────────────────────────────┐ │
                  │   │  KnowledgeBaseService (orchestrator)         │ │
                  │   │   - resolveDocuments(workId, filter)         │ │
                  │   │   - createDocument()  / updateDocument()     │ │
                  │   │   - ingestUpload(workId, file)               │ │
                  │   │   - search(workId, query)                    │ │
                  │   └─────────────────────────────────────────────┘ │
                  └────┬───────────────┬──────────────────────┬───────┘
                       │               │                      │
                       │               │                      │
              ┌────────▼─────┐  ┌──────▼─────────┐   ┌────────▼──────────┐
              │ packages/    │  │ Content        │   │ Storage plugins   │
              │ agent /      │  │ Extractor      │   │  (github-storage, │
              │ KnowledgeBase│  │ plugins        │   │   aws-s3, minio,  │
              │ pipeline     │  │  (pdf-ext.,    │   │   local-fs)       │
              │              │  │   local-cnt,   │   │   for ORIGINALS   │
              │              │  │   notion, …)   │   │                   │
              └──────┬───────┘  └─────────────────┘   └───────────────────┘
                     │
                     │  reads + writes via Git
                     │
              ┌──────▼──────────────────────────────────────────────┐
              │             Work's Git data repository              │
              │                                                     │
              │   .content/                                         │
              │     .works/                ← Work configuration     │
              │       works.yml                                     │
              │     data/                  ← directory items, blog  │
              │     pages/                 ← website pages          │
              │     markdown/              ← header/footer blocks   │
              │     blocks/                ← reusable page blocks   │
              │     comparisons/           ← comparison items       │
              │     categories.yml                                  │
              │     collections.yml                                 │
              │     tags.yml                                        │
              │     references.yml                                  │
              │     kb/                    ← NEW: per-Work KB       │
              │       .index.yml                                    │
              │       brand/                                        │
              │       legal/                                        │
              │       seo/                                          │
              │       style/                                        │
              │       glossary/                                     │
              │       competitors/                                  │
              │       personas/                                     │
              │       research/                                     │
              │       outputs/                                      │
              │       freeform/                                     │
              │       .org/               ← inherited overlay       │
              │         legal/                                      │
              │         style/                                      │
              │         seo/                                        │
              └─────────────────────────────────────────────────────┘
```

**Persistence model**. The KB lives in two places simultaneously and these must stay in sync:

1. **Database** (PostgreSQL) — fast queries, indexes, joins, audit. Source of truth for _metadata_ (which docs exist, their tags, classes, statuses, ownership, locks, indexing state).
2. **Git data repository** — source of truth for _content_. The KB markdown + sidecar YAML is committed and pushed; downstream pipelines (generation, deployment, comparisons, scheduled updates) read from Git as today.

The DB row and the Git files are kept in sync by `KnowledgeBaseService` (the orchestrator). DB writes happen first; Git commits second; if the Git commit fails, the DB row is rolled back. Reads can happen from either depending on the call site — UI reads from DB; agent pipelines read from Git (because they already do, and Git is the durable source).

---

## 6. Data model — database

All entities mirror the existing TypeORM conventions: UUID primary keys, `@CreateDateColumn` / `@UpdateDateColumn`, snake_case plural table names, `simple-json` for JSON columns, explicit `@JoinColumn`, `onDelete: 'CASCADE'` on parent relations, file names `kebab-case.entity.ts`, class names `PascalCase`.

### 6.1 `WorkKnowledgeDocument`

File: `packages/agent/src/entities/work-knowledge-document.entity.ts`
Table: `work_knowledge_documents`

| Column                  | Type                     | Notes                                                                                                                                        |
| ----------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | uuid PK                  | `@PrimaryGeneratedColumn('uuid')`                                                                                                            |
| `workId`                | uuid, nullable           | Either `workId` or `organizationId` must be set (CHECK constraint). Work-scoped docs set this.                                               |
| `organizationId`        | uuid, nullable           | Org-scoped docs set this; restricted at validation time to `kbDocumentClass IN ('legal', 'style', 'seo')` in v1.                             |
| `path`                  | varchar(512), indexed    | Forward-slash separated, relative to `.content/kb/`. Example: `brand/voice.md`. Unique within `(workId, path)` and `(organizationId, path)`. |
| `slug`                  | varchar(255), indexed    | Kebab-case, last path segment without extension. Example: `voice`.                                                                           |
| `title`                 | varchar(255)             | Human-readable title.                                                                                                                        |
| `description`           | text, nullable           | One-sentence summary used in tree tooltips and agent listings.                                                                               |
| `kbDocumentClass`       | enum (varchar)           | One of: `brand`, `legal`, `seo`, `glossary`, `competitors`, `personas`, `style`, `research`, `output`, `freeform`.                           |
| `tags`                  | simple-json (string[])   | Array of tag slugs.                                                                                                                          |
| `categories`            | simple-json (string[])   | Array of category slugs. Optional secondary grouping.                                                                                        |
| `status`                | enum (varchar)           | `draft` / `active` / `archived`. Default `active`.                                                                                           |
| `locked`                | boolean                  | Default `false`. When `true`, scheduled regeneration and agent runs may not mutate this doc.                                                 |
| `lockMode`              | enum (varchar), nullable | When `locked=true`: `full` (no changes) or `additions-only`.                                                                                 |
| `language`              | varchar(8)               | BCP-47, default `en`.                                                                                                                        |
| `wordCount`             | int, nullable            | Auto-computed on save.                                                                                                                       |
| `tokenCount`            | int, nullable            | Estimated; auto-computed on save.                                                                                                            |
| `source`                | enum (varchar)           | `user` / `agent` / `imported` / `seeded`.                                                                                                    |
| `sourceUploadId`        | uuid, nullable, FK       | → `work_knowledge_uploads.id`. Set when this doc was derived from an upload.                                                                 |
| `sourceUrl`             | varchar(2048), nullable  | If imported from a URL via an extractor plugin.                                                                                              |
| `generatedByAgentRunId` | uuid, nullable, FK       | → `work_agent_runs.id`. Provenance for `source='agent'`.                                                                                     |
| `createdById`           | uuid, nullable, FK       | → `users.id`. Null for agent-authored.                                                                                                       |
| `updatedById`           | uuid, nullable, FK       | → `users.id`. Null for agent-authored.                                                                                                       |
| `lastIndexedAt`         | timestamptz, nullable    | When the search index last incorporated this doc.                                                                                            |
| `lastCommitSha`         | varchar(40), nullable    | Last Git commit SHA that touched this doc.                                                                                                   |
| `metadata`              | simple-json, nullable    | Free-form extension dict for future fields.                                                                                                  |
| `createdAt`             | timestamptz              | `@CreateDateColumn`                                                                                                                          |
| `updatedAt`             | timestamptz              | `@UpdateDateColumn`                                                                                                                          |

**Relations:**

- `@ManyToOne(() => Work)` on `workId`, `onDelete: 'CASCADE'`.
- `@ManyToOne(() => Organization)` on `organizationId`, `onDelete: 'CASCADE'`.
- `@ManyToOne(() => WorkKnowledgeUpload)` on `sourceUploadId`, `onDelete: 'SET NULL'`.
- `@ManyToOne(() => WorkAgentRun)` on `generatedByAgentRunId`, `onDelete: 'SET NULL'`.

**Indexes:**

- `@Index(['workId', 'kbDocumentClass'])`
- `@Index(['organizationId', 'kbDocumentClass'])`
- `@Index(['workId', 'path'], { unique: true })` — when `workId` is set
- `@Index(['organizationId', 'path'], { unique: true })` — when `organizationId` is set
- `@Index(['workId', 'status'])`
- `@Index(['workId', 'updatedAt'])`

**CHECK constraint** (migration SQL):

```sql
CHECK ((work_id IS NOT NULL AND organization_id IS NULL)
    OR (work_id IS NULL AND organization_id IS NOT NULL))
```

### 6.2 `WorkKnowledgeUpload`

File: `packages/agent/src/entities/work-knowledge-upload.entity.ts`
Table: `work_knowledge_uploads`

Tracks original uploaded source files. Lives in the database for metadata + indexing, while the actual file bytes live in the Storage plugin.

| Column                 | Type                   | Notes                                                                                         |
| ---------------------- | ---------------------- | --------------------------------------------------------------------------------------------- |
| `id`                   | uuid PK                |                                                                                               |
| `workId`               | uuid, FK, NOT NULL     | Uploads are always Work-scoped.                                                               |
| `storageProvider`      | varchar(64)            | Which Storage plugin ID was used. Example: `github-storage`, `aws-s3`, `minio`, `local-fs`.   |
| `storagePath`          | varchar(1024)          | Path within the storage. Example: `kb-originals/research/2026-q2/mckinsey-market-sizing.pdf`. |
| `originalFilename`     | varchar(512)           | Filename as uploaded.                                                                         |
| `mimeType`             | varchar(128)           | Detected content type.                                                                        |
| `fileSize`             | bigint                 | Bytes.                                                                                        |
| `sha256`               | varchar(64), indexed   | Content hash for dedup detection.                                                             |
| `normalizedFormat`     | varchar(64), nullable  | If a media-format normalization happened (e.g. `mp4`), the target format slug.                |
| `extractionStatus`     | enum (varchar)         | `pending` / `running` / `succeeded` / `failed` / `skipped` (e.g. for already-Markdown).       |
| `extractionPluginId`   | varchar(64), nullable  | Which extractor plugin was used.                                                              |
| `extractionError`      | text, nullable         | If `extractionStatus='failed'`.                                                               |
| `extractionStartedAt`  | timestamptz, nullable  |                                                                                               |
| `extractionFinishedAt` | timestamptz, nullable  |                                                                                               |
| `extractedDocumentId`  | uuid, nullable, FK     | → `work_knowledge_documents.id`. The KB doc this upload was extracted into.                   |
| `uploadedById`         | uuid, FK               | → `users.id`. Null for agent-imported.                                                        |
| `tags`                 | simple-json (string[]) | Inherited from the user's upload form; copied to the derived KB document on first extraction. |
| `categories`           | simple-json (string[]) | Same.                                                                                         |
| `metadata`             | simple-json, nullable  | E.g. EXIF for images, duration for video, page count for PDF.                                 |
| `createdAt`            | timestamptz            |                                                                                               |
| `updatedAt`            | timestamptz            |                                                                                               |

**Relations:**

- `@ManyToOne(() => Work)`, `onDelete: 'CASCADE'`.
- `@OneToOne(() => WorkKnowledgeDocument)` on `extractedDocumentId`, `onDelete: 'SET NULL'`.

**Indexes:**

- `@Index(['workId', 'extractionStatus'])`
- `@Index(['workId', 'sha256'])` — fast dedup lookup
- `@Index(['workId', 'createdAt'])`

### 6.3 `WorkKnowledgeTag` (optional v1, recommended)

File: `packages/agent/src/entities/work-knowledge-tag.entity.ts`
Table: `work_knowledge_tags`

A small lookup table for tag normalization + UI autocomplete. Documents store `tags: string[]` (slugs); this table provides the human-readable name, color, and description for each slug.

| Column        | Type                  |
| ------------- | --------------------- |
| `id`          | uuid PK               |
| `workId`      | uuid, FK NOT NULL     |
| `slug`        | varchar(64), indexed  |
| `name`        | varchar(128)          |
| `color`       | varchar(16), nullable |
| `description` | text, nullable        |
| `createdAt`   | timestamptz           |
| `updatedAt`   | timestamptz           |

Unique constraint on `(workId, slug)`.

### 6.4 `WorkKnowledgeCitation`

File: `packages/agent/src/entities/work-knowledge-citation.entity.ts`
Table: `work_knowledge_citations`

Records every time a KB document was used as context in an agent run, scheduled regeneration, AI conversation message, or community PR proposal. Powers the "what context was used" audit trail and the "what referenced this doc" reverse lookup.

| Column           | Type                  | Notes                                                                                       |
| ---------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `id`             | uuid PK               |                                                                                             |
| `workId`         | uuid, FK NOT NULL     |                                                                                             |
| `documentId`     | uuid, FK NOT NULL     | → `work_knowledge_documents.id`                                                             |
| `consumerType`   | enum (varchar)        | `agent-run` / `generation-history` / `conversation-message` / `community-pr` / `comparison` |
| `consumerId`     | uuid                  | Polymorphic FK by `consumerType`.                                                           |
| `chunkRange`     | simple-json, nullable | `{ start, end }` byte/line offsets if a partial section was cited.                          |
| `relevanceScore` | float, nullable       | If a retrieval ranking produced a score.                                                    |
| `createdAt`      | timestamptz           |                                                                                             |

**Indexes:**

- `@Index(['documentId', 'createdAt'])`
- `@Index(['consumerType', 'consumerId'])`
- `@Index(['workId', 'createdAt'])`

This is append-only; we never update or delete citation rows (except cascade on Work delete).

### 6.5 Extension to `Work` entity

Add fields to `Work` to record KB-level metadata:

```ts
@Column({ type: 'simple-json', nullable: true })
kbConfig?: WorkKbConfig | null;
```

where `WorkKbConfig`:

```ts
interface WorkKbConfig {
	enabled: boolean; // default true on new Works
	storagePluginId: string; // resolved from Work.storageProvider if absent
	originalsBasePath?: string; // default 'kb-originals/'
	extractionRules?: Partial<ExtractionRulesConfig>; // per-Work override
	retrievalConfig?: {
		maxContextDocs?: number; // hard cap; default 12
		maxContextTokens?: number; // hard cap; default 8000
		classFilters?: KbDocumentClass[]; // restrict retrieval to these classes
	};
	inheritance?: {
		legal?: 'inherit' | 'override' | 'disabled'; // default 'inherit'
		style?: 'inherit' | 'override' | 'disabled'; // default 'inherit'
		seo?: 'inherit' | 'override' | 'disabled'; // default 'inherit'
	};
}
```

No new column for inheritance separately — folded into `kbConfig` since it's not query-driven.

---

## 7. Data model — Git data repository (on-disk layout)

The KB lives at `.content/kb/` — a top-level folder in the Work's Git data repository, peer to the existing `.works/`, `data/`, `pages/`, `markdown/`, `blocks/`, and `comparisons/` folders. Section §7.1 documents the **full** data-repo structure (the existing top-level folders + the new `kb/`), so this PRD doubles as the canonical reference for how a Work's Git data repository is organized. Sections §7.2–§7.6 then drill into the KB folder specifically.

### 7.1 Data repository structure (full)

Every Work has exactly one **data repository** — a Git repo that is the durable, version-controlled source of truth for that Work's content + configuration. The data repo is typically hosted on GitHub via the `github-storage` plugin (the platform's default), but any Git provider with a matching plugin works the same way. The deployed site (Next.js full template, Astro minimal template, or any other compatible template) reads from this repo.

The canonical layout, after this PRD lands:

```
.content/
  .works/                            ← Work configuration
    works.yml                          (canonical Work config — already shipped)
    …                                  (future Work-config files land here)
  data/                              ← directory items, blog posts (existing)
    {slug}/
      {slug}.yml                       (item sidecar metadata)
      {slug}.md                        (item Markdown body)
  pages/                             ← website pages (existing)
    {page-slug}.md
  markdown/                          ← header/footer/hero blocks (existing)
    hero.en.md
    …
  blocks/                            ← reusable page blocks (existing)
  comparisons/                       ← comparison items (existing)
    {slug-a}--{slug-b}/
      {slug}.yml
      {slug}.md
  categories.yml                     ← category definitions (existing)
  collections.yml                    ← collection metadata (existing)
  tags.yml                           ← tag definitions (existing)
  references.yml                     ← shared citations / sources (existing)
  kb/                                ← per-Work Knowledge Base (NEW — this PRD)
    .index.yml                         (auto-maintained KB index)
    brand/                             (per-Work)
    legal/                             (org-inheritable; overridden per Work)
    seo/                               (org-inheritable; overridden per Work)
    style/                             (org-inheritable; overridden per Work)
    glossary/                          (per-Work)
    competitors/                       (per-Work)
    personas/                          (per-Work)
    research/                          (per-Work; long-form reference material)
    outputs/                           (agent-authored artifacts)
    freeform/                          (catch-all)
    .org/                              (materialized org-level overlay)
      legal/
      style/
      seo/
  kb-originals/                      ← original uploaded source files (NEW — when storage = github-storage)
    {class}/
      {optional-subpath}/
        {filename}                     (raw PDFs, DOCX, video, etc.)
  README.md
  LICENSE.md
```

Two notes:

- **The `kb-originals/` folder only appears in the data repo when the Work's Storage plugin is `github-storage`** (the default for new Works). For Works with non-Git storage (`aws-s3`, `minio`, `local-fs`), originals live in the configured storage backend instead (e.g. `s3://bucket/works/{workId}/kb-originals/…`), and the data repo contains only the agent-readable `kb/` layer. See PRD §8 for the per-storage path conventions.
- **The `kb/.org/` subtree is a read-only materialized overlay** of the org's inheritable documents (`legal` / `style` / `seo`). Authoring of those documents happens at the org level via dedicated API endpoints (§12.6); the platform fans changes out to every Work's `.org/` overlay. Direct edits to `.org/` in a Work's repo are reverted on next reconciliation.

### 7.2 KB folder layout (detail)

```
.content/kb/
  .index.yml                              ← auto-maintained
  brand/
    voice.yml
    voice.md
    visual-identity.yml
    visual-identity.md
    tone-examples.yml
    tone-examples.md
  legal/
    privacy.yml
    privacy.md
    terms.yml
    terms.md
  seo/
    keyword-strategy.yml
    keyword-strategy.md
  glossary/
    terms.yml
    terms.md
  competitors/
    do-not-mention.yml
    do-not-mention.md
    comparison-targets.yml
    comparison-targets.md
  personas/
    primary-buyer.yml
    primary-buyer.md
  style/
    content-style-guide.yml
    content-style-guide.md
  research/
    2026-q2/
      mckinsey-market-sizing.yml
      mckinsey-market-sizing.md
      mckinsey-market-sizing.assets/      ← image extracts go here
        page-3-figure.png
        page-8-table.png
  outputs/
    2026-05-19-weekly-review.yml
    2026-05-19-weekly-review.md
    q2-strategy-deck/                     ← embedded-app output
      deck.yml
      index.html
      assets/
        chart.png
  freeform/
    random-notes.yml
    random-notes.md
  .org/                                   ← read-only materialized overlay
    legal/
      privacy.yml
      privacy.md
    style/
      content-style-guide.yml
      content-style-guide.md
    seo/
      keyword-strategy.yml
      keyword-strategy.md
```

**Rules:**

- Top-level folder names match `kbDocumentClass` values exactly.
- Each document is a _pair_: `<slug>.yml` (sidecar metadata) + `<slug>.md` (Markdown content) — matching the established `data/{slug}/{slug}.yml + {slug}.md` pattern for items.
- A document slug may be nested under further folders for organization, e.g. `research/2026-q2/mckinsey-market-sizing.{yml,md}`.
- Image / asset extracts from a document go in a sibling `<slug>.assets/` folder.
- Embedded-app outputs (HTML dashboards, generated decks) are folders containing the assets plus a single `<slug>.yml` sidecar at the folder level.
- `.index.yml` at the root of `kb/` is auto-maintained — never hand-edited.

### 7.3 Sidecar `.yml` schema

```yaml
# .content/kb/brand/voice.yml
id: 0193e6b8-1a2b-7a0c-9c4f-1d2e3f4a5b6c # uuid, mirrors DB id
slug: voice
title: Brand voice guidelines
description: Tone, register, banned phrases, sentence rhythm.
class: brand
status: active
language: en
tags:
    - brand
    - voice
    - tone
categories:
    - marketing
locked: false
lock_mode: null
source: user
source_upload_id: null
source_url: null
generated_by_agent_run_id: null
created_at: 2026-05-21T14:32:00Z
updated_at: 2026-05-21T14:32:00Z
created_by: ever@ever.co
updated_by: ever@ever.co
word_count: 1842
token_count: 2461
checksum: sha256:9f3c…
metadata: {}
```

Field naming uses `snake_case` to match `works.yml` and the existing item YAML convention. The DB row uses camelCase as is TypeORM convention; the sidecar uses snake_case as is YAML convention; the API converts between them at boundaries.

### 7.4 Markdown body

Plain CommonMark with GFM extensions. Wikilinks `[[Other Doc Title]]` and `@mention`s of agents / skills / KB docs are platform-recognized syntax that is rendered specially in the workbench but stored verbatim in Git so the repo is a portable artifact.

Internal cross-references use **relative paths** in regular Markdown links where possible (`[See keyword strategy](../seo/keyword-strategy.md)`). Wikilink shorthand is sugar; the platform resolves `[[Keyword strategy]]` against the KB index to a relative path on render and rewrites on rename.

### 7.5 The `.index.yml`

Auto-maintained file at `.content/kb/.index.yml`. Holds a flat list of every KB document for fast retrieval by agents and the workbench (avoids walking the tree on every request).

```yaml
generated_at: 2026-05-21T14:35:12Z
generator: ever-works-platform/kb-indexer
version: 1
documents:
    - id: 0193e6b8-…
      path: brand/voice.md
      title: Brand voice guidelines
      class: brand
      tags: [brand, voice, tone]
      status: active
      locked: false
      word_count: 1842
      checksum: sha256:9f3c…
      updated_at: 2026-05-21T14:32:00Z
    - id: 0193e6b9-…
      path: legal/privacy.md
      title: Privacy policy
      class: legal
      tags: [legal, privacy, gdpr]
      status: active
      locked: true
      lock_mode: full
      word_count: 4012
      checksum: sha256:7c4a…
      updated_at: 2026-05-19T09:11:00Z
    - …
```

This file is regenerated on every KB mutation by `KnowledgeBaseService.rebuildIndex(workId)` and committed in the same Git commit as the mutation.

### 7.6 Org-level overlay

Org-level documents (classes `legal`, `style`, `seo`) live in the Workspace's platform DB but are _materialized_ into each Work's Git repo at extraction-time as **read-only references** under `.content/kb/.org/{class}/...` so the agent reading from Git can see them. The Work's own `{class}/` overrides any same-`path` entry under `.org/{class}/`. Resolution is done by `KnowledgeBaseService.resolveInheritableDocuments(workId, classes?)` at read time.

The `.org/` subtree is regenerated whenever the org's inheritable docs change; the regeneration is fanned out to every Work in the org that has the corresponding `Work.kbConfig.inheritance.<class>` set to `inherit` (the default).

---

## 8. Storage of originals

### 8.1 Selection of storage

Each Work has a `storageProvider` field on its entity (already present). The KB respects this — original uploads go to whichever Storage plugin is configured. New Works default to the same storage as their data repo (typically `github-storage`).

### 8.2 Path conventions

Original uploads are namespaced by Work:

- `github-storage` (Git-based): `kb-originals/{class}/{optional-subpath}/{filename}` _inside the Work's Git data repo_. Commit messages: `[kb] upload: {class}/{filename}`.
- `aws-s3` / `minio`: `works/{workId}/kb-originals/{class}/{optional-subpath}/{filename}` _within the configured bucket_.
- `local-fs`: `{root}/works/{workId}/kb-originals/{class}/{optional-subpath}/{filename}` _within the configured root_.

Path templates are configurable per-Work via `Work.kbConfig.originalsBasePath` if a customer needs a different layout.

### 8.3 De-duplication

Uploads compute a SHA-256 on receipt. If a row already exists for the same `(workId, sha256)`, the platform reuses the existing `WorkKnowledgeUpload` row, logs a deduplication event in `ActivityLog`, and does not re-upload the file. The new "logical upload" event still creates a `WorkKnowledgeDocument` if requested (so the same source can be classified differently in two contexts — e.g. once as `research`, once as `competitors`).

### 8.4 Storage plugin contract additions

The existing storage plugin abstraction must support the following operations against the KB-originals namespace. Most are already present in existing storage plugins; this section is a contract declaration, not a change:

- `put(path, stream | buffer, mime, metadata?): Promise<{ checksum, size }>`
- `get(path): Promise<ReadableStream>`
- `head(path): Promise<{ mime, size, lastModified, checksum }>`
- `delete(path): Promise<void>`
- `list(prefix, opts?): AsyncIterable<StorageEntry>`
- `signUrl(path, op: 'get' | 'put', ttlSeconds): Promise<string>` — for direct browser uploads / downloads where the plugin supports it.

If any operation is unsupported by a given storage plugin, the platform falls back to a server-proxied path (the file streams through `apps/api` rather than via a signed URL).

---

## 9. Ingest pipeline

The full lifecycle of a single upload, end to end.

### 9.1 Phase 1 — receive

1. User drops a file in the workbench, or hits `POST /api/works/:id/kb/uploads` via API/CLI/MCP.
2. `apps/api` accepts a multipart upload (or signed-URL direct-to-storage if the storage plugin supports it). Max default 200MB per file; configurable per-tenant.
3. The MIME type is detected (file extension + magic-byte sniff).
4. SHA-256 is computed; dedup check against `WorkKnowledgeUpload` for `(workId, sha256)`.
5. If new, the file is written to the configured Storage plugin at the path described in §8.2.
6. A `WorkKnowledgeUpload` row is created with `extractionStatus='pending'`.
7. The platform commits the original to Git (if storage is `github-storage`) or simply records the storage URL (other plugins).
8. `ActivityLog` row written: `kind=kb.upload.created`.

### 9.2 Phase 2 — normalize

For media types that the platform standardizes:

- Video → MP4 via ffmpeg (if not already MP4). The original is replaced with the MP4 in storage; SHA-256 is recomputed and stored. Original-format hash is preserved in `metadata.originalSha256` for traceability.
- Audio → MP3 via ffmpeg.

For everything else, no normalization at this phase.

Normalization happens asynchronously in a Trigger.dev background job (`packages/tasks/`). The `WorkKnowledgeUpload.extractionStatus` stays `pending` through normalization.

### 9.3 Phase 3 — extract

A second Trigger.dev job picks up the normalized upload and runs the configured Content Extractor plugin:

- PDFs → `pdf-extractor`
- DOCX / RTF / ODT / PPTX → `local-content-extractor` (or a tenant-configured extractor)
- XLSX / XLSM / CSV / TSV → `local-content-extractor` produces a Markdown table representation; the raw file is also linked from the extract
- Markdown → no extraction; copied through with frontmatter merged
- HTML → `local-content-extractor`
- URL → `scrapfly` or `firecrawl` (whichever is configured)
- Notion pages → `notion-extractor`
- Images → no text extraction by default; OCR is opt-in per upload (`extract_text: true`)
- Video → audio extracted, transcribed via configured AI provider's speech-to-text capability (if available); transcript becomes the KB Markdown body. Frames may be sampled for keyframe images.
- Audio → transcribed; transcript becomes the body.

Extractors return `ContentExtractionResult` (existing contract): `markdown`, optional `html`, optional structured `images` and `links`, optional `metadata`. The platform writes the `markdown` field to the new KB document body.

### 9.4 Phase 4 — materialize KB document

1. A `WorkKnowledgeDocument` row is created. Defaults:
    - `kbDocumentClass`: from the user's upload form, or auto-classified using the configured AI provider with a class-classifier prompt (cheap LLM call) if the user didn't specify.
    - `path`: derived as `{class}/{slugified-filename}.md`. Collision: append `-2`, `-3`, etc. (or insert under a subfolder).
    - `tags` and `categories`: from the upload form, plus AI-suggested tags from the extractor's metadata if the user opted in.
    - `title`: from extractor's metadata title, falling back to humanized filename.
    - `source='imported'`, `sourceUploadId=<upload row id>`.
2. The Markdown body and sidecar YAML are written to the Git data repo at `.content/kb/<class>/<slug>.md` and `<slug>.yml`.
3. Image extracts are written under `<slug>.assets/`.
4. `.index.yml` is regenerated.
5. A single Git commit captures the document + assets + index update. Commit message: `[kb] add {class}/{slug} ({source-filename})`.
6. The upload row is updated: `extractionStatus='succeeded'`, `extractedDocumentId=<doc row id>`.
7. `ActivityLog` row: `kind=kb.document.created`, `kbSource=imported`.

### 9.5 Phase 5 — index

The full-text search index is updated. (See §13 for retrieval architecture.)

### 9.6 Failure handling

- If extraction fails, `extractionStatus='failed'`, `extractionError` populated, and the upload remains in the system. The user can retry from the workbench (`POST /api/works/:id/kb/uploads/:uploadId/retry-extraction`). The original file stays in storage.
- If commit-to-Git fails after a successful DB write, the DB write is rolled back and the user sees a 503 with retry guidance. Storage write is not rolled back — orphaned files in storage are cleaned up by a **daily sweeper job with a 7-day grace period**: the sweeper detects storage objects without a matching DB row, tombstones them with a `pending_delete` marker, and physically removes them only after 7 days have elapsed since tombstoning. A subsequent re-import of the same file within the grace period revives the row and clears the tombstone.
- If multiple concurrent uploads race on the same path slug, the second one's `path` is suffixed with `-2`.

### 9.7 Drag-and-drop UX

- The user drops a file or set of files onto the workbench.
- A modal asks: target class (pre-filled if dropped into a class folder), tags (autocomplete from `WorkKnowledgeTag`), description (optional), "should the AI classify and tag this for me?" (default off, opt-in).
- Submit kicks off Phase 1; the upload appears in the tree immediately with a `pending` state spinner, transitioning through `normalizing → extracting → indexing → ready`.

---

## 10. Classification and inheritance

### 10.1 `kbDocumentClass` enum semantics

Each class has documented agent-runtime semantics. This drives how the agent retrieval and generation pipelines treat each document.

| Class         | Agent-runtime semantics                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brand`       | Soft guidance. Injected into system prompts as "follow these brand guidelines:". Per-Work only.                                                                                  |
| `legal`       | Verbatim-or-omitted. The agent is instructed to copy text exactly from `legal` docs into legal sections, never to paraphrase. Supports org-level inheritance with Work override. |
| `seo`         | Constraints — "target these keywords for this page type", "use these structured-data patterns". Per-Work.                                                                        |
| `glossary`    | Term substitution. Agent is told "always use these terms with these meanings; never invent synonyms". Per-Work.                                                                  |
| `competitors` | Inclusion / exclusion list. Drives the comparison-generator pipeline and the do-not-mention rule. Per-Work.                                                                      |
| `personas`    | Audience definitions. Agent is told to write for these personas. Per-Work.                                                                                                       |
| `style`       | Editorial style guide (grammar rules, banned words, voice, tense). Per-Work.                                                                                                     |
| `research`    | Reference material. Retrieved opportunistically; agent cites it when used. Per-Work.                                                                                             |
| `output`      | Agent-authored outputs (reports, summaries, decks). Not re-injected as context unless explicitly mentioned. Per-Work.                                                            |
| `freeform`    | User notes. Retrieved by similarity / explicit mention only. Per-Work.                                                                                                           |

### 10.2 Org-level inheritance for `legal`, `style`, `seo`

- An `Organization` may publish 0+ `WorkKnowledgeDocument` rows with `organizationId=<org>` and `workId=NULL`, restricted to `kbDocumentClass IN ('legal', 'style', 'seo')`.
- Resolution for a Work: `KnowledgeBaseService.resolveInheritableDocuments(workId, classes?)` returns the union of (org docs ∪ Work docs) for each inheritable class, with Work docs overriding org docs for the same `path`.
- Configurable per-Work via `Work.kbConfig.inheritance`:

    ```ts
    inheritance?: {
      legal?: 'inherit' | 'override' | 'disabled';  // default 'inherit'
      style?: 'inherit' | 'override' | 'disabled';  // default 'inherit'
      seo?:   'inherit' | 'override' | 'disabled';  // default 'inherit'
    };
    ```

    - `inherit` (default): merge org + Work, Work overrides.
    - `override`: Work docs only, org docs ignored.
    - `disabled`: no docs of this class participate in agent context for this Work.

### 10.3 Per-Work override semantics

When an org publishes `style/banned-words.md` and a Work also has `style/banned-words.md`, the Work's version wins. When the org has it but the Work doesn't, the org's version is the effective one. The materialized `.org/{class}/...` view in the Work's Git data repo (see §7.6) makes this visible to pipelines that read directly from Git, one subtree per inheritable class: `.org/legal/`, `.org/style/`, `.org/seo/`.

---

## 11. Tag and category system

### 11.1 Tags

- Tags are free-form, multi-valued strings stored as `tags: string[]` on each document.
- A `WorkKnowledgeTag` table provides normalization: a tag slug maps to a name + optional color + description.
- The workbench autocompletes from existing tags but allows new ones to be created in-line (insertion into the table is implicit on first use).
- Tags are per-Work. No org-level tag taxonomy in v1.

**Tag colors.** Tag colors are constrained to a **fixed palette** of ~16 design tokens drawn from the platform's design system (e.g. `slate`, `red`, `orange`, `amber`, `yellow`, `lime`, `green`, `emerald`, `teal`, `cyan`, `sky`, `blue`, `indigo`, `violet`, `purple`, `fuchsia`, `pink`, `rose`). The `WorkKnowledgeTag.color` column stores the token name (varchar), not a hex value, so dark/light mode rendering is automatic and contrast is guaranteed by the design system.

If the user does not explicitly pick a color for a tag, the platform **auto-derives** one deterministically by hashing the tag `slug` into the palette. The same slug always maps to the same color across Works; the user can override at any time. Tags created via API or CLI without a color follow the same auto-derive rule.

### 11.2 Categories

- Categories are an optional secondary grouping. Stored as `categories: string[]`.
- We do _not_ introduce a `WorkKnowledgeCategory` table — categories reuse the existing Work-level category catalog if the Work has one (the same `categories.yml` used by items), or are free-form strings if the Work doesn't.
- Categories overlap with `kbDocumentClass` in spirit but are user-defined and freeform; `kbDocumentClass` is the platform-defined enum that drives agent semantics. Both coexist.

### 11.3 Search / filter

The workbench filter bar exposes: class (multi), tags (multi-AND), categories (multi-AND), status (multi), locked, language, source. The combined filter URL-encodes into the workbench page state so any view is shareable.

---

## 12. API surface

All KB endpoints live under `WorksController`, mirroring the established convention of flat per-Work nesting. Routes use the existing auth + permission guards (`@ApiBearerAuth`, scope check against `WorkMember`).

### 12.1 Documents

```
GET    /api/works/:id/kb/documents
       ?class=brand&tag=voice&status=active&q=…&limit=50&cursor=…
       → 200 { items: KbDocumentDto[], nextCursor, total }

POST   /api/works/:id/kb/documents
       body: { path, title, class, body, tags?, categories?, description? }
       → 201 KbDocumentDto

GET    /api/works/:id/kb/documents/:docId
       → 200 KbDocumentDto

PATCH  /api/works/:id/kb/documents/:docId
       body: partial KbDocumentDto
       → 200 KbDocumentDto

DELETE /api/works/:id/kb/documents/:docId
       → 204

POST   /api/works/:id/kb/documents/:docId/restore
       body: { commitSha }
       → 200 KbDocumentDto

POST   /api/works/:id/kb/documents/:docId/lock
       body: { mode: 'full' | 'additions-only' }
       → 200 KbDocumentDto

POST   /api/works/:id/kb/documents/:docId/unlock
       → 200 KbDocumentDto

GET    /api/works/:id/kb/documents/:docId/history
       → 200 { commits: GitCommitDto[] }

GET    /api/works/:id/kb/documents/:docId/citations
       → 200 { items: CitationDto[] }
```

### 12.2 Uploads

```
POST   /api/works/:id/kb/uploads
       multipart: file + { class, tags?, categories?, description?, autoClassify? }
       → 202 UploadDto (extractionStatus: 'pending')

GET    /api/works/:id/kb/uploads
       ?status=…&class=…&limit=…&cursor=…
       → 200 { items: UploadDto[], nextCursor, total }

GET    /api/works/:id/kb/uploads/:uploadId
       → 200 UploadDto

POST   /api/works/:id/kb/uploads/:uploadId/retry-extraction
       → 202 UploadDto

DELETE /api/works/:id/kb/uploads/:uploadId
       ?deleteExtractedDocument=true|false
       → 204

GET    /api/works/:id/kb/uploads/:uploadId/raw
       → 302 redirect to signed storage URL (where supported) or 200 stream
```

### 12.3 Tree, search, index

```
GET    /api/works/:id/kb/tree
       → 200 KbTreeNode[] (folders + documents, hierarchical)

GET    /api/works/:id/kb/search
       ?q=…&class=…&tag=…&limit=20
       → 200 { hits: KbSearchHit[] (with snippets + scores) }

POST   /api/works/:id/kb/reindex
       → 202 (admin only — forces a full reindex)
```

### 12.4 Tags

```
GET    /api/works/:id/kb/tags
       → 200 { items: KbTagDto[] }

POST   /api/works/:id/kb/tags
       body: { slug, name, color?, description? }
       → 201 KbTagDto

PATCH  /api/works/:id/kb/tags/:tagId
       → 200 KbTagDto

DELETE /api/works/:id/kb/tags/:tagId
       → 204
```

### 12.5 AI conversation against the KB

The existing AI conversation endpoints already exist (`POST /api/ai-conversation/messages`). The KB adds two affordances on top:

- A request param `kbScope: { workId: <uuid> }` causes the conversation to retrieve from this Work's KB.
- `@mention` tokens in the message body — `@kb:brand/voice` or `@kb:0193e6b8-…` — pin specific KB documents into the conversation context, in addition to whatever the retrieval layer picks.
- Response messages may include a `citations` field listing the KB documents (by ID + path + chunk range) used to generate that response.

### 12.6 Org-level inheritable-document endpoints

Scoped to org-admin role. Single endpoint family for all inheritable classes (`legal`, `style`, `seo`); the `class` is part of the request body or path.

```
GET    /api/organizations/:orgId/kb/documents?class=legal|style|seo
POST   /api/organizations/:orgId/kb/documents
       body: { class, path, title, body, tags?, description? }
PATCH  /api/organizations/:orgId/kb/documents/:docId
DELETE /api/organizations/:orgId/kb/documents/:docId
```

The API rejects POST/PATCH with `class` outside the inheritable set with 400 + a descriptive error.

When any org-level inheritable document changes, a Trigger.dev job fans out the change to every Work in the org where `kbConfig.inheritance.<class> != 'disabled'`, materializing the change into each Work's `.org/<class>/` overlay (§7.6).

### 12.7 MCP exposure

`apps/mcp` exposes a `kb` namespace of MCP tools so external Claude / GPT / Gemini sessions can read and write the KB of a Work the calling API key has access to:

- `kb.list(workId, filter?)` → documents
- `kb.read(workId, docId | path)` → document body + metadata
- `kb.search(workId, query, filter?)` → ranked snippets with citations
- `kb.create(workId, doc)` → returns the new document
- `kb.update(workId, docId, patch)` → returns updated document
- `kb.upload(workId, file, metadata)` → returns upload + (eventually) extracted document

These map directly onto the REST endpoints above.

### 12.8 CLI exposure

`apps/cli` gets a `kb` subcommand group:

```
ever works kb list <work-id> [--class] [--tag] [--status]
ever works kb show <work-id> <doc-path-or-id>
ever works kb upload <work-id> <file> [--class] [--tags] [--auto-classify]
ever works kb edit <work-id> <doc-path-or-id> [--editor $EDITOR]
ever works kb search <work-id> <query>
ever works kb sync <work-id> --pull   # pull KB from Git into a local working copy
ever works kb sync <work-id> --push   # commit local working copy back to Git
```

---

## 13. Retrieval architecture

Two complementary retrieval paths.

### 13.1 Deterministic injection (default for typed classes)

For each agent run / generation, the platform injects all documents of certain classes into the system prompt, regardless of query:

- All `brand` documents (always).
- All `legal` documents (always, including inherited).
- All `glossary` documents (always).
- All `seo` documents matching the current page type.
- All `style` documents (always).
- All `personas` documents (always).

The combined budget is capped by `Work.kbConfig.retrievalConfig.maxContextTokens` (default 8000). If exceeded, the platform truncates by class precedence (legal → glossary → brand → style → seo → personas) and emits a `kb.context.truncated` event.

### 13.2 Query-driven retrieval (for `research`, `freeform`, `output`)

For these classes, retrieval is similarity-based:

- The platform computes embeddings for each KB document (chunked at ~512 tokens with 64-token overlap).
- Embeddings live in a Postgres `pgvector` column on a `WorkKnowledgeChunk` table — _not_ specced in detail here; see §15.
- On retrieval, the query (the user message, the agent task, the page being generated) is embedded; top-K chunks (default 6) are pulled and added to context, with their parent document recorded in `WorkKnowledgeCitation`.

### 13.3 `@mention`-pinned context

Explicit `@kb:<path-or-id>` mentions in a conversation message pin those documents in full into the conversation context, bypassing the budget. Multiple mentions are stacked; the budget cap still applies in aggregate.

### 13.4 Citation rendering

When the agent responds, the response text is parsed for citation markers (the system prompt instructs the agent to cite using a format like `〔doc:brand/voice〕` or chunk-anchored `〔doc:research/2026-q2/mckinsey-market-sizing#chunk-3〕`). The platform parses these markers, resolves them to `WorkKnowledgeCitation` rows, and the UI renders them as hover-cards / clickable refs that jump to the cited document.

---

## 14. Workbench UI specification

### 14.1 Page location

- Route: `/works/:id/kb` and nested `/works/:id/kb/:slugOrPath...`
- File: `apps/web/app/[locale]/(dashboard)/works/[id]/kb/page.tsx`
- Nested editor file: `apps/web/app/[locale]/(dashboard)/works/[id]/kb/[...path]/page.tsx`

### 14.2 Layout

A three-pane layout:

```
┌────────────┬──────────────────────────────────┬──────────────────┐
│  TREE      │            CENTER PANE            │     AI PANEL     │
│            │                                    │                  │
│ ┌────────┐ │  ┌──────────────────────────────┐ │  ┌────────────┐  │
│ │ Tabs:  │ │  │ Doc title + class chip       │ │  │ Conversation│  │
│ │ KB |   │ │  │ Tags • locked • saved-state  │ │  │ thread      │  │
│ │ Origin.│ │  └──────────────────────────────┘ │  │             │  │
│ └────────┘ │                                    │  │ [@mentions  │  │
│            │  ┌──────────────────────────────┐ │  │  with auto- │  │
│ Folder     │  │                              │ │  │  complete]  │  │
│ tree       │  │      Tiptap WYSIWYG editor   │ │  │             │  │
│            │  │      OR inline viewer        │ │  │ Citations   │  │
│ (drag-     │  │      (PDF, CSV, video, …)    │ │  │ rendered    │  │
│  drop      │  │                              │ │  │ inline      │  │
│  to upload │  │                              │ │  └────────────┘  │
│  here)     │  └──────────────────────────────┘ │                  │
│            │                                    │  [input]         │
└────────────┴──────────────────────────────────┴──────────────────┘
```

The three panes are individually collapsible. State (which pane open, which folder expanded, last document viewed) persists in the user's per-Work preferences.

### 14.3 Tree pane

- **Tab toggle**: `KB` (the agent-readable extracts) vs `Originals` (the source uploads).
- **KB tab**: a folder tree mirroring `.content/kb/`. Each leaf is a document. Right-click for context menu (rename, duplicate, lock, archive, delete, copy path, copy wikilink). Drag to reorder; drag to move between folders.
- **Originals tab**: a folder tree mirroring the storage layout under `kb-originals/`. Right-click shows: open original, "show extracted KB doc" (jump to the linked `WorkKnowledgeDocument`), re-run extraction, delete.
- Top of pane: search box (Cmd+K), filter chips, "New document", "Upload original".

### 14.4 Center pane — editor

- For `.md` documents: **Tiptap WYSIWYG editor** with:
    - Bold, italic, link, blockquote, code (inline + block), heading levels, lists (bullet, numbered, task), tables, horizontal rule, image, embedded video.
    - Markdown round-trip: on save, the editor's ProseMirror state serializes through `turndown` to Markdown, then YAML frontmatter is _not_ embedded (we use sidecar `.yml` instead), so the body file is pure Markdown.
    - Wikilink autocomplete: typing `[[` opens a picker against KB document titles.
    - `@mention` autocomplete: typing `@` opens a picker with two tabs — KB documents and agents/skills.
    - Slash commands for inserting tables, code blocks, images.
    - Auto-save debounced at 800ms; "saving / saved" indicator.
    - Side panel for metadata: class chip, tags editor (multi-select + create-on-the-fly), description, status, lock controls, language, source, "view in Git history".

### 14.5 Center pane — viewers (non-Markdown)

When the user opens an original (or a non-Markdown KB asset), the center pane dispatches to the matching viewer:

- **PDF** → PDF.js-based viewer with pagination, zoom, search, "extract this page into KB" action.
- **DOCX** → in-browser DOCX renderer (read-only).
- **XLSX / XLSM / CSV / TSV** → spreadsheet grid view (read-only; editing of CSV opens a dedicated editor route).
- **PPTX** → slide preview viewer.
- **Image** → image viewer with zoom and metadata sidebar.
- **Video** → native `<video>` with playback controls; if a transcript exists in the linked KB doc, it's shown alongside.
- **Audio** → audio player + transcript.
- **HTML / embedded app** → sandboxed iframe with controls.

All viewers carry a top-bar action: "Open extracted KB doc →" linking to the corresponding `WorkKnowledgeDocument`.

**Per-format size thresholds.** In-browser rendering is capped per format based on the underlying renderer's real capabilities. Above the cap, the viewer falls back to a download button with an explanation banner ("this file is too large to preview in-browser; download to view"):

| Format        | In-browser cap      |
| ------------- | ------------------- |
| PDF           | 50 MB               |
| XLSX / XLSM   | 15 MB               |
| DOCX / PPTX   | 10 MB               |
| CSV / TSV     | 25 MB               |
| Image         | 50 MB               |
| Video / audio | uncapped (streamed) |

Thresholds are configurable per-tenant via subscription plan settings.

### 14.6 AI panel

- Scoped to the current Work's KB by default.
- Chat thread persists per-Work (separate conversation per Work).
- `@kb:...` autocomplete: typing `@kb:` opens a picker of all documents (filter by class).
- `@agent:...` autocomplete: configured agents on the Work.
- Each assistant message renders inline citations linking to the relevant KB documents; clicking a citation opens the doc in the center pane.
- "Promote to KB" affordance: any assistant message can be one-click promoted into a new `output`-class KB document, with provenance tracked.

### 14.7 Empty state and onboarding

When a Work has no KB documents:

- The workbench shows a guided empty state with class cards: "Define your brand voice", "Upload your legal text", "Tell us about your buyers", etc.
- Each card has a "Create document" button that pre-fills `kbDocumentClass` and a class-specific template.
- A "Quick import" action accepts a URL or upload that auto-classifies into the right class.

### 14.8 Mobile / responsive

- ≤768px: tree becomes a drawer (slide-in from left), AI panel becomes a full-screen overlay, center pane is full width.
- Editor remains usable on mobile; viewers fall back to download-link when in-browser rendering is impractical.

---

## 15. Search and indexing

Two-tier index:

### 15.1 Lexical (BM25 / Postgres FTS)

A Postgres `tsvector` column on `WorkKnowledgeDocument` (computed from `title` + `description` + `body`) backs fast lexical search. Maintained via a generated column.

### 15.2 Semantic (pgvector)

A new table `WorkKnowledgeChunk` (file: `work-knowledge-chunk.entity.ts`, table: `work_knowledge_chunks`):

| Column       | Type                    | Notes                                                                                                                         |
| ------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`         | uuid                    | Composite PK part.                                                                                                            |
| `workId`     | uuid, FK NOT NULL       | Composite PK part — `workId` is leftmost in the PK to enable Postgres declarative partitioning later without a table rewrite. |
| `documentId` | uuid, FK NOT NULL       |                                                                                                                               |
| `chunkIndex` | int                     |                                                                                                                               |
| `content`    | text                    |                                                                                                                               |
| `embedding`  | vector(1536) (pgvector) | Dimension depends on chosen embedding model.                                                                                  |
| `tokenCount` | int                     |                                                                                                                               |
| `metadata`   | simple-json             | Chunk boundaries (headingPath, charRange) for citation.                                                                       |
| `createdAt`  | timestamptz             |                                                                                                                               |

Primary key: `PRIMARY KEY (workId, id)`. This is deliberate: it puts `workId` first so that a future migration to `PARTITION BY HASH (workId)` does not require rewriting the table. Single-table-with-strict-filter is the v1 deployment shape; partitioning is the planned scale-up path once retrieval latency or recall degrades.

Indexes:

- `@Index(['workId', 'documentId'])` — fast doc-level lookup for delete cascade.
- `@Index(['workId', 'embedding'], { type: 'ivfflat' })` — ANN index with `workId` as a filter column. Every retrieval query must include `WHERE workId = $1` (enforced by the service layer).

**Chunking strategy: hybrid heading-aware + fixed-size fallback.** The chunker first splits the Markdown body on H2/H3 boundaries, preserving section integrity. If any resulting section exceeds the target chunk size (~512 tokens), it's further sub-chunked using a fixed-size sliding window with 64-token overlap. Sections shorter than the target stay as single chunks (no padding). Documents with no H2/H3 headings degrade to pure fixed-size chunking. The headingPath ("Brand voice > Examples > Email") is recorded in `metadata` so citations can render the exact location.

**Embedding provider.** Embedding generation uses a **platform-managed embedding lane** distinct from the Work's generation AI provider. Default model: `text-embedding-3-small` (1536-dim, well-supported by pgvector ivfflat). The embedding provider is configurable per-organization via plugin settings — orgs may bring their own provider (any AI provider plugin that implements the optional `embed(input)` capability — see §16.3). Embedding cost flows through `UsageLedgerEntry` as a **separate line item** (`category='kb-embedding'`), so it doesn't drain the Work's generation budget. The platform may absorb embedding cost as part of a subscription tier or pass it through, depending on the plan.

If no embedding provider is available (org has explicitly disabled embeddings, or all configured providers fail), semantic retrieval is gracefully disabled and the KB falls back to lexical-only retrieval.

### 15.3 Search-result presentation

`/api/works/:id/kb/search` blends lexical + semantic results (Reciprocal Rank Fusion). Each hit returns: `documentId`, `path`, `title`, `class`, `snippet` (with query terms highlighted), `score`, `chunkRange` if from a chunk match.

### 15.4 Indexing pipeline

- Indexing is asynchronous, triggered by `WorkKnowledgeDocument` insert / update events.
- Trigger.dev job: re-chunk, re-embed, upsert chunks.
- `lastIndexedAt` on the document row tracks freshness.

---

## 16. Plugin integration

### 16.1 Storage plugins

No new plugins. The KB exercises existing storage plugins through their existing contracts (§8.4 lists the operations relied upon). The newly-added `aws-s3` and `minio` plugins (marked WIP in the platform survey) become first-class consumers of the KB upload path and complete in this milestone.

### 16.2 Content extractor plugins

No new plugins. The KB uses `pdf-extractor`, `local-content-extractor`, `notion-extractor`, `scrapfly` as already shipped. The KB does add one capability requirement:

- The extractor result's `metadata.suggestedTags` and `metadata.suggestedTitle` fields (optional) are read if present; this surface is forward-compatible — existing extractors that don't emit these still work.

### 16.3 AI provider plugins

For embedding generation, the AI provider plugin contract gains an optional `embed(input: string | string[]): Promise<number[][]>` capability. Providers that don't implement it skip embedding-based retrieval; the KB falls back to lexical-only retrieval.

For transcription (video/audio), an optional `transcribe(file: ReadableStream, opts): Promise<TranscriptionResult>` capability is added. Same fallback rule.

### 16.4 Git provider plugins

No changes needed. The KB exercises the existing `github` plugin's commit / push capabilities. The Work data repository is the same one already used for `.content/`.

---

## 17. Agent runtime integration

### 17.1 Generation pipelines

Every generation pipeline (`standard-pipeline`, `agent-pipeline`, `claude-code`, etc.) receives a `kbContext: KbContextBundle` parameter resolved by `KnowledgeBaseService.resolveContext(workId, opts)`. The bundle contains:

```ts
interface KbContextBundle {
	alwaysInjected: {
		brand: KbDocumentSummary[];
		legal: KbDocumentSummary[]; // org + work merged
		glossary: KbDocumentSummary[];
		style: KbDocumentSummary[];
		personas: KbDocumentSummary[];
		seo: KbDocumentSummary[];
	};
	queryRetrieved: KbChunkSummary[]; // optional, depends on call site
	budget: { totalTokens: number; remaining: number };
}
```

Pipelines are responsible for formatting these into their system prompts. A shared `KbPromptFormatter` utility under `packages/agent/src/services/kb-prompt-formatter.ts` standardizes the formatting so every pipeline produces consistent context blocks.

### 17.2 Agent tool: KB read/write

For agent-pipelines that use tool calling, the platform exposes these built-in tools (alongside their existing tool set):

- `kb_search(query, filter?)` — returns top-K chunks
- `kb_read(path | id)` — returns full document
- `kb_write(path, body, class, tags?)` — creates / updates a document (gated by per-tool consent — see FEATURES.md T1.4, if shipped, or default to "ask")
- `kb_lock(path | id, mode)` / `kb_unlock(path | id)`

Each tool invocation records to `WorkAgentRunLog` and (for retrieval tools) writes `WorkKnowledgeCitation` rows.

### 17.3 Lock semantics during scheduled regeneration

Scheduled regeneration (`ScheduledUpdateService`) consults `WorkKnowledgeDocument.locked` and `lockMode` before producing changes:

- `locked=true, lockMode='full'`: the doc is read-only context; not modified.
- `locked=true, lockMode='additions-only'`: appends are allowed, rewrites are not.
- `locked=false`: standard behavior.

For `legal` documents, the platform additionally enforces a global "never rewrite legal content; only re-render verbatim" rule, regardless of lock state.

### 17.4 Community PR integration

When `CommunityPrService` opens a PR with KB changes, the PR body includes:

- A list of which KB documents were modified.
- Which KB documents informed the change (citations).
- A "respect lock" check that excludes any locked docs from the diff.

### 17.5 Comparison generator integration

The `comparison-generator` plugin already produces comparison tables. With the KB in place, it additionally:

- Reads `kbDocumentClass='competitors'` documents to determine inclusion/exclusion lists.
- Reads relevant `research` docs as evidence for dimension scores.
- Writes a citation per dimension to `WorkKnowledgeCitation`.

---

## 18. Migrations

### 18.1 New entities

Generate migrations in `apps/api/src/migrations/` following the established `{unix-millis}-{PascalCase}.ts` pattern. Suggested:

- `<ts>-CreateWorkKnowledgeDocuments.ts`
- `<ts>-CreateWorkKnowledgeUploads.ts`
- `<ts>-CreateWorkKnowledgeTags.ts`
- `<ts>-CreateWorkKnowledgeCitations.ts`
- `<ts>-CreateWorkKnowledgeChunks.ts`
- `<ts>-AddWorkKbConfigColumn.ts` (adds `kb_config simple-json` to `works`)

Each migration must include the down-migration and the check constraint where noted (CHECK on `work_knowledge_documents` for the `workId XOR organizationId` invariant).

The `pgvector` extension must be enabled in a separate small migration:

- `<ts>-EnablePgvectorExtension.ts` (idempotent `CREATE EXTENSION IF NOT EXISTS vector;`).

### 18.2 Backfill for existing Works

For every existing Work, on first access to the KB (or via a one-time admin job):

1. Create the `.content/kb/` folder skeleton in the Work's data repo (empty class folders + `.index.yml`).
2. Initialize `Work.kbConfig` with platform defaults.
3. No documents are seeded — the user starts from an empty KB.

A one-time backfill job (`packages/tasks/`) iterates existing Works and primes the structure, idempotent and resumable.

### 18.3 Compatibility with existing `advanced-prompts`

`Work.workAdvancedPrompts` remains. Optional migration path: the workbench offers a one-click "convert advanced prompts to KB documents" action that splits the existing free text into draft `brand` / `style` documents. This is opt-in per Work; no automatic migration.

---

## 19. Observability and audit

### 19.1 Activity log

New `ActivityLog` kinds:

- `kb.document.created`, `kb.document.updated`, `kb.document.deleted`, `kb.document.restored`, `kb.document.locked`, `kb.document.unlocked`
- `kb.upload.created`, `kb.upload.normalized`, `kb.upload.extracted`, `kb.upload.extraction-failed`, `kb.upload.deleted`
- `kb.tag.created`, `kb.tag.deleted`
- `kb.index.rebuilt`
- `kb.context.truncated` (budget exceeded during retrieval)
- `kb.org-legal.published`, `kb.org-legal.fanout-completed`

### 19.2 Plugin usage events

Each call into a content-extractor or storage plugin during the ingest pipeline produces a `PluginUsageEvent` row already, via the existing instrumentation.

### 19.3 Budget integration

KB operations consume from `WorkBudget`:

- Extraction (LLM-backed extractors) incurs token cost.
- Auto-classification incurs token cost.
- Embedding generation incurs token cost.
- Transcription incurs token cost.

All costs are routed through the existing `UsageLedgerEntry` ledger. The workbench surfaces "KB this month" as a separate line item on the Work budget summary.

### 19.4 Metrics

Expose Prometheus / OpenTelemetry counters and histograms:

- `kb_documents_total{workId, class, status}`
- `kb_uploads_total{workId, status}`
- `kb_extraction_duration_seconds{plugin}` (histogram)
- `kb_retrieval_context_tokens{workId}` (histogram)
- `kb_retrieval_truncations_total{workId}`

---

## 20. Permissions

KB access is gated by the existing `WorkMember` role model:

- **Viewer**: read documents and uploads; cannot write or upload.
- **Editor**: read + create / update / delete documents and uploads; cannot lock org-level legal documents.
- **Owner**: full access including lock toggles, restore from history, configure `Work.kbConfig`.
- **Org Admin** (a separate org-level role): full access to org-level legal documents (§12.6).

All KB endpoints route through the existing `WorkMemberGuard` and `OrganizationAdminGuard`.

---

## 21. Limits and quotas

Default per-tenant quotas (configurable via subscription plan):

| Resource                                    | Default limit                     |
| ------------------------------------------- | --------------------------------- |
| KB documents per Work                       | 5,000                             |
| KB uploads per Work                         | 2,500                             |
| Original-file size per upload               | 200 MB                            |
| Total original storage per Work             | 10 GB                             |
| Total KB body content per Work              | 200 MB                            |
| Tags per Work                               | 1,000                             |
| Embedding chunks per Work                   | 200,000                           |
| Concurrent ingests per Work                 | 4                                 |
| Per-document retrieval context cap (tokens) | 8,000                             |
| Per-Work retrieval-context-tokens-per-day   | 50M (subscription-tier dependent) |

Limits surface in `SubscriptionPlan` and are enforced in `KnowledgeBaseService` before persisting. Hitting a limit returns 402 (Payment Required) with the relevant plan upgrade hint.

---

## 22. Security considerations

- All KB content is treated as **tenant-sensitive**: encrypted in transit, never logged in raw form by the platform, and never sent to a third-party AI provider unless the user-configured provider explicitly forwards it.
- Webhooks include only `documentId` / `uploadId`, never document bodies.
- Signed-URL TTLs for original retrieval default to 15 minutes.
- Org-level legal docs are exposed read-only to Works under the org; org-admins control writes.
- Lock state is enforced by **reconcile + flag** for v1 (no per-provider pre-receive hook in v1). On every platform read, the KnowledgeBaseService pulls the latest Git state and compares per-document checksum against the DB row. If a Git change touched a doc the DB marks as locked, the platform records a `kb.lock.violation` activity-log row and surfaces a workbench banner showing the diff between locked and incoming versions, with explicit "accept incoming change (unlocks)" and "revert to locked version" actions. The DB row is updated only after the user resolves the conflict. Pre-receive hook rejection per Git-provider plugin is a v2 candidate.
- `pgvector` embeddings are derived from content; deletion of a document cascades to its chunks.
- Telemetry: KB document IDs and counts may be reported (with org/user consent); bodies are never reported.

---

## 23. Telemetry and analytics

Opt-in PostHog events (no body content ever sent):

- `kb.workbench.opened`
- `kb.document.created` (with `class`, `source`)
- `kb.upload.started` (with `mimeType` family)
- `kb.upload.extracted` (with `extractionPluginId`, `duration` bucket)
- `kb.search.executed` (with `hitCount` bucket, `latency` bucket)
- `kb.ai.message-sent` (with `mention.count` bucket)
- `kb.context.injected` (with `class` mix, `tokens` bucket)

---

## 24. Acceptance criteria (v1)

The feature is shippable when all of the following pass:

1. A new Work, on creation, has an initialized empty `.content/kb/` structure in its data repo, including all class folders and a valid `.index.yml`.
2. A user can upload a PDF; within 60 seconds, the upload row reaches `extractionStatus='succeeded'` and a corresponding `WorkKnowledgeDocument` exists with non-empty Markdown body, both in DB and Git.
3. A user can open the workbench, see the upload in the Originals tab, see the extracted Markdown in the KB tab, and edit the Markdown in the Tiptap editor with autosave.
4. The user can lock a document (`mode='full'`) and a subsequent scheduled regeneration leaves it untouched.
5. The user can `@kb:brand/voice` in an AI conversation message and the assistant's response is grounded in that document and cites it.
6. An org-admin can publish a `legal/privacy.md` document at the org level; all Works in the org with `kbConfig.legalInheritance='inherit'` immediately see it materialized in their `.org/legal/` overlay.
7. The MCP `kb.list` / `kb.read` / `kb.search` tools return correct results for an authorized API key.
8. The CLI `ever works kb upload <work-id> <file>` produces the same end state as a workbench upload.
9. All KB API endpoints are documented in the OpenAPI spec generated by `apps/api`.
10. End-to-end test (`apps/web` Playwright) covers: create document → edit → upload → extract → search → mention → lock → restore-from-history.
11. Migrations apply cleanly on a fresh database and on a copy of staging.
12. Existing Works backfill cleanly via the one-time job; no Work is left in an inconsistent state.
13. All entity classes pass the existing `eslint`/`typecheck`/`test` pipeline.
14. PR review loop completes per platform standard (CodeRabbit / Codex / etc. all green or explicitly acknowledged).

---

## 25. Phased delivery

To keep scope tractable, the feature ships in three phases.

### Phase 1 — foundation

- Entities + migrations.
- `KnowledgeBaseService` + REST endpoints (documents + uploads + tree + search lexical-only).
- Workbench MVP: tree, Tiptap editor, original viewers (PDF, image, native video).
- Drag-and-drop upload + pdf/docx/md extraction.
- Per-document lock semantics.
- Activity log integration.
- Backfill job for existing Works.

### Phase 2 — agent integration + retrieval

- Embedding generation + `WorkKnowledgeChunk` + semantic retrieval.
- Pipeline integration (`KbPromptFormatter`, `KbContextBundle` plumbed through every pipeline).
- AI conversation `@kb` mentions + citations.
- Agent tools (`kb_search`, `kb_read`, `kb_write`).
- Org-level legal inheritance + fanout.
- Community-PR + scheduled-regen lock respect.

### Phase 3 — polish

- Video / audio normalization + transcription extractors.
- Embedded-app outputs (HTML deck / dashboard hosting).
- `output`-class agent writes back.
- MCP + CLI surfaces.
- Wikilink resolver + rename-aware reference rewriter.
- Reconciliation job (Git ↔ DB drift detection).
- Telemetry full event set.

---

## 26. Confirmed decisions

All ten v1 open questions were resolved on 2026-05-21. The body sections of this PRD reflect these decisions inline; this section is the canonical decision log for review purposes.

| #   | Topic                               | Decision                                                                                                                                                                                                                                                                                                                                                            | Body section                    |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| D1  | Embedding provider                  | **Platform-managed embedding lane, configurable per-organization, distinct from the Work's generation provider.** Default `text-embedding-3-small` (1536-dim). Cost flows through `UsageLedgerEntry` as a separate line item (`category='kb-embedding'`), not mixed with generation budget. If embeddings are unavailable, KB falls back to lexical-only retrieval. | §15.2, §19.3                    |
| D2  | Inheritable classes                 | **`legal`, `style`, `seo`** support org-level default with Work-level override. `brand`, `glossary`, `competitors`, `personas`, `research`, `output`, `freeform` are always per-Work. Per-class inheritance mode (`inherit` / `override` / `disabled`) configurable on each Work via `kbConfig.inheritance`.                                                        | §10.2, §10.3, §6.1, §7.6, §12.6 |
| D3  | On-disk format                      | **Sidecar `.yml + .md`** mirroring the existing `data/{slug}/{slug}.yml + .md` items convention. No YAML frontmatter inside the Markdown body.                                                                                                                                                                                                                      | §7.2, §7.3, §7.4                |
| D4  | Lock enforcement on direct Git push | **Reconcile + flag in workbench.** No per-Git-provider pre-receive hook in v1. On platform read, DB-vs-Git checksum diff surfaces a banner with "accept incoming (unlocks)" / "revert to locked version" actions. Pre-receive hooks deferred to v2.                                                                                                                 | §22 (security), §7.6            |
| D5  | Chunking strategy                   | **Hybrid: heading-aware (H2/H3) + fixed-size fallback** for sections longer than ~512 tokens with 64-token overlap. Documents without headings degrade to pure fixed-size. headingPath stored in chunk metadata for citation rendering.                                                                                                                             | §15.2                           |
| D6  | Tag color taxonomy                  | **Fixed palette of ~16 design-system tokens** stored as a token name (varchar), not hex. Dark/light mode handled by the design system. If user does not pick a color, the platform **auto-derives** by hashing the tag slug into the palette deterministically.                                                                                                     | §11.1, §6.3                     |
| D7  | Viewer caps                         | **Per-format thresholds.** PDF 50 MB, XLSX/XLSM 15 MB, DOCX/PPTX 10 MB, CSV/TSV 25 MB, image 50 MB, video/audio uncapped (streamed). Above cap → download button + explanation banner. Thresholds configurable per subscription plan.                                                                                                                               | §14.5                           |
| D8  | Vector isolation                    | **Single `work_knowledge_chunks` table** with composite PK `(workId, id)` so `workId` is the leftmost partition key. Every retrieval query enforces `WHERE workId = $1` at the service layer. ivfflat index on `(workId, embedding)`. **Designed for future migration to Postgres declarative `PARTITION BY HASH (workId)`** without table rewrite.                 | §15.2                           |
| D9  | KB body cap                         | **1 MB Markdown per document** (~250k tokens). Configurable per-org if a customer has genuine need to lift it. Oversized documents are nudged to split.                                                                                                                                                                                                             | §21                             |
| D10 | Orphan-storage cleanup              | **Daily sweeper job with 7-day grace period.** Detected orphans are tombstoned and physically removed only after 7 days; re-importing the same SHA-256 within the grace period revives the row and clears the tombstone.                                                                                                                                            | §9.6                            |

### Decisions deferred to v2 or later

- Pre-receive hook rejection per Git-provider plugin (D4 v2).
- Additional inheritable classes beyond `legal`/`style`/`seo` (D2 v2 — `glossary` is the most likely candidate based on real org demand).
- Postgres declarative partitioning of `work_knowledge_chunks` (D8 — triggered when retrieval latency or recall degrades).
- Per-class chunking strategies (D5 v2 — flagged for re-evaluation after Phase 2 with real KB data).
- Encrypted-at-rest KB content for regulated industries (planned alongside broader platform encryption work).
- Per-paragraph soft locks (current scope is per-document).
- LLM-eval-driven validation of agent KB writes (planned alongside generation-quality eval CI).

---

## 27. Appendix — example DTOs

```ts
// packages/contracts/src/kb/kb-document.dto.ts
export interface KbDocumentDto {
	id: string;
	workId: string | null;
	organizationId: string | null;
	path: string;
	slug: string;
	title: string;
	description: string | null;
	class: KbDocumentClass;
	tags: string[];
	categories: string[];
	status: 'draft' | 'active' | 'archived';
	locked: boolean;
	lockMode: 'full' | 'additions-only' | null;
	language: string;
	wordCount: number | null;
	tokenCount: number | null;
	source: 'user' | 'agent' | 'imported' | 'seeded';
	sourceUploadId: string | null;
	sourceUrl: string | null;
	generatedByAgentRunId: string | null;
	createdById: string | null;
	updatedById: string | null;
	createdAt: string;
	updatedAt: string;
	lastCommitSha: string | null;
	lastIndexedAt: string | null;
}

export interface KbDocumentBodyDto extends KbDocumentDto {
	body: string; // Markdown
	assets: KbAssetSummary[];
}

export interface KbUploadDto {
	id: string;
	workId: string;
	storageProvider: string;
	storagePath: string;
	originalFilename: string;
	mimeType: string;
	fileSize: number;
	sha256: string;
	normalizedFormat: string | null;
	extractionStatus: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
	extractionPluginId: string | null;
	extractionError: string | null;
	extractedDocumentId: string | null;
	uploadedById: string | null;
	tags: string[];
	categories: string[];
	createdAt: string;
	updatedAt: string;
}

export interface KbSearchHit {
	documentId: string;
	path: string;
	title: string;
	class: KbDocumentClass;
	snippet: string;
	score: number;
	chunkIndex?: number;
	chunkRange?: { start: number; end: number };
}

export interface KbTreeNode {
	type: 'folder' | 'document';
	path: string;
	name: string;
	documentId?: string;
	class?: KbDocumentClass;
	status?: 'draft' | 'active' | 'archived';
	locked?: boolean;
	children?: KbTreeNode[];
}

export interface CitationDto {
	id: string;
	documentId: string;
	consumerType: 'agent-run' | 'generation-history' | 'conversation-message' | 'community-pr' | 'comparison';
	consumerId: string;
	chunkRange: { start: number; end: number } | null;
	relevanceScore: number | null;
	createdAt: string;
}

export type KbDocumentClass =
	| 'brand'
	| 'legal'
	| 'seo'
	| 'glossary'
	| 'competitors'
	| 'personas'
	| 'style'
	| 'research'
	| 'output'
	| 'freeform';
```

---

## 28. Appendix — example resolver flow

A concrete end-to-end trace of "AI generates a new page; what does it see?"

1. `ScheduledUpdateService` fires for Work `W`.
2. The pipeline calls `KnowledgeBaseService.resolveContext(W, { task: 'regenerate-listing', pageType: 'category' })`.
3. The service queries DB:
    - All `WorkKnowledgeDocument` with `workId=W` and `kbDocumentClass IN ('brand', 'glossary', 'style', 'personas')` and `status='active'`.
    - All `legal` docs: union of `(organizationId=W.organizationId, workId=NULL)` and `(workId=W)`, with the latter overriding by `path`.
    - `seo` docs filtered by `metadata.pageTypes` containing `'category'`.
4. Total token cost across these is summed. If over `Work.kbConfig.retrievalConfig.maxContextTokens`, truncate by class precedence and emit `kb.context.truncated`.
5. The pipeline builds the system prompt via `KbPromptFormatter`:

```
=== BRAND ===
〔brand/voice〕 Use a confident, plain-spoken tone. Avoid hype words: …
〔brand/visual-identity〕 Primary color: #1F2937. Display font: Inter…

=== LEGAL ===
〔legal/privacy〕 [verbatim text — never paraphrase]

=== GLOSSARY ===
- "Workspace" means the user's primary org-scoped container.
- "Work" means a single AI-generated website project.
…

=== STYLE ===
- Oxford comma: yes.
- Banned: "leverage", "synergy", "delve".
…

=== PERSONAS ===
〔personas/primary-buyer〕 Skeptical mid-market CTO, ages 35–50, …

=== SEO (CATEGORY PAGE) ===
〔seo/keyword-strategy〕 Target long-tail keywords with commercial intent…
```

6. The pipeline calls the configured AI provider with this prompt + the task-specific user prompt.
7. The assistant response is parsed for citation markers; each marker becomes a `WorkKnowledgeCitation` row linking back to the source doc.
8. The generation history records `kbDocumentIds: [...]` in its metadata.

This trace is the canonical example for documentation and tests.

---

_End of PRD v1._
