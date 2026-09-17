# Task Breakdown: App Launcher & Apps registry API

> Ordered tasks derived from [`plan.md`](./plan.md). Each is small enough to land in one PR and
> ships with tests per **Constitution VI**. The schema task ships its migration in the same PR per
> **Constitution V**.

**Epic ID**: `APW-11-app-launcher`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-17

---

## How to use

- Tasks are **sequential by default**. `(parallel)` means it may run alongside its predecessor.
- Every task names the exact files to create or modify. **new** marks a file that does not exist yet; every other
  path was checked with `git ls-files` on `develop` @ `ee45946e5`.
- Every task has a **Test** line (file + assertion, or the run command for a test task) and a **Done when** line
  that is checkable without reading the diff.
- Add new tasks at the bottom rather than renumbering.
- Phase boundaries are ship boundaries: `develop` is green and deployable at the end of each phase.
- Repository commands run from the monorepo root; migrations are authored from `apps/api/`.
- **No string added by any task may claim single sign-on** (launch-parity backlog G-09); T21 enforces it.
- Program audit resolutions ([CONTRACTS.md §0](../CONTRACTS.md)) applied here: R-1 (T1), R-2 (T7), R-19 (T25),
  R-22 (T9, T20 — no suite under `apps/api/test/`; this epic owns `apps/web/e2e/flow-app-launcher-apps.spec.ts`).
- Run commands:
    - contracts: `pnpm --filter @ever-works/contracts test`
    - agent: `pnpm --filter @ever-works/agent test -- app-launcher`
    - API: `cd apps/api && pnpm test -- app-launcher`
    - component: `pnpm --filter @ever-works/app-launcher test`
    - web unit: `pnpm --filter ever-works-web test -- app-launcher`; web e2e: `pnpm --filter ever-works-web test:e2e app-launcher`

---

# Phase P1 — The launcher inside Ever Works (Wave 1)

_Delivers spec FR-1…FR-44, FR-53, FR-54 and ACC-11-01…ACC-11-33._

## P1.1 — Contracts and data

- [ ] **T1. Shared launcher types.**
      **Create** `packages/contracts/src/apps/app-launcher.ts` (**new**, Resolution R-1) with every type and constant
      in [plan §3.3](./plan.md) — `APP_LAUNCHER_ENVIRONMENTS`, `AppLauncherItem`, `AppLauncherListResponse`,
      `AppLauncherPreferenceChange`, `APP_LAUNCHER_PIN_LIMIT = 6`, `APP_LAUNCHER_MAX_ITEMS_RESPONSE = 200`,
      `APP_LAUNCHER_MAX_CHANGES_PER_SAVE = 200`, `APP_LAUNCHER_MAX_PREFERENCE_ROWS = 500`,
      `APP_LAUNCHER_PANEL_PLATFORMS_MAX = 12`, `APP_LAUNCHER_PANEL_WORKS_MAX = 24`,
      `APP_LAUNCHER_CATALOG_MAX_ENTRIES = 24`, `APP_LAUNCHER_ICON_MAX_BYTES = 16_384`,
      `APP_LAUNCHER_CLIENT_CACHE_MS = 300_000`.
      **Modify** APW-03's barrel `packages/contracts/src/apps/index.ts` — `export * from './app-launcher.js';` (create
      the barrel, and `export * from './apps/index.js';` in `packages/contracts/src/index.ts`, only if APW-03 has not
      landed).
      **Test**: `packages/contracts/src/apps/__tests__/app-launcher.spec.ts` (**new**) pins every numeric constant and
      the environment union; run `pnpm --filter @ever-works/contracts test`.
      **Done when**: `pnpm --filter @ever-works/contracts build` emits the declarations,
      `import { AppLauncherItem } from '@ever-works/contracts'` resolves in `apps/api` and `apps/web`, and
      `packages/contracts/src/__tests__/index.barrel.spec.ts` passes.

- [ ] **T2. Entity and Work column.**
      **Create** `packages/agent/src/entities/app-launcher-preference.entity.ts` (**new**) per
      [plan §3.2](./plan.md): `userId` (`@ManyToOne(() => User, { onDelete: 'CASCADE' })`), `scopeKey`
      `varchar(40)`, `itemKey` `varchar(64)`, `visible` default `true`, `pinned` default `false`,
      `pinOrder` `smallint` nullable, `sortOrder` `integer` nullable, `createdAt`, `updatedAt`;
      `@Unique('uq_app_launcher_prefs_user_scope_item', ['userId', 'scopeKey', 'itemKey'])`,
      `@Index('idx_app_launcher_prefs_user_scope', ['userId', 'scopeKey'])`. **No** `tenantId` /
      `organizationId` columns (plan §3.2 explains why).
      **Modify** `packages/agent/src/entities/work.entity.ts` — append
      `@Column({ type: 'boolean', nullable: true }) appLauncherExposed?: boolean | null;` at the end of
      the column list.
      **Modify** `packages/agent/src/entities/index.ts`, `packages/agent/src/database/_entity-names.ts`,
      `packages/agent/src/database/_entities-inventory.ts` — register `AppLauncherPreference`.
      **Test**: `packages/agent/src/entities/__tests__/app-launcher-preference.entity.spec.ts` (**new**) —
      index and unique names, no scope-stamp columns, defaults.
      **Done when**: the entity drift specs in `packages/agent/src/database/` pass without a
      magic-number edit and `pnpm --filter @ever-works/agent build` is clean.

- [ ] **T3. Migration.**
      **Create** `apps/api/src/migrations/1792110000000-CreateAppLauncherPreferences.ts` (**new**) —
      `ALTER TABLE "works" ADD COLUMN "appLauncherExposed" boolean NULL`; `CREATE TABLE
"app_launcher_preferences"` with the unique constraint and index from T2. `down()` drops only what
      `up()` created. Re-stamp above the newest migration if `develop` moved past
      `1791240000000-AddSafetyRailsCore.ts` (newest on `ee45946e5`).
      **Test**: `apps/api/src/migrations/__tests__/CreateAppLauncherPreferences.spec.ts` (**new**) — no
      `DROP COLUMN` / rename of a pre-existing column in `up()`; `down()` drops exactly the column, table and index
      `up()` created; on SQLite an existing Work reads `appLauncherExposed = NULL` after `up()`.
      **Done when**: a fresh database and a database with existing Works both migrate, and every existing
      Work reads `appLauncherExposed = NULL`.

## P1.2 — Agent domain

- [ ] **T4. Pure address and order modules.**
      **Create** `packages/agent/src/app-launcher/launcher-address.ts` (**new**) —
      `resolveLauncherAddress()` and `toSafeLauncherUrl()` exactly as in [plan §4.6](./plan.md).
      **Create** `packages/agent/src/app-launcher/launcher-order.ts` (**new**) — `orderLauncherItems()`
      implementing spec FR-26 and the section caps of FR-4 (panel) vs 200 (response).
      **Test**: `packages/agent/src/app-launcher/__tests__/launcher-address.spec.ts` and
      `launcher-order.spec.ts` (**new**) — every row of [plan §10.1](./plan.md) for these two files: earliest verified
      domain wins, a second domain never moves the tile, removing the first falls back to the second then the
      subdomain (ACC-11-10), a managed subdomain alone yields an address (ACC-11-09); 140 exposed live Works yield 24
      panel tiles and `worksTotal: 140` (ACC-11-14); catalog order for Ever apps (ACC-11-05).
      **Done when**: both specs pass with 100% branch coverage of the two modules.

- [ ] **T5 (parallel with T4). Repository methods.**
      **Create** `packages/agent/src/database/repositories/app-launcher-preference.repository.ts`
      (**new**) — `findForUser(userId, scopeKeys)`, `upsertMany(userId, rows, manager)` using
      `ON CONFLICT ("userId","scopeKey","itemKey") DO UPDATE`, `countPinned(userId, scopeKeys, manager)`,
      `pruneIneligible(userId, eligibleKeys, keep = 500, manager)`.
      **Modify** `packages/agent/src/database/repositories/work.repository.ts` — add
      `findLauncherCandidates({ userId, memberWorkIds, organizationId, limit })`: creator-or-member,
      `status <> 'archived'`, `organizationId = :org` or `IS NULL` for personal scope, `updatedAt DESC`,
      `limit ≤ 500`.
      **Modify** `packages/agent/src/database/repositories/work-deployment.repository.ts` — add
      `findLatestReadyForWorks(workIds, environment)` (`state = 'READY'`, newest per Work), next to
      `findLatestForWorks` (line 48).
      **Modify** `packages/agent/src/database/repositories/work-custom-domain.repository.ts` — add
      `findVerifiedProductionForWorks(workIds)` (`verified = true`, `environment = 'production'`,
      `createdAt ASC`).
      **Modify** `packages/agent/src/database/index.ts` — export the new repository.
      **Test**: `packages/agent/src/database/repositories/__tests__/app-launcher-preference.repository.spec.ts`
      (**new**) — two writers changing different items both persist and the same item takes the last write
      (ACC-11-20); re-sending identical values changes nothing; and extensions of
      `packages/agent/src/database/repositories/__tests__/work.repository.spec.ts`,
      `work-deployment.repository.spec.ts`, `work-custom-domain.repository.spec.ts` for the three new methods (preview
      and non-`READY` rows excluded; archived Works excluded; Organization filter).
      **Done when**: all repository specs pass in the SQLite unit lane.

- [ ] **T6. `AppLauncherService`.**
      **Create** `packages/agent/src/app-launcher/app-launcher.service.ts` (**new**) —
      `listForUser(user, scope, platforms, { includeHidden, limit })` and
      `savePreferences(userId, scope, changes, platforms)` per [plan §4.1–4.2](./plan.md), including the
      eligible-key set, `unknownItem` / `cannotHideCurrent` rejections, whole-save refusal on pin limit
      (throws `AppLauncherPinLimitError`), and the 500-row prune.
      Inject `ManagedHostRootResolver` (**new** token in
      `packages/agent/src/app-launcher/managed-host-root.resolver.ts`) with a default binding returning
      the managed root domain `EVER_WORKS_DOMAIN` (default `ever.works`). `packages/agent/src/config/index.ts` has no
      accessor for it; it is read from `process.env` as in
      `packages/agent/src/ever-works-providers/subdomain-allocator.service.ts`.
      **Create** `packages/agent/src/app-launcher/app-launcher.module.ts` and `index.ts` (**new**) —
      `TypeOrmModule.forFeature([AppLauncherPreference])`, providers, exports.
      **Test**: `packages/agent/src/app-launcher/__tests__/app-launcher.service.spec.ts` (**new**) — an App Work with a
      `READY` production deployment appears with no setting (ACC-11-09); a directory Work appears only when exposed
      and only for members who can view it (ACC-11-11); a failed latest deployment after an earlier success carries
      `lastDeployFailed` (ACC-11-12); a preview deployment alone never lists (ACC-11-13); Work pins differ between
      two Organizations while Ever app pins are shared (ACC-11-21); 200 cap with `truncated`;
      `app-launcher.save.spec.ts` (**new**) — the current platform has no hide (ACC-11-06); a seventh pin refuses the
      whole save (ACC-11-19); a key for another Organization's Work is rejected with a reason byte-identical to a
      nonexistent Work's (ACC-11-22).
      **Done when**: no test can make a preview-only or never-`READY` Work appear, and an inaccessible
      key's rejection is byte-identical to a nonexistent key's.

- [ ] **T7. Exposure on Work update.**
      **Modify** `packages/agent/src/dto/update-work.dto.ts` — optional `appLauncherExposed?: boolean |
null` with `@IsOptional()` and a boolean-or-null validator; `@ApiPropertyOptional` description
      "Show this Work in members' App Launcher (null = kind default)".
      **Modify** `packages/agent/src/services/work-lifecycle.service.ts` `updateWork` (line 851) — after
      `ensureCanEdit`, persist the field when present and changed, then log Activity with
      `actionType: ActivityActionType.APP_LAUNCHER` and `action` `app.launcher.exposed` or `app.launcher.hidden`
      (Resolution R-2), `metadata: { explicit }`.
      **Modify** `packages/agent/src/entities/activity-log.types.ts` — append one member
      `APP_LAUNCHER = 'app_launcher'`.
      **Modify** `packages/agent/src/services/work-query.service.ts` — add
      `appLauncher: { exposed, effectiveExposed, live }` to the Work detail payload (one extra batched
      read of latest `READY` deployment + verified domains, reusing T5 methods).
      **Test**: `packages/agent/src/services/__tests__/work-lifecycle.app-launcher-exposure.spec.ts`
      (**new**) — one Activity row per real change with `actionType: 'app_launcher'` and the dotted `action`, none on a
      no-op, no address in metadata, viewer refused (ACC-11-16); extend
      `packages/agent/src/entities/__tests__/activity-log.types.spec.ts` for the new member.
      **Done when**: `PUT /api/works/:id { "appLauncherExposed": true }` by an editor writes one
      Activity entry, and by a viewer answers the existing edit-rights error.

## P1.3 — API

- [ ] **T8. Platform catalog service.**
      **Create** `apps/api/src/app-launcher/platform-catalog.schema.ts` and
      `apps/api/src/app-launcher/platform-catalog.service.ts` (**new**) per [plan §5.2](./plan.md): env
      `EVER_WORKS_PLATFORM_CATALOG_REPO` (regex `^ever-works\/[a-z0-9-]+$`), `_REF`, `_ENV`, `_SELF_ID`;
      8,000 ms fetch timeout; icons inlined as data URIs ≤ 16,384 bytes; SVG deny patterns; ≤ 24 entries;
      success TTL 3,600,000 ms, failure TTL 30,000 ms, `:last-good` entry without TTL.
      **Test**: `apps/api/src/app-launcher/platform-catalog.service.spec.ts` (**new**) — 25th entry
      dropped, `javascript:` and `http:` dropped (ACC-11-08), oversize icon → entry kept without icon, SVG with
      `<script` rejected, blocked source with no prior read → `catalogAvailable: false` and last-good served after a
      prior read (ACC-11-07), entries for `stage` differ from `production` and an entry without a `develop` URL is
      absent for `develop` (ACC-11-05), `evil/platforms` repo refused at boot.
      **Done when**: with the fixture catalog the service returns entries for `stage` that differ from
      `production`, and an entry lacking a `develop` URL is absent for `develop`.

- [ ] **T9. Controllers, guard, module.**
      **Create** `apps/api/src/app-launcher/guards/app-launcher-enabled.guard.ts` (**new**) — 404 unless
      `EVER_WORKS_APP_LAUNCHER_ENABLED === 'true'`, mirroring
      `apps/api/src/fleet/guards/fleet-enabled.guard.ts`.
      **Create** `apps/api/src/app-launcher/dto/app-launcher.dto.ts` (**new**) —
      `ListAppLauncherQueryDto` (`includeHidden`, `limit` 1..200) and `SaveAppLauncherPreferencesDto`
      (`@ArrayMinSize(1) @ArrayMaxSize(200)`, key regex, `order` 0..9999).
      **Create** `apps/api/src/app-launcher/app-launcher.controller.ts` (**new**) —
      `@Controller('api/me/apps')`: `GET /` (`@Throttle({ long: { limit: 60, ttl: 60_000 } })`) and
      `PUT preferences` (`@Throttle({ long: { limit: 30, ttl: 60_000 } })`), scope from
      `ScopeContextService.getScope()`, `AppLauncherPinLimitError` → `422 { code: 'pinLimit', limit: 6 }`.
      **Create** `apps/api/src/app-launcher/app-launcher-platforms.controller.ts` (**new**) —
      `@Public()` `GET api/app-launcher/platforms` (`@Throttle({ long: { limit: 120, ttl: 60_000 } })`,
      `Cache-Control: public, max-age=3600, stale-while-revalidate=600`, `Access-Control-Allow-Origin: *`,
      no credentials).
      **Create** `apps/api/src/app-launcher/app-launcher.module.ts` (**new**); **modify**
      `apps/api/src/api.module.ts` to import it next to `WorkAgentModule`.
      **Modify** `apps/api/src/api.controller.ts` — `features.appLauncherEnabled:
truthy(process.env.EVER_WORKS_APP_LAUNCHER_ENABLED)`.
      **Test**: `apps/api/src/app-launcher/app-launcher.controller.spec.ts` (**new**) — every P1 row of
      [plan §10.2](./plan.md): throttle metadata 60 reads / 30 writes (ACC-11-26), 404 on every route with the env
      unset (ACC-11-28); `app-launcher-platforms.controller.spec.ts` (**new**) — `@Public()` and the 1-hour cache header
      (ACC-11-27); and, replacing the former `apps/api/test/` suite (Resolution R-22),
      `apps/api/src/app-launcher/app-launcher.registry.integration.spec.ts` (**new**, plan §10.2) — in-memory
      better-sqlite3 with `ENTITIES`, 200 live Works for one person, 50 calls: p95 < 300 ms and no response holds more
      than 200 items (ACC-11-25); run `cd apps/api && pnpm test -- app-launcher`.
      **Done when**: `cd apps/api && pnpm test` is green; with the env unset every route answers 404.

## P1.4 — The web component (host-fed mode)

- [ ] **T10. Package scaffold.**
      **Create** `packages/app-launcher/package.json` (**new**, `@ever-works/app-launcher`,
      `"private": true`, `"type": "module"`, dependency `lit`), `tsup.config.ts`, `tsconfig.json`,
      `vitest.config.ts` (`happy-dom`), `src/index.ts`, `src/types.ts`, `src/strings.ts`,
      `scripts/check-size.mjs` (gzip of `dist/index.js` ≤ 30,720 bytes, run by `pnpm test`).
      `pnpm-workspace.yaml` already globs `packages/*`, so no workspace edit is needed.
      **Test**: `scripts/check-size.mjs` fails `pnpm --filter @ever-works/app-launcher test` when the gzip of
      `dist/index.js` exceeds 30,720 bytes (ACC-11-35); `packages/app-launcher/src/__tests__/index.spec.ts` (**new**)
      imports the entry twice without a `customElements.define` error.
      **Done when**: `pnpm --filter @ever-works/app-launcher build test` passes on an empty element.

- [ ] **T11. Keyboard model and URL guard.**
      **Create** `packages/app-launcher/src/grid-navigation.ts` and `src/safe-url.ts` (**new**).
      **Test**: `packages/app-launcher/src/__tests__/grid-navigation.spec.ts` (**new**) — all keys of spec §6.6 at 2
      and 3 columns, `Home`/`End`, typeahead wrap-around (ACC-11-29); `safe-url.spec.ts` (**new**) — `javascript:` and
      `http:` refused, `http://localhost` accepted only when allowed, the returned URL equals the input exactly with
      nothing added (ACC-11-08, ACC-11-23).
      **Done when**: both specs pass with 100% branch coverage of the two modules.

- [ ] **T12. `<ever-app-launcher>` element.**
      **Create** `packages/app-launcher/src/ever-app-launcher.ts` and `src/styles.ts` (**new**) per
      [plan §6.2–6.3](./plan.md): trigger button with `aria-haspopup="menu"`/`aria-expanded`/
      `aria-controls`; `role="menu"` panel with labelled groups and `role="menuitem"` anchor tiles
      (`target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"`); roving tabindex; focus
      trap; `Esc` restores focus; `ResizeObserver` columns (3 ≥ 360 px, else 2); bottom sheet under 640 px;
      88 px fixed tile height; skeletons; chips as text; `show()`/`hide()`; events `:open`, `:close`,
      cancellable `:item-activate`, `:manage`, `:retry`; `--ever-app-launcher-*` custom properties; no
      global style insertion; guarded `customElements.define`.
      **Test**: `packages/app-launcher/src/__tests__/ever-app-launcher.spec.ts` (**new**) — sections Pinned / Ever apps
      / Your apps / Manage apps in order and 3 vs 2 columns (ACC-11-02); 6 skeleton tiles at 88 px while `loading`
      (ACC-11-03); **You're here** not a link (ACC-11-06); cancelled activation opens nothing (ACC-11-40); focus trap;
      no `<style>` added to `document.head`.
      **Done when**: the size check passes and the spec is green.

## P1.5 — Web integration

- [ ] **T13. Flag helper and public config plumbing.**
      **Create** `apps/web/src/lib/feature-flags/app-launcher.ts` (**new**, `server-only`) —
      `isAppLauncherEnabled(distinctId)`: `features.appLauncherEnabled === true` from the public API
      config **and** (PostHog not configured **or** `isFeatureEnabled('app-launcher', distinctId) === true`
      within 1,500 ms). Any error or timeout → `false`.
      **Modify** `apps/web/src/app/[locale]/(dashboard)/layout.tsx` and `layout-client.tsx` — compute
      once, pass `appLauncherEnabled` to `DashboardHeader`, the palette context and the settings layout.
      **Test**: `apps/web/src/lib/feature-flags/app-launcher.unit.spec.ts` (**new**) — the fail-closed
      matrix (config off; PostHog unset; flag true/false/undefined/timeout) (ACC-11-28 flag half).
      **Done when**: the spec passes and a PostHog timeout yields `false`.

- [ ] **T14. BFF route and React wrapper.**
      **Create** `apps/web/src/app/api/me/apps/route.ts` (**new**) — `GET` proxy mirroring
      `apps/web/src/app/api/usage/costs/[section]/route.ts` (cookie → Bearer, workspace scope header,
      only `includeHidden` forwarded).
      **Create** `apps/web/src/components/app-launcher/AppLauncherButton.tsx` and
      `AppLauncherProvider.tsx` (**new**) per [plan §6.4](./plan.md): lazy element import in `useEffect`,
      5-minute module cache, `browserApiFetch('/api/me/apps')`, strings from
      `useTranslations('dashboard.appLauncher')`, `:manage` → `ROUTES.DASHBOARD_SETTINGS_APP_LAUNCHER`,
      chunk-load failure renders a disabled control.
      **Create** `apps/web/src/lib/app-launcher/app-launcher-telemetry.ts` (**new**) — closed union of the
      four events in [plan §9.1](./plan.md), copying `apps/web/src/lib/help/help-telemetry.ts`.
      **Modify** `apps/web/src/components/dashboard/DashboardHeader.tsx` — optional `appLauncher?: boolean`
      prop; render `<AppLauncherButton />` after the Help button (line 149). Nothing else in the header
      moves.
      **Test**: `apps/web/src/components/app-launcher/AppLauncherButton.unit.spec.tsx` (**new**) — a second open within
      5 minutes renders from cache with no fetch (ACC-11-03), refetch after, the telemetry payload of three tile opens
      has no host, URL or Work name (ACC-11-32); `apps/web/src/app/api/me/apps/route.unit.spec.ts` (**new**) — forwards
      only `includeHidden` and never puts the token in the upstream URL (ACC-11-24 unit half);
      `apps/web/src/components/dashboard/DashboardHeader.app-launcher.unit.spec.tsx` (**new**) — without the prop the
      right cluster is unchanged, with it the control is last (ACC-11-01).
      **Done when**: the three specs pass and `apps/web/e2e/command-palette.spec.ts` passes unchanged with the flag off.

- [ ] **T15. Command palette entry.**
      **Modify** `apps/web/src/components/command-palette/registry/types.ts` — optional
      `openAppLauncher?: () => void` on `PaletteCommandContext`.
      **Modify** `apps/web/src/components/command-palette/registry/commands.ts` — command
      `openAppLauncher` (lucide `LayoutGrid`), `available: (ctx) => ctx.openAppLauncher !== undefined`.
      **Modify** `apps/web/src/components/command-palette/CommandPalette.tsx` — pass the provider's opener.
      **Test**: extend `apps/web/src/components/command-palette/registry/registry.unit.spec.ts` — the command exists
      only when `openAppLauncher` is provided and matches `launcher`, `apps` and `switch app` (ACC-11-04 unit half).
      **Done when**: `apps/web/e2e/command-palette.spec.ts` passes unchanged.

- [ ] **T16. Manage apps settings page.**
      **Modify** `apps/web/src/lib/constants.ts` — `DASHBOARD_SETTINGS_APP_LAUNCHER: '/settings/app-launcher'`.
      **Modify** `apps/web/src/app/[locale]/(dashboard)/settings/settings-layout-client.tsx` — tab after
      `notifications`, rendered only when enabled.
      **Create** `apps/web/src/app/[locale]/(dashboard)/settings/app-launcher/page.tsx` (**new**, server;
      `notFound()` when disabled), `apps/web/src/components/settings/AppLauncherSettings.tsx` (**new**),
      `apps/web/src/lib/api/app-launcher.ts` (**new**, server-only `serverFetch`), and
      `apps/web/src/app/actions/settings/app-launcher.ts` (**new**, `saveAppLauncherPreferencesAction`).
      Rows: Show toggle, Pin toggle (7th disabled with tooltip), Move up/down, `Alt+↑/↓`, native drag
      handle; 500 ms debounced batch save; `Saving…`/`Saved`/`Couldn't save. Try again.`.
      **Test**: `apps/web/src/components/settings/AppLauncherSettings.unit.spec.tsx` (**new**) — debounce batches
      changes into one save, pin counter, seventh pin disabled with "Six pins is the limit. Unpin one first."
      (ACC-11-19, ACC-11-18 unit half); extend `apps/web/src/app/[locale]/(dashboard)/settings/settings-layout-client.unit.spec.tsx`
      — the tab renders only when enabled (ACC-11-28).
      **Done when**: reloading the page after each control shows the saved state.

- [ ] **T17. Work setting toggle.**
      **Create** `apps/web/src/components/works/detail/settings/AppLauncherExposureSetting.tsx` (**new**) —
      reads `work.appLauncher`, disabled with the not-live copy, read-only for viewers, saves through the
      existing `useSettings().handleUpdate` path with `appLauncherExposed`.
      **Modify** `apps/web/src/components/works/detail/settings/GeneralSettings.tsx` — mount it at the
      end of the card, only when the launcher is enabled.
      **Modify** the web Work type in `apps/web/src/lib/api/work.ts` — add the optional `appLauncher`
      object.
      **Test**: `apps/web/src/components/works/detail/settings/AppLauncherExposureSetting.unit.spec.tsx`
      (**new**) — a viewer sees it read-only with "Only editors can change this." (ACC-11-15); a not-live Work shows it
      disabled with the stored choice kept (ACC-11-17).
      **Done when**: the spec passes and `SettingsForm.unit.spec.tsx` passes unchanged with the flag off.

## P1.6 — Catalog repository, i18n, e2e, docs

- [ ] **T18. Create the `ever-works/platforms` catalog repository.** _(owner action — outside this
      monorepo; requires the owner's go-ahead on spec §9 question 1)_
      Layout, schema and CI exactly as [plan §5.1](./plan.md); first entries: Ever Works, Ever Gauzy,
      Ever Teams with owner-supplied addresses per environment; tag `v1.0.0`.
      **Create** (in `ever-works/platforms`, not this monorepo) `platforms.json`, `icons/ever-works.svg`,
      `icons/ever-gauzy.svg`, `icons/ever-teams.svg`, `schema/platforms.schema.json`, `.github/workflows/validate.yml`,
      `README.md`, `CONTRIBUTING.md`, `LICENSE`.
      **Test**: that repository's `.github/workflows/validate.yml` (schema, icon size, https-only, unique ids, ≤ 24
      entries) passes on the tag and fails on a fixture pull request adding a 25th entry.
      **Done when**: its `validate.yml` passes and `EVER_WORKS_PLATFORM_CATALOG_REF=v1.0.0` on stage
      renders three tiles.

- [ ] **T19. i18n keys.**
      **Modify** `apps/web/messages/en.json` — every key in [plan §8](./plan.md) (P1 keys only; the three
      P2 keys land in T27), then the same keys in the 20 sibling locale files in `apps/web/messages/`.
      Leaf names camelCase with no literal `.`.
      **Test**: `apps/web/src/lib/app-launcher/__tests__/app-launcher-messages.unit.spec.ts` (**new**) — every P1 key of
      plan §8 resolves to a non-empty string in all 21 locale files, no leaf name contains a dot, and every
      `t('…')` key used by `AppLauncherButton.tsx`, `AppLauncherSettings.tsx` and `AppLauncherExposureSetting.tsx`
      exists in `en.json` (ACC-11-31).
      **Done when**: the spec passes and `pnpm --filter ever-works-web build` reports no missing messages.

- [ ] **T20. P1 e2e.**
      **Create** `apps/web/e2e/flow-app-launcher-apps.spec.ts` (the file ACCEPTANCE.md E2E-12 names; owned by this epic
      per Resolution R-22 — APW-13 references it and does not create it), `apps/web/e2e/app-launcher-manage.spec.ts`,
      `apps/web/e2e/app-launcher-exposure.spec.ts`, `apps/web/e2e/app-launcher-keyboard-a11y.spec.ts`,
      `apps/web/e2e/app-launcher-flag-off.spec.ts` (**new**) per [plan §10.5](./plan.md), with a catalog fixture served
      by a Playwright route handler (no network to GitHub). Prefer `getByTestId` for tiles (`app-launcher-tile-<key>`).
      **Test**: run `pnpm --filter ever-works-web test:e2e app-launcher`. Assertions: control last in the header
      (ACC-11-01); sections and columns (ACC-11-02); palette → `launcher` → `Enter` focuses the first tile (ACC-11-04);
      tiles match the fixture for the environment (ACC-11-05); live App Work present, failed-after-success chip
      (ACC-11-09, ACC-11-12); exposure by an editor visible to a second member and not to a non-member (ACC-11-11); viewer
      read-only (ACC-11-15); one Activity entry per exposure change (ACC-11-16); pin, hide and move reflected in a
      second browser context, seventh pin refused (ACC-11-18, ACC-11-19); popup has `opener === null`, no referrer and
      the exact stored URL (ACC-11-23); **every request URL recorded with `page.on('request')` during open, save and tile
      activation contains no `token`, `access_token`, `sessionToken`, `ew_live_` or session-cookie value, with a
      control request that plants one and must be caught** (ACC-11-24); flag off hides control, palette command,
      settings page and Work setting and the API answers 404 (ACC-11-28); §6.6 keyboard table and focus return
      (ACC-11-29); axe over control, panel and **Manage apps** with no new violation (ACC-11-30).
      **Done when**: the five specs pass and `command-palette.spec.ts`,
      `flow-org-settings-persistence.spec.ts` and the Work settings specs pass unchanged.

- [ ] **T21. G-09 copy guard.**
      **Create** `apps/web/src/lib/app-launcher/__tests__/no-sso-claims.unit.spec.ts` (**new**) — loads
      `dashboard.appLauncher`, `dashboard.settings.appLauncher` and
      `dashboard.workDetail.settings.appLauncher` from every locale file and fails on
      `/single sign-on|\bsso\b|one login|already signed in/i` (English) plus a translated-term list kept
      beside the spec. Remove the prohibition only when APW-12 ships (TRACKER note).
      **Test**: that spec (ACC-11-33); run `pnpm --filter ever-works-web test -- no-sso-claims`.
      **Done when**: adding `"Single sign-on"` to any launcher key makes the spec fail.

- [ ] **T22. Docs.**
      **Create** `docs/features/app-launcher.md` (**new**) — what appears, why a Work appears, pins and
      hides, exposure, what the launcher does not do (no sign-on). **Modify** `apps/docs/sidebarsPlatform.ts`
      to list it. **Modify** `docs/features/managed-hosting.md` "Related" list with one link. **Modify**
      `docs/specs/features/app-works/TRACKER.md` — APW-11 impl status.
      **Test**: run `pnpm --filter ever-works-docs build`; T21's pattern applied to `docs/features/app-launcher.md` finds
      nothing.
      **Done when**: `pnpm --filter ever-works-docs build` has no broken links.

- [ ] **T23. P1 ship gate.**
      Root `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`; enable
      `EVER_WORKS_APP_LAUNCHER_ENABLED=true` on stage; walk ACC-11-01…ACC-11-33.
      **Modify** `docs/specs/features/app-works/ACCEPTANCE.md` — the APW-11 rows point at the files named in T1–T21 (sent
      to the program owner of that file) — and `docs/specs/features/app-works/TRACKER.md` — APW-11 P1 row.
      **Test**: the PR lane runs T20's five specs; ACC-E2E-12's nightly `apps/web/e2e/flow-app-works-live-launcher.spec.ts`
      (APW-13) passes against stage.
      **Done when**: all 33 are ticked on stage.

---

# Phase P2 — The launcher inside other Ever platforms (Wave 3)

_Delivers spec FR-45…FR-52 and ACC-11-34…ACC-11-40. Blocked by APW-12 (token issuance, identity-provider
facade) and APW-06 P2 (`ManagedHostRootResolver` binding for managed App Works)._

- [ ] **T24. Self-fetch mode and stale cache.**
      **Create** `packages/app-launcher/src/data-source.ts` and `src/stale-cache.ts` (**new**) — reads
      `catalog-url` (default `<api>/api/app-launcher/platforms?environment=…`) without credentials, calls
      `getAccessToken()`, reads `apps-url` with `Authorization: Bearer` only; `localStorage` last-good list
      with a 7-day (604,800,000 ms) maximum age, every access in try/catch.
      **Modify** `packages/app-launcher/src/ever-app-launcher.ts` — attributes `environment`,
      `catalog-url`, `apps-url`, `sign-in-available`; `:sign-in` event; signed-out rendering.
      **Test**: `packages/app-launcher/src/__tests__/stale-cache.spec.ts` (**new**) — 6 days served, 8 days not
      (ACC-11-39); `data-source.spec.ts` (**new**) — never sends `credentials: 'include'`, never puts a token in a URL,
      and with no token renders Ever apps plus the sign-in prompt (ACC-11-36).
      **Done when**: both specs pass and the size check (T10) still passes.

- [ ] **T25. Delegated read on the API.** _(requires APW-12's `DelegatedRead` decorator and guard
      branch — APW-12 plan §5.3; this task does not create or modify them)_
      **Modify** `apps/api/src/app-launcher/app-launcher.controller.ts` — `@DelegatedRead('apps:read')` on
      the `GET` list handler only; resolve scope keys `global` + `personal` when
      `auth.authMethod === 'ever-id-delegated'` (plan §4.7). Per Resolution R-19 this task adds no `authMethod` field
      or value — the field ships with AW-24 and APW-12 appends `'ever-id-delegated'` — and AW-24's `HumanActorGuard`
      refuses the delegated principal on human-only routes without change.
      **Test**: extend `apps/api/src/app-launcher/app-launcher.controller.spec.ts` — a delegated principal
      lists the same items as that person's session in personal scope (ACC-11-37); a delegated token on `PUT` is
      refused `401` so arrangement cannot change (ACC-11-37); a token in the query string is refused `400 tokenInQuery`
      (APW-12's guard).
      **Done when**: the spec passes and no file in `apps/api/src/app-launcher/` declares an `authMethod` type.

- [ ] **T26. Launcher CORS middleware.**
      **Create** `apps/api/src/app-launcher/launcher-delegated-cors.middleware.ts` (**new**) per
      [plan §4.7](./plan.md); parse `EVER_WORKS_APP_LAUNCHER_ORIGINS` (≤ 50 exact `https://` origins; boot
      fails in production on an invalid entry, like `apps/api/src/cors-validation.ts`).
      **Modify** `apps/api/src/app-launcher/app-launcher.module.ts` — `configure(consumer)` for the two
      launcher routes only.
      **Test**: `apps/api/src/app-launcher/launcher-delegated-cors.middleware.spec.ts` (**new**) — ACAO only
      for allow-listed origins and none for others (ACC-11-38), never `Access-Control-Allow-Credentials`, `204`
      preflight, other routes untouched; the existing CORS e2e contract passes unchanged.
      **Done when**: the spec passes and a 51st origin fails boot with `NODE_ENV=production`.

- [ ] **T27. Cross-framework fixtures, P2 i18n, e2e.**
      **Create** `packages/app-launcher/fixtures/angular/index.html`, `fixtures/react/index.html`,
      `fixtures/solid/index.html` (**new**, static pages loading `dist/index.js`) and
      `apps/web/e2e/app-launcher-cross-framework.spec.ts` (**new**).
      **Modify** `apps/web/messages/en.json` and the 20 sibling locale files — the three P2 keys from
      [plan §8](./plan.md); extend T19's messages spec to cover them.
      **Test**: `apps/web/e2e/app-launcher-cross-framework.spec.ts` — the element renders in the three fixture pages with
      no console error and no style leak into the host (ACC-11-34); signed out, no request carries the Ever Works
      session cookie (ACC-11-36); run `pnpm --filter ever-works-web test:e2e app-launcher-cross-framework`.
      **Done when**: ACC-11-34…ACC-11-40 pass.

- [ ] **T28. Extraction and publication.** _(owner decision — README open question 7)_
      Extract `packages/app-launcher` with history (`git subtree split`) into the owner-chosen public
      repository, set `"private": false`, publish under the owner-chosen npm scope, and switch
      `apps/web` to the published version. Document the element API from [plan §6.2](./plan.md) in that
      repository's README.
      **Modify** `apps/web/package.json` — the dependency points at the published version.
      **Test**: the extracted repository's CI runs the moved `src/__tests__/*.spec.ts` and `scripts/check-size.mjs`;
      in this monorepo `apps/web/e2e/app-launcher-cross-framework.spec.ts` and T20's specs pass against the published
      version.
      **Done when**: Ever Works and one other Ever platform load the same published version.

- [ ] **T29. P2 ship gate.** Root `format / lint / type-check / test / build` green; walk
      ACC-11-34…ACC-11-40 on stage with Ever ID. T21's copy guard is relaxed only for strings APW-12 approves.
      **Modify** `docs/specs/features/app-works/TRACKER.md` (APW-11 P2 row), this file's `Status`, and — only for strings
      APW-12 approves — the allowed-term list beside `apps/web/src/lib/app-launcher/__tests__/no-sso-claims.unit.spec.ts`.
      **Test**: `apps/web/e2e/app-launcher-cross-framework.spec.ts` and the T24–T26 specs green in the PR lane; ACC-E2E-13
      (b) on stage reads the person's apps from Ever Teams through a delegated token.
      **Done when**: ACC-11-34…ACC-11-40 are ticked on stage.

# Cross-phase closing tasks

- [ ] **T30 (P1, lands with T2–T3). Classify new tables for workspace backup (R-25).**
      **Modify** `packages/agent/src/account-transfer/backup/collectors/domain-specs.ts` — append to the `account`
      domain: `{ file: 'app-launcher-preferences.jsonl', entity: 'AppLauncherPreference', scope: { by: 'user' } }` — the
      table has `userId` and no `organizationId` ([plan §3.2](./plan.md)), and its rows are the person's own layout.
      `packages/agent/src/account-transfer/backup/redaction.ts` is **not** modified: rows hold item keys, visibility and
      order only — no names, URLs or secret-shaped column. T2's `Work.appLauncherExposed` rides `works/works.jsonl`.
      **Test**: extend `packages/agent/src/account-transfer/backup/collectors/collectors.spec.ts` —
      `AppLauncherPreference` is referenced exactly once, in `account`, scoped `by: 'user'`, not dropped; its planned
      query is `equals: { userId }` with no `organizationId` predicate; `Work` is still referenced once, by
      `works/works.jsonl`.
      **Done when**: `pnpm --filter @ever-works/agent test -- collectors redaction` is green and a backup of a workspace
      whose owner pinned one item lists `data/account/app-launcher-preferences.jsonl` with that row.

---

## Definition of Done

- Every checkbox above is ticked.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test` and `pnpm build` are green.
- Every acceptance criterion in [spec §8](./spec.md) has been walked on stage.
- The existing header, command-palette, Organization-settings and Work-settings e2e specs pass unchanged.
- CONTRACTS.md rows named in the plan header exist and match the merged code.
- No string anywhere in the launcher claims single sign-on before APW-12 is live.
- No suite for this epic lives under `apps/api/test/` (Resolution R-22).
