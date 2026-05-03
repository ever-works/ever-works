# Directory → Work Rename — Historical Copy Map

> **Status:** ✅ COMPLETE. The rename shipped in PRs #419, #420 (consolidated), #421 (consolidated), #422, and #423.
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

## What was deliberately preserved

- DB tables (`@Entity({ name: 'directories' })`, `directory_members`, `directory_advanced_prompts`, `directory_custom_domains`, `directory_generation_history`, `directory_schedules`, `directory_plugins`)
- DB FK columns (`@Column({ name: 'directoryId' })`, `@JoinColumn({ name: 'directoryId' })`)
- DB-stored enum values in `actionType` column (`'directory_created'`, `'directory_updated'`, `'directory_deleted'`)
- Raw SQL strings in TypeORM migrations
- Node.js stdlib API methods (`Dirent.isDirectory()`, `Stats.isDirectory()`)
- Third-party agent skills under `.agents/skills/` (Playwright, Vercel, Turborepo) which mention "directory" in their generic filesystem sense

A separate, dedicated DB migration PR will rename the tables/columns later — at that point the explicit `name:` annotations on entities can be dropped.

## Reference

For the full original copy decisions (capitalization rules, singular CTA conventions, plurals-first strategy, brand tagline), see the merged PR descriptions:

- [#419](https://github.com/ever-works/ever-works/pull/419) — main rename
- [#422](https://github.com/ever-works/ever-works/pull/422) — Docker filter fix
- [#423](https://github.com/ever-works/ever-works/pull/423) — final sweep
