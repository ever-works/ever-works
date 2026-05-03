# Directory → Work Rename — Historical Copy Map

> **Status:** ✅ COMPLETE (including DB layer). The user-facing rename shipped in PRs #419, #420, #421, #422, #423; the DB rename in the follow-up PR.
> **Note:** The original draft of this document was written in the OLD vocabulary so the comparison made sense (Directory → Work). The bulk-rename script that ran across the codebase rewrote the words in this doc too, which made the comparison columns identical. Rather than restoring the original, this stub keeps the historical pointer.

---

## What was done

The product was renamed from **"Directory Builder"** to **"Workshop for AI"**, and the user-facing concept from **"Directory"** to **"Work"** across the entire monorepo. The rebrand covers:

- All English UI copy (`apps/web/messages/en.json`, ~210 string-value swaps)
- All 21 locale files (en + ar/bg/de/es/fr/he/hi/id/it/ja/ko/nl/pl/pt/ru/th/tr/uk/vi/zh)
- i18n message keys (`dashboard.directories.*` → `dashboard.works.*`, ~1608 paths)
- TypeScript code identifiers (`Directory` class → `Work`, `directoryId` → `workId`, ~673 files content-rewritten + 98 files renamed via `git mv`)
- URL routes (`/dashboard/directories/*` → `/dashboard/works/*`, `/api/directories/*` → `/api/works/*`)
- NestJS `@Controller` paths and decorators
- Plugin metadata `description` strings
- AI tool descriptions (LLM-facing, in `apps/web/src/lib/ai/tools/*`)
- MCP tool whitelist names (`list_directories` → `list_works`, etc.)
- Documentation prose + 22 doc-file paths
- Console.log/error developer messages
- **DB tables** renamed: `directories` → `works`, `directory_*` → `work_*` (7 tables)
- **DB FK columns** renamed: `directoryId` → `workId` (across 9 tables)
- **DB JSON keys** rewritten in-place: `works.sourceRepository.relatedRepositories.directory` → `.work`, `works.repoVisibility.directory` → `.work`
- **DB enum values** in `activity_log.actionType`: `'directory_created'` → `'work_created'`, etc.

The DB rename runs idempotently from a `dataSourceFactory` hook in
`packages/agent/src/database/database.module.ts` BEFORE TypeORM
synchronize, so production databases with `DATABASE_AUTOMIGRATE=true`
keep their data through the rename. Same logic is also exposed as a
proper TypeORM migration (`RenameDirectoriesToWorks1762200000000`) for
environments that use the standard migration runner.

## What is deliberately preserved

- Node.js stdlib API methods (`Dirent.isDirectory()`, `Stats.isDirectory()`)
- Third-party agent skills under `.agents/skills/` (Playwright, Vercel, Turborepo) which mention "directory" in their generic filesystem sense
- The migration class `AddWebsiteTemplateIdToDirectories1761912000000` (TypeORM tracks migrations by name; renaming would re-run on prod databases). Its `up()` now resolves to either `works` or `directories` so it stays correct on both pre- and post-rename schemas.
- The migration class `RenameDirectoriesToWorks1762200000000` and its util `runRenameDirectoriesToWorks` — their job IS to rename, so the words appear in the SQL.

## Reference

For the full original copy decisions (capitalization rules, singular CTA conventions, plurals-first strategy, brand tagline), see the merged PR descriptions:

- [#419](https://github.com/ever-works/ever-works/pull/419) — main rename
- [#422](https://github.com/ever-works/ever-works/pull/422) — Docker filter fix
- [#423](https://github.com/ever-works/ever-works/pull/423) — final sweep
- [#429](https://github.com/ever-works/ever-works/pull/429) — post-rename data fixes (migration name, JSON keys, jest config typo)
- [#433](https://github.com/ever-works/ever-works/pull/433) — Node 22 + docs build fix
- This PR — full DB rename (tables, columns, JSON keys, enum values)
