# Work Template Catalog — Implementation Plan

**Status:** Draft v1 · **Owner:** Product/Eng · **Date:** 2026-07-18
**Spec:** [spec.md](spec.md) · **Tasks:** [tasks.md](tasks.md)

> **Additive-only.** Every phase layers on top of shipped surfaces. Nothing is removed or renamed except the one requested i18n display value ("Website Template" → "Template"). Each phase is independently shippable and falls back to today's behavior if the catalog is unavailable.

The precedent being mirrored is the **agent-template catalog** (`apps/api/src/agents/agent-template-catalog.service.ts` + `agent-templates.controller.ts` + `agent-templates.server.ts`, registered in `agents.module.ts`). Read those three files before starting each backend/web task — they are the reference implementation.

---

## Phase 1 — Catalog service + endpoint + manifest consume

**Goal:** `GET /api/work-templates` serves sanitized, cached blueprints from `ever-works/works`. No UI change. Verifiable by curling the endpoint.

### 1.1 Repo: land `manifest.json` in `ever-works/works`

- Add `manifest.json` (`version: 1`, `generatedBy`, `blueprints[]`) with 3 production rows — `directory` → `ever-works/directory-web-template`, `directory-minimal` → `ever-works/directory-web-minimal-template`, `marketing-site` → `ever-works/ever-works-website-template` — plus `company`/`store` as `status: "placeholder"`, `template.repo: null`. Exactly one `default: true` per `chipType`.
- Add `schema/works-manifest.schema.json` (draft 2020-12; `required: [slug, name, title, summary, kind, chipType, status, template]`; `template.repo` pattern `^ever-works/[a-z0-9-]+$`).
- Add `scripts/build-manifest.mjs` + `.github/workflows/validate.yml` (schema-validate + `default`-uniqueness-per-`chipType` gate), mirroring the `agents`/`orgs` repos.

### 1.2 API: `WorksTemplateCatalogService`

- New `apps/api/src/works/works-template-catalog.service.ts`, cloned from `AgentTemplateCatalogService`. Copy verbatim: `SAFE_SLUG_RE`, `stripHtml`, `kebabToPascal`, `asStringArray`, `MAX_*` caps, the mutable-ref warning, the `warnedNoToken` one-shot log.
- Diverge on the read path: primary `fetch('https://raw.githubusercontent.com/ever-works/works/<ref>/manifest.json', { headers: { 'User-Agent': 'ever-works-platform' } })`; on non-2xx fall back to `git.getFileContent('ever-works', 'works', 'manifest.json', { token, providerId: 'github' }, ref)` with `token` from `git.getInstallationTokenForOwner('ever-works') ?? EVER_WORKS_WORKS_TOKEN ?? GITHUB_TOKEN`.
- `list(chipType?)`: cache key `work-templates:<ref>` (1h, `cache_entries` via `CACHE_MANAGER`), cache the full unfiltered list, filter by `chipType` in memory. Drop `placeholder`/null-repo rows and rows failing `SAFE_SLUG_RE` or the `template.repo` pattern. Map to `WorkBlueprintEntry`.
- Unit spec `works-template-catalog.service.spec.ts`, cloned from `agent-template-catalog.service.spec.ts`: no-manifest → `[]`, malformed → `[]`, XSS/HTML fields stripped, bad slug/repo dropped, `chipType` filter, cache hit, mutable-ref warning.

### 1.3 API: controller + module wiring

- `apps/api/src/works/work-templates.controller.ts` — `WorkTemplatesController`, `@Controller('api/work-templates')`, `@Get() @Public() @HttpCode(200)`, `@Query('chipType')`, `@ApiTags('Works')`.
- Register in `apps/api/src/works/works.module.ts`: add `WorksTemplateCatalogService` to `providers`, `WorkTemplatesController` to `controllers`. Confirm `GitFacadeService` + `CACHE_MANAGER` resolve in `WorksModule` scope (FacadesModule already imported transitively; add if missing).

### 1.4 Web: server fetch + fallback

- `apps/web/src/lib/api/work-templates.ts` — `WorkBlueprintEntry` type + `listBuiltinWorkBlueprints(chipType?)` (the `classic`/`minimal` pair typed as blueprints; isomorphic, no `server-only`).
- `apps/web/src/lib/api/work-templates.server.ts` (`server-only`) — `fetchWorkTemplateCatalog(chipType?)` → `serverFetch<WorkBlueprintEntry[]>('/work-templates?chipType=…')`, fallback to `listBuiltinWorkBlueprints`. Clone `agent-templates.server.ts`.

**Exit:** `curl /api/work-templates` and `?chipType=directory` return the expected rows; killing the manifest returns `[]`; unit spec green.

---

## Phase 2 — Chips + selector + rename on Create-Work-Manually

**Goal:** `/works/new` → "Create Work Manually" shows a type-chip-filtered, searchable "Template" selector; picking one creates a Work from that blueprint.

### 2.1 i18n rename

- Add `dashboard.templateSelector.label` = `"Template"` and `dashboard.templateSelector.searchPlaceholder` to `apps/web/messages/en.json` and every locale file.
- `WebsiteTemplateSelector.tsx`: default `label` reads `t('label')` instead of the literal `'Website Template'`. No prop/test-id change.

### 2.2 chipType lookup + filter + visibility rule

- Add the chip-value → `chipType` map next to `WORK_KIND_ORDER` (and reuse on `/new` in P3).
- Compute the filtered blueprint list for `effectiveKind`; only render the selector line when the list is non-empty.

### 2.3 Searchable selector

- Replace the native `<Select>` inside `WebsiteTemplateSelector.tsx` with a shadcn `Command`-in-`Popover` combobox filtering on `name`/`tags`/`category`, `featured` first. Preserve the "inherited default / pinned" status card, origin badge, `resolveWebsiteTemplateSelection`, and all `data-testid`s. Keep `value` = blueprint `slug`, `onChange(value)` unchanged.

### 2.4 Wire WorkAICreator + create mapping

- `/works/new/page.tsx`: also fetch `fetchWorkTemplateCatalog()` (unfiltered) and pass to `new-work-client.tsx` → `WorkAICreator`. Filter client-side by the selected kind.
- `WorkAICreator`: feed the chip-filtered + custom-merged (P3) list to the selector; keep binding `formData.websiteTemplateId`.
- Backend create mapping (§5.1–5.2): in `resolveValidatedWebsiteTemplateSelection` / the catalog service, when the id is a blueprint slug not yet in `templates`, upsert it as a `built_in` row `works-blueprint:<slug>` (kind `website`, repo coords + ref from the blueprint) so `getVisibleTemplateForUser` resolves it. Pre-fill provider/organization selectors from `blueprint.defaults` in `WorkAICreator` (user choice + saved defaults still win via `resolveProviderDefaults`).

**Exit:** manual create with a picked blueprint forks the right repo and stands up the Work; selector hidden for chips with zero blueprints; label reads "Template".

---

## Phase 3 — `/new` chips + custom merge + search-at-scale

**Goal:** the unified `/new` page gets a second template-chip line; custom templates lead the list everywhere; the selector holds up at hundreds.

### 3.1 `/new` second chip line

- `NewPageClient.tsx`: below the existing `PromptChipsRow`, add a smaller secondary template line (chips or the horizontally-scrollable strip) filtered by the selected chip's `chipType`, only when ≥1 blueprint. Reuse `fetchWorkTemplateCatalog` from `/new/page.tsx`.
- On submit for a work-kind chip, carry the chosen blueprint slug as `?template=<slug>` into `CHIP_TO_CANVAS_ROUTE` alongside `?mode=ai&kind=<workKind>` (reuse the existing `initialTemplateId` plumbing).

### 3.2 Custom-first merge

- Server-merge `[...customRows, ...repoBlueprints]` deduped by id in both Create-Work surfaces; custom rows from `listTemplatesForUser('work'|'website', userId)`. Group "Your templates" / "Blueprints"; preselect honoring `UserTemplatePreference` → blueprint `default` → `classic`.

### 3.3 Search-at-scale hardening

- Autocomplete grouping, `featured` pinning, tag/category facets, dedupe + stable ordering for 100s of blueprints; empty/loading states.

**Exit:** `/new` template line works and hands off to `/works/new`; custom templates appear first; selector is usable with a large synthetic manifest.

---

## Testing

- **API unit:** `works-template-catalog.service.spec.ts` (clone the agent spec) — failure→`[]`, sanitize, filter, cache, ref warning.
- **API e2e:** `GET /api/work-templates` (200 + shape + `chipType` filter + `[]` when unavailable), and a create-from-blueprint flow asserting the `works-blueprint:<slug>` row upsert + `work.websiteTemplateId`.
- **Web e2e (Playwright, PROD-web harness):** selector hidden for zero-blueprint chip; visible + searchable for `directory`; custom template listed first; `/new` template line handoff carries `?template=`. Environment-adaptive (catalog may be `[]` in CI) — assert the fallback path too.
- **tsc gate:** `apps/web` `**/*.ts` covers e2e; run `pnpm type-check` before dispatch.

## Rollout / flags

- No new user-facing flag required; the feature is invisible until the manifest has blueprints. `EVER_WORKS_WORKS_REF` defaults to `main` — pin to a SHA/tag in prod env before enabling.
- Fully backward compatible: with an empty/unreachable manifest, both Create-Work surfaces behave exactly as today (classic/minimal via the DB catalog).
