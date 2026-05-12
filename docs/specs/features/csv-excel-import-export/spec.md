# Feature Specification: CSV / Excel Item Import + Export

**Feature ID**: `csv-excel-import-export`
**Jira ticket**: [EW-533](https://evertech.atlassian.net/browse/EW-533)
**Status**: `Shipped`
**Created**: 2026-05-11
**Last updated**: 2026-05-12
**Owner**: Ever Works Team

---

## 1. Overview

Directory administrators can manage items in bulk via CSV or Excel
files. The feature ships in two halves:

- **Export** — download every item in a directory as a CSV or XLSX file.
- **Import** — upload a CSV or XLSX file and add (or overwrite) items
  in bulk. The flow is a 5-step wizard (Upload → Mapping → Preview →
  Confirm → Results) that delegates writes to a dedicated executor
  service which clones the data repo, writes the YAMLs, commits +
  pushes, and (when `autoapproval` is off) opens a single PR per batch.

Both flows are **off by default per directory** and gated by config
keys in `.works/works.yml`. The toggles live in a top-level "Item
Import & Export" section under the directory's Settings tab.

## 2. Settings

Persisted in `.works/works.yml` under `settings:`. All three keys are
optional; missing keys take the defaults below.

| Key               | Type         | Default | Effect                                                                                                                                        |
| ----------------- | ------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `export_enabled`  | boolean      | `false` | When false, the Export button is hidden and `GET /export-items` responds 404.                                                                 |
| `import_enabled`  | boolean      | `false` | When false, the Import button is hidden and the import endpoints respond 404.                                                                 |
| `import_max_rows` | int (1–2000) | `500`   | Hard ceiling on rows accepted by a single import upload. Files exceeding the cap are rejected with `code: RowCountExceeded` before any write. |

Surfaced through:

- Server: `IDataConfig.SettingsConfig` in
  `packages/agent/src/generators/data-generator/data-repository.ts`
- DTOs: `UpdateWebsiteSettingsDto` + `WebsiteSettingsResponseDto`
  in `packages/agent/src/dto/website-settings.dto.ts`
- UI: `apps/web/src/components/works/detail/settings/ItemImportExportSettings.tsx`

## 3. API surface

All routes mounted on `WorksController` (`apps/api/src/works/`),
class-level `AuthSessionGuard`. Per-route gating reads
`workQueryService.workConfig(id, user)` and 404s when the relevant flag
is off.

### Export (Phase 1)

| Method | Path                                           | Notes                                                           |
| ------ | ---------------------------------------------- | --------------------------------------------------------------- |
| `GET`  | `/api/works/:id/export-items?format=csv\|xlsx` | Streams the serialised items. Logs `ActivityActionType.EXPORT`. |
| `GET`  | `/api/works/:id/export-items/settings`         | `{ export_enabled }` probe used by the UI to hide the button.   |

### Import — parse + validate (Phase 2, dry-run)

| Method | Path                                                  | Notes                                                                                                                                               |
| ------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/works/:id/import-items/validate`                | `multipart/form-data` with `file` (CSV/XLSX) + optional JSON `mapping`. Returns `ImportValidationResponse`. Throttle: 10/min. File-size cap: 10 MB. |
| `GET`  | `/api/works/:id/import-items/sample?format=csv\|xlsx` | Downloads the import template (reuses `ItemExportService.generateSample`).                                                                          |
| `GET`  | `/api/works/:id/import-items/settings`                | `{ import_enabled, import_max_rows }`.                                                                                                              |

### Import — execute (Phase 3, writes)

| Method | Path                          | Notes                                                                                                                                                                                                                                   |
| ------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/works/:id/import-items` | Body: `{ rows, duplicate_strategy?, default_status? }`. Defaults: `skip` / `pending`. Returns `{ total, created, updated, skipped, errors[], pr_url?, pr_number?, direct_commit? }`. Throttle: 3/min. Logs `ActivityActionType.IMPORT`. |

## 4. Column contract

Single source of truth: `packages/agent/src/items-generator/column-mapping.ts`.

**Required**: `name`, `description`, `source_url`, `category` (or
`categories` array)
**Optional**: `categories`, `tags`, `slug`, `featured`, `order`,
`brand`, `brand_logo_url`, `images`

Conventions:

- **Array fields** (`categories`, `tags`, `images`) are
  semicolon-separated within a single cell. The separator was chosen
  because commas appear in descriptive text far more often than
  semicolons do.
- **Boolean fields** (`featured`) accept `true`/`false`/`1`/`0`/`yes`/
  `no`/`on`/`off` (case-insensitive). Unparseable values degrade to
  warnings, not errors.
- **Integer fields** (`order`) must be non-negative.
- **URL fields** (`source_url`, `brand_logo_url`, `images.*`) must be
  valid `http://` or `https://` URLs.
- **Slug** must match `^[a-z0-9]+(?:-[a-z0-9]+)*$`. When omitted, the
  executor slugifies the row's `name`.
- **Auto-mapping**: `HEADER_ALIASES` lets common header variants
  (`URL`, `Item Name`, `Sort Order`, `Image URLs`, etc.) resolve to
  canonical fields automatically. Users can override the mapping in
  the wizard's Step 2.

## 5. Wizard flow

`apps/web/src/components/works/detail/items/ItemImportWizard.tsx` —
modal opened by `ItemsImportButton` on the directory's Items tab.

```
Upload  →  Mapping  →  Preview  →  Confirm  →  Results
   │           │           │           │            │
 file       remap        per-row     strategy    counts
 picker    columns       errors      + status    + PR link
```

1. **Upload** — drag-drop or browse. POSTs to
   `/import-items/validate` with no mapping. The service returns the
   detected headers + an inferred mapping + per-row validation.
2. **Mapping** — table of `file column → item field`. The user can
   override or skip any column. Re-POSTs with the new mapping on
   "Continue".
3. **Preview** — per-row status (Valid / Invalid / Duplicate),
   errors + warnings, capped at the first 200 rows for display.
4. **Confirm** — duplicate-strategy dropdown (`skip` | `update`) and
   default-status dropdown (`pending` | `published`), with a live
   summary of what will happen on click.
5. **Results** — `created / updated / skipped / errors` counts,
   PR link when a PR was opened, direct-commit note when `autoapproval`
   is on, per-row error list when the executor reported errors.

## 6. Executor write path

`ItemImportExecutorService` in
`packages/agent/src/items-generator/item-import-executor.service.ts`.

```
cloneOrPull (work owner credentials, current user as committer)
    │
    ├─ getConfig() → autoapproval?
    ├─ getItems()  → existing slug + source_url sets
    ├─ switchBranch( items-import-<ts> | main )
    │
    ├─ pMap(rows, concurrency=5):
    │     duplicate + skip   → skipped++
    │     duplicate + update → writeItem() (updated++)
    │     new                → createItemDir() + writeItem() (created++)
    │     errors caught per-row, batch continues
    │
    ├─ if (created + updated == 0): return — skip commit/push
    │
    ├─ git add . / commit / push
    └─ autoapproval?
          true  → return { direct_commit: true, ... }
          false → createPullRequest() → return { pr_url, pr_number, ... }
```

- **Concurrency**: `p-map` cap `5` for the YAML writes. Conservative
  enough to keep local fs operations within budget on a 500-row
  import; matches the same level used for other batched fs work.
- **Single PR per batch**: cleaner history + atomic rollback target.
- **Duplicate detection at execute time**: re-snapshots the cloned
  repo's items so a concurrent change between Validate and Execute
  doesn't slip through.
- **Markdown**: not generated for imported items in the MVP; users
  add markdown via the per-item editor.

## 7. Limits

| Limit                                   | Value                                | Where                                             |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------- |
| File-size cap                           | 10 MB                                | `FileInterceptor` on the validate route           |
| Rows per upload (per-directory)         | 500 default, configurable up to 2000 | `settings.import_max_rows`                        |
| Rows per upload (service-level ceiling) | 10,000                               | `PARSER_HARD_ROW_CAP` in `item-import.service.ts` |
| Throttle — `/import-items/validate`     | 10 / min / IP                        | `@Throttle` on the route                          |
| Throttle — `/import-items` (execute)    | 3 / min / IP                         | `@Throttle` on the route                          |
| Pipeline concurrency                    | 5                                    | `p-map` `concurrency` in the executor             |

## 8. Files of interest

```
packages/agent/src/items-generator/
  ├─ column-mapping.ts             # Single source of truth for field names + parsers
  ├─ item-export.service.ts        # CSV/XLSX serialisation
  ├─ item-import.service.ts        # Parse + validate (dry-run)
  ├─ item-import-executor.service.ts  # Bulk write + PR
  ├─ item-import-export.types.ts   # Shared TS contracts
  └─ items-generator.module.ts     # Provider wiring

apps/api/src/works/
  └─ works.controller.ts           # 6 routes wired here

apps/web/src/app/api/works/[id]/
  ├─ export-items/{settings,}/route.ts        # 2 proxy routes
  └─ import-items/{settings,sample,validate}/route.ts + route.ts (execute)

apps/web/src/components/works/detail/items/
  ├─ ItemsExportButton.tsx          # Items-page Export dropdown
  ├─ ItemsImportButton.tsx          # Items-page Import button
  └─ ItemImportWizard.tsx           # Modal with 5 steps

apps/web/src/components/works/detail/settings/
  └─ ItemImportExportSettings.tsx   # Settings tab section (peer to Website Config)
```

## 9. Known follow-ups

- **i18n**: all strings introduced by this feature are hardcoded
  English. Translation keys across the 30+ supported locales are a
  Phase-4 follow-up.
- **Async pathway for very large files**: imports above 2000 rows
  could move to a Trigger.dev background task instead of the sync
  HTTP request.
- **Custom per-directory fields**: the column contract is currently
  fixed; per-directory schemas (already supported elsewhere in the
  platform) could be wired into the auto-mapper.
- **Markdown content in imports**: out of scope for the MVP; would
  require an additional column or a separate upload field.
