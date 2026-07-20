# Work Template Catalog — Task Checklist

**Status:** Draft v1 · **Date:** 2026-07-18 · **Spec:** [spec.md](spec.md) · **Plan:** [plan.md](plan.md)

Legend: `[ ]` todo · `[~]` in progress · `[x]` done. Each task names the concrete file(s).

---

## P1 — Catalog service + endpoint + manifest consume

### Repo `ever-works/works`

- [ ] P1-R1 Add `manifest.json` — `version:1`, `generatedBy`, `blueprints[]`: `directory`, `directory-minimal`, `marketing-site` (production) + `company`, `store` (`status:"placeholder"`, `template.repo:null`); one `default:true` per `chipType`.
- [ ] P1-R2 Add `schema/works-manifest.schema.json` (draft 2020-12; `required:[slug,name,title,summary,kind,chipType,status,template]`; `template.repo` pattern `^ever-works/[a-z0-9-]+$`).
- [ ] P1-R3 Add `scripts/build-manifest.mjs` + `.github/workflows/validate.yml` (schema + `default`-uniqueness-per-`chipType` gate).

### API (`apps/api`)

- [ ] P1-A1 `apps/api/src/works/works-template-catalog.service.ts` — clone `agent-template-catalog.service.ts`; reuse `SAFE_SLUG_RE`/`stripHtml`/`kebabToPascal`/`asStringArray`/`MAX_*`; tokenless `raw.githubusercontent.com` read + GitFacade token fallback; `EVER_WORKS_WORKS_REF` (default `main`) + mutable-ref warning; 1h `cache_entries` cache; drop `placeholder`/bad-slug/bad-repo rows; map to `WorkBlueprintEntry`; `list(chipType?)`.
- [ ] P1-A2 `apps/api/src/works/work-templates.controller.ts` — `WorkTemplatesController`, `@Controller('api/work-templates')`, `@Get() @Public() @HttpCode(200)`, `@Query('chipType')`, `@ApiTags('Works')`.
- [ ] P1-A3 `apps/api/src/works/works.module.ts` — add service to `providers`, controller to `controllers`; confirm `GitFacadeService` + `CACHE_MANAGER` in scope.
- [ ] P1-A4 `works-template-catalog.service.spec.ts` — clone the agent spec: failure→`[]`, malformed→`[]`, HTML stripped, bad slug/repo dropped, `chipType` filter, cache hit, ref warning.

### Web (`apps/web`)

- [ ] P1-W1 `apps/web/src/lib/api/work-templates.ts` — `WorkBlueprintEntry` type + isomorphic `listBuiltinWorkBlueprints(chipType?)` fallback (classic/minimal as blueprints).
- [ ] P1-W2 `apps/web/src/lib/api/work-templates.server.ts` (`server-only`) — `fetchWorkTemplateCatalog(chipType?)` → `serverFetch` + fallback. Clone `agent-templates.server.ts`.

---

## P2 — Chips + selector + rename on Create-Work-Manually

- [ ] P2-1 i18n: add `dashboard.templateSelector.label` = `"Template"` + `searchPlaceholder` to `apps/web/messages/en.json` + all locale files.
- [ ] P2-2 `WebsiteTemplateSelector.tsx` — default `label` → `t('label')`; no test-id/prop change.
- [ ] P2-3 chip-value → `chipType` lookup map beside `WORK_KIND_ORDER` (`new-work-client.tsx`).
- [ ] P2-4 Filter blueprints by `chipType(effectiveKind)`; render the selector line only when the filtered list is non-empty.
- [ ] P2-5 `WebsiteTemplateSelector.tsx` — replace native `<Select>` picker with a shadcn `Command`-in-`Popover` combobox (search on `name`/`tags`/`category`, `featured` first); preserve status card + origin badge + `resolveWebsiteTemplateSelection` + `data-testid`s; `value`=slug unchanged.
- [ ] P2-6 `/works/new/page.tsx` — fetch `fetchWorkTemplateCatalog()`; pass to `new-work-client.tsx` → `WorkAICreator`.
- [ ] P2-7 `WorkAICreator.tsx` — feed chip-filtered list to the selector; pre-fill provider/organization selectors from `blueprint.defaults`; keep binding `formData.websiteTemplateId`.
- [ ] P2-8 Backend create mapping — upsert-on-validate: when `websiteTemplateId` is a blueprint slug absent from `templates`, insert `built_in` row `works-blueprint:<slug>` (kind `website`, blueprint repo coords + ref) so `getVisibleTemplateForUser` → `resolveForWork` → `duplicate()` forks the right repo. Files: `work-lifecycle.service.ts` `resolveValidatedWebsiteTemplateSelection`, `works-template-catalog.service.ts` (upsert helper), `template-catalog.service.ts` (reuse upsert).
- [ ] P2-9 API e2e — `GET /api/work-templates` (+`?chipType=`) shape/`[]`; create-from-blueprint asserts the `works-blueprint:<slug>` row + `work.websiteTemplateId`.

---

## P3 — `/new` chips + custom merge + search-at-scale

- [ ] P3-1 `NewPageClient.tsx` — second, smaller template-chip line below the type chips, filtered by `chipType`, only when ≥1 blueprint; reuse `fetchWorkTemplateCatalog` from `/new/page.tsx`.
- [ ] P3-2 `/new` submit — carry chosen blueprint slug as `?template=<slug>` into `CHIP_TO_CANVAS_ROUTE` alongside `?mode=ai&kind=<workKind>` (reuse `initialTemplateId` plumbing).
- [ ] P3-3 Custom-first merge — `[...customRows, ...repoBlueprints]` deduped by id in both Create-Work surfaces; custom rows from `listTemplatesForUser('work'|'website', userId)`; group "Your templates" / "Blueprints".
- [ ] P3-4 Default preselection — honor `UserTemplatePreference` → blueprint `default:true` → `classic`.
- [ ] P3-5 Search-at-scale — autocomplete grouping, `featured` pinning, tag/category facets, dedupe + stable ordering, empty/loading states; verify against a large synthetic manifest.
- [ ] P3-6 Web e2e (PROD-web harness, environment-adaptive) — selector hidden for zero-blueprint chip; searchable for `directory`; custom template first; `/new` handoff carries `?template=`; fallback path when catalog is `[]`.

---

## Cross-cutting / gates

- [ ] G1 `pnpm type-check` (apps/web `**/*.ts` covers e2e) + `pnpm lint` green before any branch e2e dispatch.
- [ ] G2 Prettier: tabs width 4, single quotes, no trailing commas, kebab-case files.
- [ ] G3 Every failure path returns today's behavior (empty/unreachable manifest → classic/minimal via DB catalog) — assert in tests.
- [ ] G4 No entity/column/route/test-id removed or renamed; only the `templateSelector.label` i18n value changes.
- [ ] G5 Pin `EVER_WORKS_WORKS_REF` to a SHA/tag in the prod env before turning the manifest on.
