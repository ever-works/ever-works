---
id: mcp-cli-reference
title: Knowledge Base — MCP & CLI Reference
sidebar_label: MCP & CLI Reference
---

# Knowledge Base — MCP & CLI Reference

The Knowledge Base is reachable from outside the dashboard through two
machine-friendly surfaces:

- **MCP tools** under the `kb.*` namespace, served by the Ever Works
  MCP server (`apps/mcp`). External Claude / GPT / Gemini agents call
  these directly.
- **CLI subcommands** under `ever works kb`, served by the public CLI
  (`apps/cli`). Operators script these from shells and CI.

Both surfaces are thin wrappers around the same REST endpoints
(`/api/works/:id/kb/*`) — anything you can do on the MCP side has a
matching CLI command and vice versa. Auth is per-user JWT or the
shared API key (hybrid mode), routed through the standard
`ApiClientService` in the MCP server and the standard `getHttpClient()`
in the CLI.

For background, see the [user guide](./user-guide.md).

## MCP — the `kb.*` tool surface

The MCP server exposes five mutating tools and two read tools. All
tools accept a `workId` (UUID); document-scoped tools additionally take
an `idOrPath` that resolves to either a document UUID or a slash-separated
KB path (e.g. `brand/voice`).

### `kb.list`

List documents for a Work.

| Field    | Type                                          | Required | Notes                                          |
| -------- | --------------------------------------------- | -------- | ---------------------------------------------- |
| `workId` | `string` (UUID)                               | yes      | Work the documents belong to                   |
| `class`  | `brand \| style \| legal \| seo \| ...`       | no       | Filter by class                                |
| `status` | `active \| archived \| draft \| ...`          | no       | Filter by lifecycle status                     |
| `tag`    | `string`                                      | no       | Filter to documents tagged with this slug      |
| `q`      | `string`                                      | no       | Lexical search over title / description / body |
| `limit`  | `integer 1-100`                               | no       | Page size                                      |
| `offset` | `integer ≥0`                                  | no       | Pagination offset                              |

**Output:**

```jsonc
{
  "items": [
    {
      "id": "uuid",
      "path": "brand/voice",
      "title": "Brand voice",
      "class": "brand",
      "status": "active",
      "locked": true,
      "lockMode": "full",
      "tags": ["voice", "tone"],
      "updatedAt": "2025-12-15T10:30:00Z"
    }
  ],
  "total": 42
}
```

Annotations: `readOnlyHint: true`.

### `kb.get`

Fetch one document (full Markdown body + metadata + asset summaries).

| Field      | Type            | Required | Notes                                       |
| ---------- | --------------- | -------- | ------------------------------------------- |
| `workId`   | `string` (UUID) | yes      |                                             |
| `idOrPath` | `string`        | yes      | Document UUID or slash-separated KB path    |

**Output:** `KbDocumentBodyDto` (id, path, title, class, status,
locked, lockMode, description, tags, categories, body, updatedAt,
assets).

Annotations: `readOnlyHint: true`.

### `kb.create`

Create a new document.

| Field         | Type                                                                                        | Required | Notes                                       |
| ------------- | ------------------------------------------------------------------------------------------- | -------- | ------------------------------------------- |
| `workId`      | `string` (UUID)                                                                             | yes      |                                             |
| `path`        | `string` (1-512)                                                                            | yes      | Unique per Work, slash-separated            |
| `title`       | `string` (1-256)                                                                            | yes      |                                             |
| `body`        | `string`                                                                                    | yes      | Markdown, may be empty                      |
| `class`       | `brand \| style \| legal \| seo \| glossary \| personas \| competitors \| research \| ...`  | yes      | See [class list](./user-guide.md#what-lives-in-the-kb--document-classes) |
| `description` | `string \| null`                                                                            | no       |                                             |
| `tags`        | `string[]`                                                                                  | no       | Tag slugs                                   |
| `categories`  | `string[]`                                                                                  | no       | Category slugs                              |
| `language`    | `string` (BCP-47)                                                                           | no       | Defaults to `en`                            |
| `status`      | `active \| archived \| draft \| ...`                                                        | no       | Defaults to `active`                        |

**Output:** the newly created `KbDocumentDto`.

### `kb.update`

Partial update. At least one patch field must be provided.

| Field      | Type                                  | Required | Notes                                |
| ---------- | ------------------------------------- | -------- | ------------------------------------ |
| `workId`   | `string` (UUID)                       | yes      |                                      |
| `idOrPath` | `string`                              | yes      | Document UUID or KB path             |
| `patch`    | `object`                              | yes      | At least one of the fields below     |

`patch` shape:

```jsonc
{
  "title": "string?",
  "description": "string | null?",
  "body": "string?",
  "tags": ["string?"],
  "categories": ["string?"],
  "language": "string?",
  "status": "active | archived | draft | ..."
}
```

The MCP tool resolves `idOrPath` to a UUID via the GET-by-id-or-path
endpoint before issuing the PATCH (the server's `:docId` route is
pinned to a UUID).

**Output:** the updated `KbDocumentDto`.

### `kb.lock`

Lock a document so subsequent agent edits are rejected.

| Field      | Type                          | Required | Notes                                              |
| ---------- | ----------------------------- | -------- | -------------------------------------------------- |
| `workId`   | `string` (UUID)               | yes      |                                                    |
| `idOrPath` | `string`                      | yes      | Document UUID or KB path                           |
| `lockMode` | `full \| additions-only`      | yes      | `full` blocks all edits; `additions-only` permits appends |

Emits a `kb-document-locked` activity-log event with actor + previous
mode.

**Output:** the updated `KbDocumentDto` with `locked=true`.

### `kb.unlock`

Symmetric to `kb.lock` — emits `kb-document-unlocked`.

| Field      | Type            | Required |
| ---------- | --------------- | -------- |
| `workId`   | `string` (UUID) | yes      |
| `idOrPath` | `string`        | yes      |

**Output:** the updated `KbDocumentDto` with `locked=false`.

### Errors

Every tool routes server-side errors through `toMcpError` so the MCP
client sees a structured error with HTTP status + message. Common
cases:

| HTTP | Meaning                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------ |
| 401  | Missing / expired JWT, or shared API key not configured                                                |
| 403  | User has no role on the Work                                                                           |
| 404  | Document not found, or `idOrPath` resolved to nothing                                                  |
| 409  | Conflict — e.g. `kb.create` with a duplicate path, or `kb.update` on a document locked `full`          |
| 422  | Validation failure — body didn't match the schema (Zod surface)                                        |

## CLI — `ever works kb`

The CLI mounts at `ever works kb <subcommand>`. Auth uses the same
token store as the rest of `ever works` (`ever works auth login`).

### `ever works kb list <workId>`

| Flag        | Type       | Default | Notes                                       |
| ----------- | ---------- | ------- | ------------------------------------------- |
| `--class`   | `string`   | —       | Filter by KB document class                 |
| `--tag`     | `string`   | —       | Filter by tag slug                          |
| `--q`       | `string`   | —       | Lexical + semantic blended search query     |
| `--limit`   | `integer`  | `20`    | Max rows to return                          |
| `--offset`  | `integer`  | `0`     | Pagination offset                           |

Example:

```bash
ever works kb list 5b2f...d8e1 --class brand --limit 50
ever works kb list 5b2f...d8e1 --q "tone of voice"
```

### `ever works kb get <workId> <idOrPath>`

Fetch a single document. Renders metadata + the Markdown body to
stdout, or pass `--json` for the raw DTO (pipe to `jq` for scripting).

| Flag      | Type     | Notes                                             |
| --------- | -------- | ------------------------------------------------- |
| `--json`  | flag     | Emit raw `KbDocumentBodyDto` instead of rendered  |

Example:

```bash
ever works kb get 5b2f...d8e1 brand/voice
ever works kb get 5b2f...d8e1 brand/voice --json | jq '.tags'
```

The path arg legitimately accepts `/` separators — only path segments
are URL-encoded, slashes survive.

### `ever works kb upload <workId> <filePath>`

Upload a source file. The server runs the full ingest pipeline
(storage → MIME sniff → media normalize → transcribe / extract →
KB document).

| Flag        | Type     | Notes                                                            |
| ----------- | -------- | ---------------------------------------------------------------- |
| `--title`   | `string` | Override the auto-derived KB document title                      |
| `--class`   | `string` | Target KB document class for the resulting extract               |

Example:

```bash
ever works kb upload 5b2f...d8e1 ./brand-guide.pdf --class brand --title "Brand guide v3"
ever works kb upload 5b2f...d8e1 ./calls/2025-12-01.mp3 --class transcripts
```

The CLI sniffs the MIME type from the file extension for common cases
(`.md`, `.txt`, `.json`, `.html`, `.pdf`, `.docx`, `.xlsx`) and falls
back to `application/octet-stream` otherwise — the server re-sniffs
from the magic bytes regardless.

**Output:** the upload row + the resulting KB document (or a notice
that no document was created because no extractor matches the MIME).

### `ever works kb lock <workId> <idOrPath> --mode <full|additions-only>`

Lock a document. `--mode` is required.

```bash
ever works kb lock 5b2f...d8e1 legal/disclaimer --mode full
ever works kb lock 5b2f...d8e1 research/competitor-acme --mode additions-only
```

Resolves `idOrPath` to a UUID before issuing the POST (the lock route
on the server is `:docId`-scoped).

### `ever works kb unlock <workId> <idOrPath>`

Symmetric to `lock`.

```bash
ever works kb unlock 5b2f...d8e1 legal/disclaimer
```

### Common exit codes

| Code | Cause                                                                                  |
| ---- | -------------------------------------------------------------------------------------- |
| `0`  | Success                                                                                |
| `1`  | Validation error (bad flag value, file not found, missing required field, server 4xx)  |

Server-side errors are pretty-printed via the shared `handleCliError`
helper — JSON body with status code, message, and request id when the
API returns one.

## Wire shape vs the REST API

The MCP / CLI surfaces are intentionally a 1:1 mirror of the REST
endpoints:

| Operation     | REST endpoint                                                       | MCP tool      | CLI command                              |
| ------------- | ------------------------------------------------------------------- | ------------- | ---------------------------------------- |
| List docs     | `GET /api/works/:id/kb/documents`                                   | `kb.list`     | `ever works kb list`                     |
| Get one doc   | `GET /api/works/:id/kb/documents/:docIdOrPath`                      | `kb.get`      | `ever works kb get`                      |
| Create doc    | `POST /api/works/:id/kb/documents`                                  | `kb.create`   | —                                        |
| Update doc    | `PATCH /api/works/:id/kb/documents/:docId`                          | `kb.update`   | —                                        |
| Lock doc      | `POST /api/works/:id/kb/documents/:docId/lock`                      | `kb.lock`     | `ever works kb lock --mode <m>`          |
| Unlock doc    | `POST /api/works/:id/kb/documents/:docId/unlock`                    | `kb.unlock`   | `ever works kb unlock`                   |
| Upload source | `POST /api/works/:id/kb/uploads` (multipart)                        | —             | `ever works kb upload`                   |

The two omissions are deliberate:

- The CLI doesn't ship `create` / `update` for body editing — Markdown
  bodies are uncomfortable to edit through a flag-driven command. Use
  the workbench, the MCP `kb.create` / `kb.update` tools, or
  `kb upload` for file-driven creation.
- The MCP server doesn't ship `kb.upload` yet — multipart uploads
  through an MCP client are awkward; agents typically call the REST
  endpoint directly via the platform's HTTP fetch tool.

## See also

- [Knowledge Base User Guide](./user-guide.md) — concepts, classes, locks, inheritance
- [Knowledge Base & Memory (Features)](../features/knowledge-base.md) — high-level overview
- [MCP Server](../features/mcp-server.md) — the broader MCP surface (works.*, items.*, ...)
- [CLI Reference](../cli/index.md) — top-level CLI doc
- [Plugin System (End-to-End)](../architecture/plugins.md) — storage + transcription + extractor plugins back the KB
