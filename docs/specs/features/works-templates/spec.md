# Work Template Catalog — Product Spec

**Status:** Draft v1 · **Owner:** Product · **Date:** 2026-07-18
**Audience:** Product, Engineering (backend + frontend), Design
**Internal codename:** "Works blueprints"
**Related code today:**

- Shipped catalog precedent to mirror — the agent-template catalog: [`agent-template-catalog.service.ts`](../../../../apps/api/src/agents/agent-template-catalog.service.ts) (reads `manifest.json` from an `ever-works/*` repo, maps to a stable web DTO, caches 1h in the `cache_entries` store, sanitizes every field, returns `[]` on any failure), [`agent-templates.controller.ts`](../../../../apps/api/src/agents/agent-templates.controller.ts) (`GET /api/agent-templates?entity=`, `@Public()`), web server-only fetch-with-fallback [`agent-templates.server.ts`](../../../../apps/web/src/lib/api/agent-templates.server.ts), registered in api-side [`agents.module.ts`](../../../../apps/api/src/agents/agents.module.ts)
- Hardcoded website-template list to EXTEND (not remove): [`website-template.config.ts`](../../../../packages/agent/src/generators/website-generator/config/website-template.config.ts) — `WEBSITE_TEMPLATES[]` (`classic` → `ever-works/directory-web-template`, `minimal` → `ever-works/directory-web-minimal-template`), `DEFAULT_WEBSITE_TEMPLATE_ID = 'classic'`
- Pure-static mission catalog (same pattern, no discovery): [`mission-template.config.ts`](../../../../packages/agent/src/missions/mission-template.config.ts)
- DB-driven template catalog (built-in seed + user custom + org discovery): [`template-catalog.service.ts`](../../../../packages/agent/src/template-catalog/template-catalog.service.ts) — `listTemplatesForUser(kind, userId)`, `getVisibleTemplateForUser`, `syncDiscoveredWebsiteTemplatesForUser` (already fetches an org's `*template` repos and upserts them as `built_in website` rows)
- `Template` entity: [`template.entity.ts`](../../../../packages/agent/src/entities/template.entity.ts) — `kind: 'website' | 'work' | 'mission' | 'company'`, `sourceType: 'built_in' | 'custom'`, `ownerUserId`, repo coords, Tier-A `tenantId`/`organizationId` scope columns (EW-655)
- Create-Work resolution: [`work-lifecycle.service.ts`](../../../../packages/agent/src/services/work-lifecycle.service.ts) `createWork` (L223) → `resolveValidatedWebsiteTemplateSelection` (L163) → `getVisibleTemplateForUser('website', id, userId)`; generation-time resolver [`website-template-resolver.service.ts`](../../../../packages/agent/src/generators/website-generator/website-template-resolver.service.ts) `resolveForWork`; fork/clone [`website-generator.service.ts`](../../../../packages/agent/src/generators/website-generator/website-generator.service.ts) `duplicate` (L90)
- Existing website-templates endpoint: [`works.controller.ts`](../../../../apps/api/src/works/works.controller.ts) `GET /works/website-templates` (L281)
- Type-chip UIs to EXTEND: `/works/new` [`new-work-client.tsx`](<../../../../apps/web/src/app/[locale]/(dashboard)/works/new/new-work-client.tsx>) (`WORK_KIND_ORDER`, `WorkAICreator` selector), unified `/new` [`NewPageClient.tsx`](../../../../apps/web/src/components/new/NewPageClient.tsx) (`CHIP_ORDER`), selector [`WebsiteTemplateSelector.tsx`](../../../../apps/web/src/components/works/shared/WebsiteTemplateSelector.tsx), web DTO [`work.ts`](../../../../apps/web/src/lib/api/work.ts) `WebsiteTemplateOption`
- Companion research notes: [`7f-works-templates.md`](../../../../../../../Users/evere/AppData/Local/Temp/claude/C--Coding/2c4e74a9-7816-4d68-8bfb-780c96ed35e8/scratchpad/7f-works-templates.md), [`7f-works-repo.md`](../../../../../../../Users/evere/AppData/Local/Temp/claude/C--Coding/2c4e74a9-7816-4d68-8bfb-780c96ed35e8/scratchpad/7f-works-repo.md)

> **Scope of this document:** product behavior — the Work-blueprint catalog fed from the `ever-works/works` repo, the type chips that filter it, the selector that scales to hundreds of blueprints, and how a picked blueprint becomes a Work. Implementation phasing lives in [plan.md](plan.md); the task checklist in [tasks.md](tasks.md).
>
> **Hard rule (additive by default):** This feature **EXTENDS**, it removes and renames nothing internal. No entity, column, DB table, API route, component name, or `data-testid` is dropped or renamed. The `ever-works/works` manifest becomes an **additional** catalog source layered on top of the existing hardcoded `WEBSITE_TEMPLATES` seed + the DB `templates` table + user custom templates — exactly as the shipped agent-template catalog layers on top of the web app's built-in agent list. Every failure path falls back to what ships today, so a cold, rate-limited, or unreachable catalog never breaks Work creation. The ONE deliberate user-facing copy change — "Website Template" → "Template" — is an i18n message-value edit only (explicitly requested; §4.1), touching no key names, no entity names, no test ids.

---

## 0. TL;DR

We turn the `ever-works/works` GitHub repo into the canonical, release-decoupled index of **Work blueprints** (a directory site, a landing page, a blog, a store, …). A new `WorksTemplateCatalogService` reads that repo's `manifest.json` (tokenless, public), caches it 1h, sanitizes it, and serves it at `GET /api/work-templates`. The Create-Work flows gain a small **template chip row** that filters blueprints by the type chip already selected, and a **searchable selector built for hundreds** of entries. The user's own custom `Template` rows sit **first**, ahead of the repo blueprints. Picking a blueprint forks its upstream template repo and creates the Work with the blueprint's provider/kind/organization defaults — reusing the entire shipped `createWork` → website-template-resolver → `duplicate()` chain.

```
                         ever-works/works  (PUBLIC repo, index-only today)
                         └── manifest.json  { blueprints: [ { slug, chipType, template.repo, defaults, … } ] }
                                    │  tokenless raw.githubusercontent.com read, pinned by EVER_WORKS_WORKS_REF
                                    ▼
   apps/api  WorksTemplateCatalogService ──(1h cache_entries, sanitize, []-on-fail)──► GET /api/work-templates?chipType=
                                    │
                                    ▼  server-only fetch + built-in fallback (mirrors agent-templates.server.ts)
   apps/web  ── type chip (Website│Landing│Blog│Directory│Store│Company│Awesome) filters by chipType ──┐
                                    │                                                                    │
             CUSTOM Template rows (kind work/website, sourceType custom)  ──merged FIRST──►  [ your templates | repo blueprints ]
                                    │                                                          searchable / horizontally-scrollable
                                    ▼                                                          (only shown when chip has ≥1 blueprint)
             pick blueprint ──► CreateWorkDto { websiteTemplateId=slug, gitProvider, deployProvider, organization } ──► createWork()
                                    └── forks blueprint.template.repo via the existing website-template-resolver → duplicate()
```

Existing users, existing Works, and the two hardcoded `classic`/`minimal` templates keep working with zero change. The manifest is purely additive discovery on top.

---

## 1. Concepts

### 1.1 Work blueprint

A **blueprint** is one row in the `ever-works/works` `manifest.json` `blueprints[]` array. It is a _pointer_ to a standalone, fork-ready template code repo (e.g. `ever-works/directory-web-template`) plus the wizard defaults for standing up a Work from it. Unlike the `agents`/`orgs` catalogs, which vendor the template body inside the catalog repo, `works` references template bodies **out** to separate repos — mirroring the mission-template precedent (`mission-template.config.ts` lists fork-from repos), not the vendored-body precedent. This keeps the platform's blueprint list changeable without a platform release (ADR-014, "no hardcoded catalogs").

### 1.2 chipType — the filtering facet

Every blueprint declares a `chipType` naming which **type chip** it belongs under. The type chips already exist in the Create-Work UIs as _work-kind_ selectors; a blueprint's `chipType` is what ties a blueprint to the chip the user has selected:

| chipType    | Type chip today (`WORK_KIND_ORDER` / `CHIP_ORDER`) | Status                           |
| ----------- | -------------------------------------------------- | -------------------------------- |
| `website`   | Website                                            | live                             |
| `landing`   | Landing Page (`landing-page`)                      | live                             |
| `blog`      | Blog                                               | live                             |
| `directory` | Directory                                          | live                             |
| `store`     | Store                                              | coming-soon (flag `works-store`) |
| `company`   | Company                                            | live on `/new` (EW-662)          |
| `awesome`   | Awesome Repo (`awesome-repo`)                      | live                             |

> `chipType` values are the manifest's own short slugs (`landing`, `awesome`); the platform maps them to the existing chip values (`landing-page`, `awesome-repo`) with a single lookup table (§4.2). We do **not** rename the chip values.

The rule the UI enforces: **the template selector line is shown only when the selected chip resolves to ≥1 blueprint.** A chip with zero blueprints (e.g. `store`/`company` before their template repos are public) renders the chip normally but omits the selector line — no empty dropdown, no dead affordance.

### 1.3 Catalog sources, in precedence order

For a given chip, the visible template list is the **merge** of three sources, deduped by id, in this order:

1. **The user's own custom `Template` rows** — `kind IN ('work','website')`, `sourceType = 'custom'`, `ownerUserId = user.id` — shown **first** as the natural default (§4.5).
2. **Repo blueprints** from the `ever-works/works` manifest, filtered to the chip's `chipType`.
3. **The hardcoded built-in seed** (`WEBSITE_TEMPLATES` → `classic`, `minimal`) as the always-present fallback, so the list is never empty for `website`/`directory` even if the manifest is unreachable.

The **preselected default** is: the user's per-kind `UserTemplatePreference` default if set → else the blueprint flagged `default: true` for that chip → else `classic`.

### 1.4 What is NOT introduced

- **No new entity, no new table, no migration.** Blueprints are read-only manifest data. When a blueprint needs to participate in the existing generation-time fork path, it is upserted into the **existing** `templates` table as a `built_in` row (kind `website`/`work`) — the same mechanism `syncDiscoveredWebsiteTemplatesForUser` already uses for org-discovered repos (§5.3). No schema change: `templates` already carries every column a blueprint needs, including the Tier-A `tenantId`/`organizationId` scope columns.

---

## 2. Data model

### 2.1 `ever-works/works` manifest (source of truth, repo-side)

The repo is index-only today (just `LICENSE` + `README.md`). This spec defines the `manifest.json` it must land, matching the `agents`/`orgs` catalog governance (`$schema` + `version` + `generatedBy` header, a `schema/works-manifest.schema.json` draft-2020-12 schema, a `scripts/build-manifest.mjs`, and a `.github/workflows/validate.yml` gate). Shape:

```jsonc
{
	"$schema": "./schema/works-manifest.schema.json",
	"version": 1,
	"generatedBy": "scripts/build-manifest.mjs",
	"blueprints": [
		{
			"slug": "directory", // ^[a-z0-9][a-z0-9-]{1,60}$, globally unique
			"name": "Directory", // selector label
			"title": "Directory Website", // full card title
			"summary": "Next.js directory with categories, search, submissions.",
			"kind": "directory", // maps to the chip value / Work intent
			"chipType": "directory", // the filtering facet (§1.2)
			"category": "web", // coarse search facet
			"tags": ["nextjs", "directory", "seo"], // search-friendly, maxItems 8
			"isOrganization": false, // → CreateWorkDto.organization
			"default": true, // exactly one default per chipType
			"featured": true,
			"status": "production", // production | beta | placeholder
			"avatarIcon": "folder-tree", // Lucide id (kebab → Pascal on consume)
			"template": {
				"repo": "ever-works/directory-web-template", // fork source
				"ref": "develop", // branch, OR
				"sha": null, //   pinned commit (sha wins if set)
				"isGitHubTemplate": true
			},
			"defaults": {
				"gitProvider": "github",
				"storageProvider": "s3",
				"deployProvider": "ever-works",
				"suggestedAgents": ["starter-curator"],
				"suggestedMission": "populate-directory"
			},
			"blueprintPath": "blueprints/directory/blueprint.yml",
			"readmePath": "blueprints/directory/README.md"
		}
		// directory-minimal, marketing-site (production); company, store (placeholder)
	]
}
```

Schema notes: `required: [slug, name, title, summary, kind, chipType, status, template]`; `template.repo` pattern `^ever-works/[a-z0-9-]+$`; `status: "placeholder"` permits `template.repo: null` so `company`/`store` rows can land before their repos are public (the API filters `placeholder`/null-repo rows out of the production catalog); `default: true` uniqueness per `chipType` is enforced by the build/validate script, not JSON Schema.

### 2.2 API response DTO (`WorkBlueprintEntry`)

The service maps each sanitized manifest row to a stable, narrow web DTO — the mirror of `AstTemplateEntry`. Lives in `apps/api/src/works/works-template-catalog.service.ts` and re-declared web-side in `apps/web/src/lib/api/work-templates.ts`:

```ts
export interface WorkBlueprintEntry {
	slug: string; // stable id; becomes CreateWorkDto.websiteTemplateId
	name: string;
	description: string; // from manifest `summary`
	chipType: string; // website | landing | blog | directory | store | company | awesome
	kind: string; // chip value / Work intent (landing-page, awesome-repo, …)
	category?: string;
	iconName?: string; // PascalCase Lucide id
	tags?: string[];
	isDefault: boolean; // manifest `default: true`
	featured: boolean;
	// resolution coordinates — consumed only server-side at create time (§5)
	templateRepoOwner: string; // parsed from template.repo
	templateRepoName: string;
	templateRef: string | null; // sha ?? ref
	isOrganization: boolean;
	gitProvider?: string;
	storageProvider?: string;
	deployProvider?: string;
}
```

### 2.3 Reuse of the `templates` table (no migration)

When a blueprint is first _used_ to create a Work (§5), it is upserted into the existing `templates` table as a deterministic `built_in` row with `id = works-blueprint:<slug>` (namespaced so it never collides with `custom-<uuid>` or the `classic`/`minimal` ids), `kind` = `website` (or `work` for non-website shapes), repo coords from the blueprint, `metadata.worksBlueprintSlug = slug`, `metadata.origin = 'works-manifest'`. This is exactly the shape `toBuiltInWebsiteTemplateRecord` / the discovery upsert already write, so the shipped `getVisibleTemplateForUser` + `website-template-resolver` + `duplicate()` chain resolves it unchanged. `tenantId`/`organizationId` follow the EW-655 Tier-A convention (NULL until the user has an Org; stamped on the created **Work**, not on the shared built-in template row).

---

## 3. API surface

### 3.1 `WorksTemplateCatalogService` (apps/api)

New service at `apps/api/src/works/works-template-catalog.service.ts`, a near-clone of `AgentTemplateCatalogService` with one deliberate divergence: **`ever-works/works` is public, so the primary read is tokenless.**

- **Read path:** fetch `manifest.json` from `https://raw.githubusercontent.com/ever-works/works/<ref>/manifest.json` with a plain `fetch` (no auth header) and a real `User-Agent` (the `api.ever.works` CF-proxy 403s empty UAs; the raw host does not, but we send one anyway for parity and rate-limit etiquette). Parse `{ blueprints: RawBlueprint[] }`.
    - **Fallback for rate limits / future private repo:** if the tokenless read returns non-2xx, fall through to `GitFacadeService.getFileContent('ever-works', 'works', 'manifest.json', { token, providerId: 'github' }, ref)` where `token` is resolved via `git.getInstallationTokenForOwner('ever-works')` → `EVER_WORKS_WORKS_TOKEN` → `GITHUB_TOKEN` (same priority as the agent service `resolveToken`). Still `[]` on total failure.
- **Ref pin:** `EVER_WORKS_WORKS_REF` (default `main`). Warn once (Logger) when the ref is a mutable branch (not a 40-hex SHA or `vX.Y.Z` tag) — copied verbatim from the agent service's supply-chain-substitution warning.
- **Cache:** `@Inject(CACHE_MANAGER) Cache` from `@ever-works/agent/cache`, key `work-templates:<ref>` (and `work-templates:<chipType>:<ref>` for filtered reads, or filter in-memory off the unfiltered cache — prefer the latter to keep one cache entry), TTL `60 * 60 * 1000` ms, in the shared `cache_entries` store. Only cache non-empty results, so a transient failure doesn't pin `[]` for an hour.
- **Sanitize (reused verbatim from the agent service):** `SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/` rejects bad `slug`/`chipType`/`kind`; `stripHtml()` + `MAX_TITLE_LEN`/`MAX_DESC_LEN`/`MAX_TAG_LEN` caps on every string field; `kebabToPascal()` for `avatarIcon`; drop any row whose `template.repo` fails `^ever-works/[a-z0-9-]+$` (SSRF guard — we only ever fork from the `ever-works` org); drop `status: 'placeholder'` / null-repo rows from the served catalog.
- **Signature:** `list(chipType?: string): Promise<WorkBlueprintEntry[]>` — no `chipType` returns the full catalog; a `chipType` returns the filtered slice.

### 3.2 Controller — `GET /api/work-templates`

New `WorkTemplatesController` at `apps/api/src/works/work-templates.controller.ts`, mirroring `AgentTemplatesController`:

```
GET /api/work-templates            → all blueprints
GET /api/work-templates?chipType=directory → blueprints for that chip
```

- `@Public()` — the catalog is non-sensitive, read-only, and consumed by web server components. Returns `[]` (never an error) when the catalog is unavailable.
- `@HttpCode(HttpStatus.OK)`, `@ApiTags('Works')`.
- Registered in [`works.module.ts`](../../../../apps/api/src/works/works.module.ts) (`providers: [… WorksTemplateCatalogService]`, `controllers: [… WorkTemplatesController]`). `GitFacadeService` (via the already-imported facades) and `CACHE_MANAGER` are in scope there.

> This is a **new, additive** endpoint. The existing `GET /works/website-templates` (DB-driven, per-user, auth-scoped) is untouched and keeps serving the current selector. §5.4 describes how the two reconcile.

### 3.3 Web fetch — server-only with fallback

Mirror `agent-templates.server.ts` exactly:

- `apps/web/src/lib/api/work-templates.server.ts` (`server-only`): `fetchWorkTemplateCatalog(chipType?)` calls `serverFetch<WorkBlueprintEntry[]>('/work-templates?chipType=…')`; on any throw or empty array, falls back to `listBuiltinWorkBlueprints(chipType)` — a tiny isomorphic built-in list (the `classic`/`minimal` pair typed as blueprints) in `apps/web/src/lib/api/work-templates.ts` — so the chips + selector never render empty.
- The Create-Work server pages (`/works/new/page.tsx`, `/new/page.tsx`) call it and pass the result down, exactly as `websiteTemplates` is passed today.

---

## 4. Web UI

### 4.1 Rename "Website Template" → "Template" (i18n values only)

The label is a hardcoded English default on the selector component (`WebsiteTemplateSelector.tsx` `label = 'Website Template'`), not currently an i18n key. The rename:

1. Add `dashboard.templateSelector.label` = `"Template"` to `apps/web/messages/en.json` (and each locale file), plus `dashboard.templateSelector.searchPlaceholder` for the new searchable input (§4.4).
2. Change the component default to read `t('label')` instead of the literal `'Website Template'`. `WorkAICreator` already passes no `label` prop, so it picks up the i18n value automatically.

This changes **only displayed strings**. No key names, entity names, route names, or `data-testid`s change. This is the one copy change the additive rule explicitly permits because the task requests it.

### 4.2 Type chips filter blueprints by `chipType`

The type chips already exist and are **not modified structurally** — we only add filtering behavior driven off the current selection:

- A single lookup maps chip value → manifest `chipType`: `{ website:'website', 'landing-page':'landing', blog:'blog', directory:'directory', 'awesome-repo':'awesome', store:'store', company:'company' }` (lives beside the chip arrays).
- The blueprint list handed to the selector is `blueprints.filter(b => b.chipType === chipTypeOf(effectiveKind))`.
- **Selector visibility rule:** render the template selector line **only when that filtered list has ≥1 entry.** Zero → no selector (chip still works; the Work is created from the default/fallback template). This is what lets `store`/`company` (no blueprints yet) render as chips without an empty selector.

### 4.3 Create-Work-Manually flow (`/works/new` → `WorkAICreator`)

The "Create Work Manually" button sets `creationMode='manual'`, which renders `WorkAICreator` (the manual + AI flows are unified today). Changes there:

- Feed the selector the **chip-filtered** blueprint list (from `fetchWorkTemplateCatalog`, merged with custom rows §4.5) instead of the flat `websiteTemplates` array.
- Keep the selector bound to `formData.websiteTemplateId` (the value is the blueprint `slug`) — no DTO change (§5.1).
- Show the selector only when the filtered list is non-empty (§4.2).

### 4.4 Selector built for hundreds

The current selector is a native `<Select>` (`WebsiteTemplateSelector.tsx`) — fine for 2 entries, unusable at 100s. Replace the picker control (not the component, not its test ids) with one of:

- **(a) Searchable combobox / autocomplete** — a shadcn `Command` inside a `Popover` (the same primitive the WorkspaceSwitcher uses), filtering on `name` + `tags` + `category`, grouped "Your templates" / "Blueprints", `featured` pinned to the top. **Recommended** — scales cleanly, keyboard-first.
- **(b) Horizontally-scrollable chip/card row** — a `overflow-x-auto` strip of blueprint cards (icon + name), good default pre-selected. Better for browsing a small-but-growing set; degrades past ~30.

v1 ships **(a)** as the primary (it is the one that survives hundreds), with the good default from §1.3 preselected so a user who ignores it still gets a sane template. The existing "inherited default / pinned" status card and origin badge are preserved.

### 4.5 Custom templates first

The user's own `Template` rows are the natural default and must lead the list:

- Server-side, the merged list is `[...customRows, ...repoBlueprints]` deduped by id, where `customRows` come from the existing per-user catalog (`templatesAPI.list({ kind: 'work' })` / `'website'` → `listTemplatesForUser`, which already returns the user's `sourceType:'custom'` rows). Custom rows are tagged `originType: 'forked' | 'custom_url'` (already on `WebsiteTemplateOption`) so the selector groups them under "Your templates".
- The preselected default honors `UserTemplatePreference` first (§1.3), so a user who set a default custom template keeps it.
- Read how custom templates work today: the `Templates` dashboard page (`/templates`, kind toggle website/work/mission) → `TemplatesCatalog` → `templatesAPI` → `POST /templates/custom` (add from GitHub URL), `POST /templates/fork`, `PUT /templates/default`. Nothing there changes; we only _read_ those rows into the Create-Work selector.

### 4.6 `/new` page — second chip line

On the unified `/new` page (`NewPageClient.tsx`), below the existing type-chip row (`PromptChipsRow`), add a **second, smaller** `PromptChipsRow` (or the §4.4 horizontally-scrollable strip) of **template chips** for the currently-selected type chip:

- Same filtering as §4.2 — only rendered when the selected chip has ≥1 blueprint (Mission/Idea/Agent/Task chips never show it).
- Selecting a template chip stashes the blueprint `slug`; when the chip submit forwards to `/works/new` (the existing `CHIP_TO_CANVAS_ROUTE` path), carry the slug as `?template=<slug>` alongside `?mode=ai&kind=<workKind>` so `WorkAICreator` opens with that blueprint preselected. (`/new` already threads `initialTemplateId` for the Mission path — reuse the same query param plumbing.)
- Visual weight: the template line is secondary (smaller text, muted), clearly subordinate to the type chips.

---

## 5. Blueprint → Work creation

### 5.1 The mapping

Picking a blueprint produces a `CreateWorkDto` — **no new fields**, reusing what exists ([`work.ts`](../../../../apps/web/src/lib/api/work.ts) `CreateWorkDto`):

| Blueprint field            | CreateWorkDto / Work field                                |
| -------------------------- | --------------------------------------------------------- |
| `slug`                     | `websiteTemplateId` (the id the resolver looks up)        |
| `defaults.gitProvider`     | `gitProvider`                                             |
| `defaults.storageProvider` | storage provider (resolved via `resolveProviderDefaults`) |
| `defaults.deployProvider`  | `deployProvider`                                          |
| `isOrganization`           | `organization` (boolean)                                  |
| `kind`                     | Work intent / prompt hint (carried as the chip `kind`)    |
| `template.repo` + `ref`    | fork source — see §5.2                                    |

The blueprint's provider defaults are **suggestions**: they pre-fill the provider selectors (`GitProviderSelector`/`DeployProviderSelector`) but the user's explicit choice and their saved defaults (`resolveProviderDefaults`) still win. Work entity stays the source of truth (per the manifest's own contract).

### 5.2 Fork the upstream template repo (reuses the shipped chain)

`createWork` persists `work.websiteTemplateId = blueprint.slug`, validated by `resolveValidatedWebsiteTemplateSelection` → `getVisibleTemplateForUser('website', slug, userId)`. For that lookup to succeed, the blueprint must exist as a `templates` row — so **the first time a blueprint slug is validated, the `WorksTemplateCatalogService` upserts it into the `templates` table** as the `built_in` row described in §2.3 (id `works-blueprint:<slug>`). From there the existing generation-time path is unchanged:

`website-template-resolver.service.resolveForWork(work)` → catalog row (kind `website`, active) wins → returns `{ owner, repo, branch }` from the blueprint's `template.repo` + `templateRef` → `website-generator.service.duplicate()` clones `owner/repo @ ref`, creates the target repo, pushes. `template.isGitHubTemplate` can later select a true GitHub _template-generate_ over a plain clone; v1 uses the existing clone path.

> **Why upsert into `templates` rather than plumb repo coords through `createWork`:** it is the smallest, most additive change — the shipped resolver already reads the `templates` table and already has an upsert path for discovered repos. We add one more source feeding that same table. No new resolution branch, no new column, no touch to `duplicate()`.

### 5.3 Precedent: this is the org-discovery mechanism, generalized

`syncDiscoveredWebsiteTemplatesForUser` already lists an org's `*template` repos and upserts them as `built_in website` rows on a 1h TTL. The blueprint upsert is the same move sourced from a curated manifest instead of a repo-name-pattern scan — strictly more precise (explicit `slug`, `chipType`, `default`, provider defaults) and not limited to repos whose name ends in `template`.

### 5.4 Reconciling the two endpoints

- `GET /works/website-templates` (existing, auth, DB-driven) stays the **authoritative per-user list** for the selector's custom-row merge and default resolution.
- `GET /api/work-templates` (new, public, manifest-driven) is the **blueprint discovery** source, filtered by `chipType`.
- The web selector merges them (§4.5). Over time the manifest can supersede the hardcoded `WEBSITE_TEMPLATES` seed, but that seed stays as the offline fallback — never removed.

### 5.5 Hardcoded lists to EXTEND (not delete)

| Location                                                                   | Today                                    | Change                                                                                      |
| -------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `website-template.config.ts` `WEBSITE_TEMPLATES` / `DEFAULT_..._ID`        | `classic`, `minimal`, default `classic`  | Keep as offline fallback + built-in fallback list for the web `listBuiltinWorkBlueprints`.  |
| `mission-template.config.ts`                                               | 2 static mission templates, no discovery | Out of scope here; noted as the sibling that a future `missions` manifest could replace.    |
| `new-work-client.tsx` `WORK_KIND_ORDER` / `NewPageClient.tsx` `CHIP_ORDER` | hardcoded chip arrays                    | Unchanged — chips stay; we only add a `chipType` lookup + a filtered template line beneath. |

---

## 6. Plugin points

- **Git provider (existing):** the fork/clone runs through `GitFacadeService` → the active git-provider plugin (`github` default). Blueprints only ever reference `ever-works/*` repos (SSRF-guarded), so the fork source is trusted.
- **Future — manifest as a plugin-contributed source:** the `WorksTemplateCatalogService` reads a single well-known repo in v1. A later iteration could let a first-party plugin contribute additional blueprint manifests (e.g. an enterprise catalog), merged with the same sanitize + dedupe rules. Out of scope for v1; the `list()` signature (returning a merged array) leaves room.
- **No new plugin contract** is introduced by this feature.

---

## 7. Security

- **Tokenless public read, but still guarded.** The manifest is read from `raw.githubusercontent.com` without credentials. Every consumed field is sanitized exactly as the agent catalog does: `SAFE_SLUG_RE` allowlist, `stripHtml`, length caps, `kebabToPascal` for icons. A compromised/forked manifest cannot inject XSS into the web frontend or smuggle an arbitrary id.
- **SSRF / fork-source containment.** `template.repo` must match `^ever-works/[a-z0-9-]+$`; rows failing it are dropped. We never fork from a repo the manifest names outside the `ever-works` org, so a hostile manifest cannot make the platform clone attacker-controlled code.
- **Supply-chain pinning.** `EVER_WORKS_WORKS_REF` should be a commit SHA or `vX.Y.Z` tag in production; the service warns on a mutable branch ref (post-cache-expiry substitution risk), matching the agent-service warning.
- **Cache poisoning bounded.** Only non-empty, sanitized results are cached; TTL 1h; a transient bad read never pins bad data. The cache key includes the ref so a ref change invalidates cleanly.
- **Custom-template ownership.** The custom rows merged into the selector come from `listTemplatesForUser(kind, userId)` / `getVisibleTemplateForUser`, which already scope to the calling user — no cross-user template leakage. The public `/api/work-templates` endpoint serves only the org-curated manifest, never any user's custom rows.
- **No secrets in the public path.** The tokenless read sends no auth; the optional GitFacade fallback uses the platform GitHub App installation token or an env token, never a user token.

---

## 8. Naming

| Concern                   | Name                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------- |
| API service               | `WorksTemplateCatalogService` (`apps/api/src/works/works-template-catalog.service.ts`) |
| API controller / route    | `WorkTemplatesController` → `GET /api/work-templates?chipType=`                        |
| API DTO                   | `WorkBlueprintEntry`                                                                   |
| Web server fetch          | `fetchWorkTemplateCatalog` (`work-templates.server.ts`, `server-only`)                 |
| Web isomorphic fallback   | `listBuiltinWorkBlueprints` (`work-templates.ts`)                                      |
| Env — ref pin             | `EVER_WORKS_WORKS_REF` (default `main`)                                                |
| Env — optional repo/token | `EVER_WORKS_WORKS_REPO` (default `ever-works/works`), `EVER_WORKS_WORKS_TOKEN`         |
| `templates` row id prefix | `works-blueprint:<slug>`                                                               |
| i18n label                | `dashboard.templateSelector.label` = `"Template"`                                      |

> **Note on the mirrored precedent:** the task brief names an "OrgTemplateCatalogService" to mirror; no service by that name is shipped. The actual shipped catalog-service pattern is `AgentTemplateCatalogService` (agent/skill/task) — this spec mirrors that one and diverges only where the task specifies (public repo → tokenless raw read). Named `WorksTemplateCatalogService` for the Works domain.

---

## 9. Phasing

### P1 — Catalog service + endpoint + manifest consume (backend only)

- Land `manifest.json` + `schema/works-manifest.schema.json` + `scripts/build-manifest.mjs` + `.github/workflows/validate.yml` in `ever-works/works` (3 production blueprints: `directory`, `directory-minimal`, `marketing-site`; `company`/`store` as `placeholder`).
- `WorksTemplateCatalogService` (tokenless raw read, GitFacade fallback, 1h cache, sanitize, ref-pin warning) + `WorkTemplatesController` (`GET /api/work-templates?chipType=`) + module wiring + unit spec (clone `agent-template-catalog.service.spec.ts`).
- Web `work-templates.server.ts` + `work-templates.ts` fallback. No UI change yet — verifiable via the endpoint.

### P2 — Chips + selector + rename on Create-Work-Manually

- i18n rename "Website Template" → "Template" (§4.1).
- `chipType` lookup + filter (§4.2); selector-visibility rule (§4.2).
- Searchable selector (§4.4a) replacing the native `<Select>` picker in `WebsiteTemplateSelector.tsx`, preserving test ids + status card.
- Wire `WorkAICreator` (Create-Work-Manually) to the chip-filtered blueprint list.
- Blueprint → Work create mapping (§5.1–5.2): upsert-on-validate into `templates`, `websiteTemplateId = slug`, provider/organization defaults pre-fill.

### P3 — `/new` chips + custom merge + search-at-scale

- Second template-chip line on `NewPageClient.tsx` (§4.6) with the `?template=<slug>` handoff to `/works/new`.
- Custom-template-first merge (§4.5) in both Create-Work surfaces, honoring `UserTemplatePreference`.
- Search/autocomplete grouping ("Your templates" / "Blueprints"), `featured` pinning, and dedupe hardening for the hundreds-of-blueprints case.

---

## 10. Open questions

1. **Chip vs. `kind` granularity.** A `chipType` can host several `kind`s (e.g. a "website" chip with `marketing-site` + `portfolio` blueprints). Is one chip → many blueprints the whole story, or do we also want a blueprint to override the chip's placeholder prompt text? (Leaning: blueprint can optionally carry `placeholderExamples`; deferred.)
2. **When to upsert the blueprint row.** On first _validate_ (lazy, at create time — §5.2) vs. an eager 1h sync like `syncDiscoveredWebsiteTemplatesIfStale`. Lazy is less code and avoids writing rows for never-used blueprints; eager makes the `/templates` page show blueprints too. (Leaning: lazy for v1, revisit if the Templates page should list blueprints.)
3. **`isGitHubTemplate` generate vs. clone.** v1 clones via the existing `duplicate()`. Do we want true GitHub template-repo _generate_ (fresh history) for `isGitHubTemplate: true` blueprints, and is that a git-provider-plugin capability add?
4. **Non-website Work shapes.** `directory`/`landing`/`blog` all resolve through the _website_ generator today. Do `store`/`company` blueprints (when their repos exist) need a different generator, and does the blueprint need a `generator` field to select it?
5. **Manifest freshness signal.** Should a blueprint carry an `updatedAt`/`version` so the upserted `templates` row can be refreshed when the manifest bumps, or is the 1h catalog cache + never-overwrite-custom enough?

---

## 11. Cross-references

- Implementation plan: [plan.md](plan.md)
- Task checklist: [tasks.md](tasks.md)
- Shipped precedent: [`agent-template-catalog.service.ts`](../../../../apps/api/src/agents/agent-template-catalog.service.ts), [`agent-templates.server.ts`](../../../../apps/web/src/lib/api/agent-templates.server.ts)
- ADR-014 (no hardcoded catalogs) — `docs/specs/decisions/014-no-hardcoded-catalogs.md`
- Sibling front spec format: [tenants-and-organizations/spec.md](../tenants-and-organizations/spec.md)
