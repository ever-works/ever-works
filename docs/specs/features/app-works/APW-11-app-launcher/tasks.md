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
- Program audit resolutions ([CONTRACTS.md §0](../CONTRACTS.md)) applied here: R-1 (T1), R-2 (T7), R-16 (T4, T6,
  T18), R-19 (T25), R-22 (T9, T20 — no suite under `apps/api/test/`; this epic owns
  `apps/web/e2e/flow-app-launcher-apps.spec.ts`), R-25 (T30), R-26 (every audit-round change below is a new task
  or a new id inside an existing one — FR-55…FR-66, S23…S26, ACC-11-41…ACC-11-54 — and no earlier task, id or
  default is withdrawn).
- **Audit round 2026-09-17.** Seven tasks gained a second half and three are new (T31–T33), because the programme
  audit found work that was missing rather than wrong: the operator switch was never wired into the deploy
  manifests, the `app_launcher` Activity type had no Live Feed bucket, the PR lane had no way to seed a live App
  Work, and the exposure toggle's save path rewrote a README. Each addition is named in the task it belongs to and
  carries its own Test line.
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
      `AppLauncherPreferenceChange`, `AppLauncherRejectionReason`, `AppLauncherRejection`,
      `AppLauncherSavePreferencesResponse`, `AppLauncherPinLimitErrorBody`, `AppLauncherPlatformsResponse`,
      `AppLauncherEmptyAction`, `APP_LAUNCHER_PIN_LIMIT = 6`, `APP_LAUNCHER_MAX_ITEMS_RESPONSE = 200`,
      `APP_LAUNCHER_MAX_CHANGES_PER_SAVE = 200`, `APP_LAUNCHER_MAX_PREFERENCE_ROWS = 500`,
      `APP_LAUNCHER_PANEL_PLATFORMS_MAX = 12`, `APP_LAUNCHER_PANEL_WORKS_MAX = 24`,
      `APP_LAUNCHER_CATALOG_MAX_ENTRIES = 24`, `APP_LAUNCHER_ICON_MAX_BYTES = 16_384`,
      `APP_LAUNCHER_CLIENT_CACHE_MS = 300_000`.
      **Modify** APW-03's barrel `packages/contracts/src/apps/index.ts` — `export * from './app-launcher.js';` (create
      the barrel, and `export * from './apps/index.js';` in `packages/contracts/src/index.ts`, only if APW-03 has not
      landed).
      **Modify** `packages/contracts/src/__tests__/index.barrel.spec.ts` — in **either** branch, whether APW-03's
      barrel exists or this task creates it: add the import `import * as apps from '../apps/index.js';`, add
      `['apps', apps]` to the `AREAS` array (`:56-90`), and **recount** `expect(exportLines).toBe(33)` (`:132`) from
      the array — do not guess the number. Without this the barrel's name-collision check never sees a launcher type
      and stays green while two areas export the same name (APW11-G24). The same edit belongs in APW-03's own T1; it
      is requested there and repeated here so this epic cannot land a blind check.
      **Test**: `packages/contracts/src/apps/__tests__/app-launcher.spec.ts` (**new**) pins every numeric constant and
      the environment union; run `pnpm --filter @ever-works/contracts test`.
      **Done when**: `pnpm --filter @ever-works/contracts build` emits the declarations,
      `import { AppLauncherItem } from '@ever-works/contracts'` resolves in `apps/api` and `apps/web`, and
      `packages/contracts/src/__tests__/index.barrel.spec.ts` passes **with `apps` in `AREAS` and its literal
      recounted from the array** — deleting a launcher type from the barrel makes the collision check run over it
      (ACC-11-54).

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
      panel tiles and `worksTotal: 140` (ACC-11-14); catalog order for Ever apps (ACC-11-05); **an App Work whose
      `managedSubdomain` label was allocated on a dedicated apps apex resolves to `<label>.<apps-apex>` and never to a
      host under `EVER_WORKS_DOMAIN`, with the default resolver (no binding) and with a bound published-host port
      both covered (ACC-11-41)**; **a reorder writes `order` for every item of its section, and the merged
      `global ∪ scopeKey` pinned view is what the 6-pin rule counts (ACC-11-47)**.
      **Done when**: both specs pass with 100% branch coverage of the two modules, including the
      apps-apex-never-platform-domain case.

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
      **Read APW-06's runtime state (audit round — ACC-11-42).** Inject APW-06's
      `WorkAppRuntimeStateRepository` (APW-06 T17, `work_app_runtime_states`, columns `paused`/`pausedAt`,
      `removedAt`, APW-06 plan §7.2 `:1000-1001`) `@Optional()` in `AppLauncherService` and call a new
      `findStateForWorks(workIds)` for the candidate set; no row, or the repository being unbound before APW-06
      lands, means "not paused". APW-10's quarantine is read through the same optional injection of its
      `AppsTierPolicy` port (APW-06 T3 / APW-10), never by a direct table read. Nothing here writes those tables.
      **Test**: `packages/agent/src/database/repositories/__tests__/app-launcher-preference.repository.spec.ts`
      (**new**) — two writers changing different items both persist and the same item takes the last write
      (ACC-11-20); re-sending identical values changes nothing; extending
      `packages/agent/src/database/repositories/__tests__/work.repository.spec.ts`,
      `work-deployment.repository.spec.ts`, `work-custom-domain.repository.spec.ts` for the three new methods (preview
      and non-`READY` rows excluded; archived Works excluded; Organization filter); and
      `work-deployment.repository.spec.ts` also pins that the latest row is chosen by `(createdAt DESC, id DESC)`
      and that a `SUPERSEDED` row (APW-06) is skipped (ACC-11-44).
      **Done when**: all repository specs pass in the SQLite unit lane, and a Work with a paused runtime-state row
      never appears in a listing built by the service (ACC-11-42).

- [ ] **T6. `AppLauncherService`.**
      **Create** `packages/agent/src/app-launcher/app-launcher.service.ts` (**new**) —
      `listForUser(user, scope, platforms, { includeHidden, limit })` and
      `savePreferences(userId, scope, changes, platforms)` per [plan §4.1–4.2](./plan.md), including the
      eligible-key set, `unknownItem` / `cannotHideCurrent` rejections, whole-save refusal on pin limit
      (throws `AppLauncherPinLimitError`), and the 500-row prune.
      **Create** `packages/agent/src/app-launcher/app-launcher.errors.ts` (**new**) — `AppLauncherPinLimitError`
      carrying the `{ code: 'pinLimit', limit }` body the controller maps to `422` (plan §3.3, §4.5).
      Inject `ManagedHostRootResolver` (**new** token in
      `packages/agent/src/app-launcher/managed-host-root.resolver.ts`) with a **default binding that resolves the
      apps apex for kind `app`** — `EVER_WORKS_APPS_DOMAIN` when set, else `EVER_WORKS_DOMAIN` — the platform root
      for every other kind, and `null` when neither is configured (so no host is invented).
      `packages/agent/src/config/index.ts` has no accessor for either variable, so it is read from `process.env`
      as `packages/agent/src/ever-works-providers/subdomain-allocator.service.ts:192` does
      (`process.env.EVER_WORKS_DOMAIN?.trim() || 'ever.works'`). Inject
      `APP_PUBLISHED_HOSTS` (`AppPublishedHostsPort.primary(workId)`, bound by APW-06's `AppHostsService`) and
      `MANAGED_HOST_ROOT_RESOLVER` `@Optional()` and appended last, so APW-11 P1 is correct **before** APW-06 T48
      binds `AppManagedHostRootResolver` and the bound value wins when it is there (plan §4.6, spec FR-55). Never
      synthesise `<label>.<EVER_WORKS_DOMAIN>` for a Work whose label was allocated elsewhere.
      Read the item name from `WorkAppSpecState.displayName` when the Work has one (APW-03 plan §3.1,
      `varchar(80)`), else `work.name`, capped at 100 (spec FR-57).
      Set `meta.appWorksAvailable` from the App Works gate (spec FR-64) and mark `manageState: 'notLive'` for a
      paused, removed or quarantined App Work (spec FR-56).
      **Create** `packages/agent/src/app-launcher/app-launcher.module.ts` and `index.ts` (**new**) —
      `TypeOrmModule.forFeature([AppLauncherPreference])`, providers, exports.
      **Test**: `packages/agent/src/app-launcher/__tests__/app-launcher.service.spec.ts` (**new**) — an App Work with a
      `READY` production deployment appears with no setting (ACC-11-09); a directory Work appears only when exposed
      and only for members who can view it (ACC-11-11); a failed latest deployment after an earlier success carries
      `lastDeployFailed` (ACC-11-12); a preview deployment alone never lists (ACC-11-13); Work pins differ between
      two Organizations while Ever app pins are shared (ACC-11-21); 200 cap with `truncated`;
      **a `CANCELED` or `SUPERSEDED` latest row chips nothing and a `ROLLED_BACK` one carries `lastDeployFailed`
      (ACC-11-44)**; **an item whose `displayName` (with a community-build suffix) is set is named from it
      (ACC-11-43)**; **a paused / removed / quarantined App Work is `notLive` with its preference row kept
      (ACC-11-42)**; **the default resolver alone never yields a host under `EVER_WORKS_DOMAIN` for a kind-`app`
      Work, and a bound fake published-host port wins (ACC-11-41)**;
      `app-launcher.save.spec.ts` (**new**) — the current platform has no hide (ACC-11-06); a seventh pin refuses the
      whole save (ACC-11-19); a key for another Organization's Work is rejected with a reason byte-identical to a
      nonexistent Work's (ACC-11-22); **a save in Organization B leaves Organization A's pins and orders untouched
      (ACC-11-47)**.
      **Done when**: no test can make a preview-only or never-`READY` Work appear, an inaccessible
      key's rejection is byte-identical to a nonexistent key's, and no test can make an App Work resolve under the
      platform's own domain while its label belongs to the apps apex.

- [ ] **T7. Exposure on Work update.**
      **Modify** `packages/agent/src/dto/update-work.dto.ts` — optional `appLauncherExposed?: boolean |
null` with `@IsOptional()` and a boolean-or-null validator; `@ApiPropertyOptional` description
      "Show this Work in members' App Launcher (null = kind default)".
      **Modify** `packages/agent/src/services/work-lifecycle.service.ts` `updateWork` (line 851) — after
      `ensureCanEdit`, persist the field when present and changed, then log Activity with
      `actionType: ActivityActionType.APP_LAUNCHER` and `action` `app.launcher.exposed` or `app.launcher.hidden`
      (Resolution R-2), `status: ActivityStatus.COMPLETED`, an English `summary` that names neither the Work nor
      the address, and `metadata: { explicit, previousEffective }` (spec FR-61, plan §4.4). "Changed" compares
      `(storedValue, storedExplicit)` with `(newValue, newExplicit)`, so `null → true` on an `app` Work is a real
      change and `null → null` is a no-op that writes nothing.
      **Modify** `packages/agent/src/entities/activity-log.types.ts` — append one member
      `APP_LAUNCHER = 'app_launcher'`.
      **Modify** `packages/agent/src/activity-log/feed-kind.ts` — add
      `[ActivityActionType.APP_LAUNCHER]: 'work'` to `FEED_KIND_RULES` (the table starts at `:53`). The member must
      have an entry: `feed-kind.spec.ts:14-18` fails on any enum member without one, so this task cannot land
      without the classification, and `'work'` is the correct bucket — an exposure change is Work metadata
      changing, not a delivery and not a held decision (APW11-G05). If the decision is ever revisited it is a
      _different_ value in the same table, never an omission.
      **Modify** `packages/agent/src/services/work-query.service.ts` — add
      `appLauncher: { exposed, effectiveExposed, live }` to the Work detail payload (one extra batched
      read of latest `READY` deployment + verified domains, reusing T5 methods).
      **Test**: `packages/agent/src/services/__tests__/work-lifecycle.app-launcher-exposure.spec.ts`
      (**new**) — one Activity row per real change with `actionType: 'app_launcher'`, the dotted `action`, the
      `summary`, `status` and `metadata` of plan §4.4, none on a no-op, no address or Work name in any field, viewer
      refused (ACC-11-16, ACC-11-46); extend
      `packages/agent/src/entities/__tests__/activity-log.types.spec.ts` for the new member **and** run the existing
      `packages/agent/src/activity-log/feed-kind.spec.ts`, which must pass with the new entry and fail without it
      (APW11-G05); extend `packages/agent/src/services/__tests__/work-query.service.spec.ts` for the
      `appLauncher` payload.
      **Done when**: `PUT /api/works/:id { "appLauncherExposed": true }` by an editor writes one
      Activity entry, and by a viewer answers the existing edit-rights error, and
      `pnpm --filter @ever-works/agent test -- feed-kind activity-log.types work-lifecycle.app-launcher-exposure`
      is green.

## P1.3 — API

- [ ] **T8. Platform catalog service.**
      **Create** `apps/api/src/app-launcher/platform-catalog.schema.ts` and
      `apps/api/src/app-launcher/platform-catalog.service.ts` (**new**) per [plan §5.2](./plan.md): env
      `EVER_WORKS_PLATFORM_CATALOG_REPO` (regex `^ever-works\/[a-z0-9-]+$`), `_REF`, `_ENV`, `_SELF_ID`;
      8,000 ms fetch timeout; icons inlined as data URIs ≤ 16,384 bytes; SVG deny patterns; ≤ 24 entries;
      success TTL 3,600,000 ms, failure TTL 30,000 ms, `:last-good` entry without TTL.
      **Add the non-production source override** `EVER_WORKS_PLATFORM_CATALOG_BASE_URL` (plan §5.2): honoured
      **only** when `NODE_ENV !== 'production'` and the programme's `EVER_WORKS_E2E_FAKES` switch is set, read
      through the same kind of getter that guards the existing lane switches
      (`config.subscriptions.bypassSeatLimitsInE2E()`, `packages/agent/src/config/index.ts:824-829`) — APW-13 owns
      the `EVER_WORKS_E2E_FAKES` accessor, so until it lands read both variables in one place in this service with
      the production branch first. It replaces the raw host for
      `platforms.json` **and** the icons, and every other rule — scheme, size, SVG deny patterns, entry cap — still
      applies while it is active. A browser route handler cannot substitute for it: the fetch happens in the API
      process (APW11-G06).
      **Log the environment** when it is unset outside production
      (`app_launcher.catalog.environment_unset`, error level, counted) — spec FR-10 and plan §5.2; T31 sets it per
      manifest.
      **Test**: `apps/api/src/app-launcher/platform-catalog.service.spec.ts` (**new**) — 25th entry
      dropped, `javascript:` and `http:` dropped (ACC-11-08), oversize icon → entry kept without icon, SVG with
      `<script` rejected, blocked source with no prior read → `catalogAvailable: false` and last-good served after a
      prior read (ACC-11-07), entries for `stage` differ from `production` and an entry without a `develop` URL is
      absent for `develop` (ACC-11-05), `evil/platforms` repo refused at boot; **the base-URL override is ignored
      with `NODE_ENV=production` and applied when the fakes switch is on (ACC-11-51)**; **the service reads
      `fixtures/platforms.fixture.json`, the fixture the catalogue drafts ship, and the same fixture's
      `javascript:`/`http:`/25th-entry cases are the ones asserted above**; **an unset `_ENV` outside production
      logs the error**.
      **Done when**: with the fixture catalog the service returns entries for `stage` that differ from
      `production`, an entry lacking a `develop` URL is absent for `develop`, and a production boot with the
      override set still reads `ever-works/platforms`.

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
      **Modify** `packages/agent/src/config/index.ts` — add **one** accessor,
      `config.appLauncher.isEnabled()`, accepting the platform's existing `truthy()` set
      (`'true' | '1' | 'yes'` — the values `api.controller.ts:92` accepts today, so no installation that works
      today stops working), and make the guard and `api.controller.ts` both call it, so the web UI and the API can
      never disagree (APW11-G12, plan §7). An unset or unparseable value is **off**.
      **Modify** `apps/api/src/api.controller.ts` — `features.appLauncherEnabled:
config.appLauncher.isEnabled()`.
      **Modify** `apps/web/e2e/flow-config-public-contract.spec.ts` — add `appLauncherEnabled` to the sorted feature
      key list at `:120-125`, and `apps/api/src/api.controller.spec.ts` — its `it.each` rows for the new key,
      including `'1'` and `'yes'`.
      **Test**: `apps/api/src/app-launcher/app-launcher.controller.spec.ts` (**new**) — every P1 row of
      [plan §10.2](./plan.md): throttle metadata 60 reads / 30 writes (ACC-11-26), 404 on every route with the env
      unset (ACC-11-28); the `features.appLauncherEnabled` rows above (ACC-11-28 half); the `422 pinLimit` body
      declared by `app-launcher.errors.ts`; `app-launcher-platforms.controller.spec.ts` (**new**) — `@Public()` and the 1-hour cache header
      (ACC-11-27); and, replacing the former `apps/api/test/` suite (Resolution R-22),
      `apps/api/src/app-launcher/app-launcher.registry.integration.spec.ts` (**new**, plan §10.2) — in-memory
      better-sqlite3 with `ENTITIES`, 200 live Works for one person, 50 calls: p95 < 300 ms and no response holds more
      than 200 items (ACC-11-25); run `cd apps/api && pnpm test -- app-launcher`.
      **Done when**: `cd apps/api && pnpm test` is green; with the env unset every route answers 404; and
      `pnpm --filter ever-works-web test:e2e flow-config-public-contract` is green with the new key.

## P1.4 — The web component (host-fed mode)

- [ ] **T10. Package scaffold.**
      **Create** `packages/app-launcher/package.json` (**new**, `@ever-works/app-launcher`,
      `"private": true`, `"type": "module"`, dependency `lit`), `tsup.config.ts`, `tsconfig.json`,
      `vitest.config.ts` (`happy-dom`), `src/index.ts`, `src/types.ts`, `src/strings.ts`,
      `scripts/check-size.mjs` (gzip of `dist/index.js` ≤ 30,720 bytes, run by `pnpm test`).
      **Set `noExternal: ['lit']` in `tsup.config.ts`** (plan §6.1): tsup externalises `dependencies` by default,
      which would leave Lit out of `dist/index.js` — so the size check would measure the wrong artifact and T27's
      static fixture pages could not resolve the bare import. The precedent is
      `packages/plugins/k8s/tsup.config.ts:5`. One self-contained ESM file, no import map (APW11-G15).
      **Add the licence note** for `lit` (BSD-3-Clause) and `happy-dom` (MIT) beside the repository's dependency
      notes, and regenerate `pnpm-lock.yaml` in this PR — neither package appears in it today.
      **Modify** `apps/web/package.json` — `"@ever-works/app-launcher": "workspace:*"` in `dependencies` (next to
      `@ever-works/contracts`/`@ever-works/plugin` at `:37-38`). This belongs in P1, not in T28: the web imports the
      package from T14, and the Docker web build works from a `turbo prune`d tree
      (`.deploy/docker/web/Dockerfile:61,95,102`, `turbo build --filter=ever-works-web...`), so an undeclared
      workspace package is neither linked nor built and the web image fails to resolve the import (APW11-G14).
      `pnpm-workspace.yaml` already globs `packages/*`, so no workspace edit is needed.
      **Test**: `scripts/check-size.mjs` fails `pnpm --filter @ever-works/app-launcher test` when the gzip of
      `dist/index.js` exceeds 30,720 bytes (ACC-11-35); `packages/app-launcher/src/__tests__/index.spec.ts` (**new**)
      imports the entry twice without a `customElements.define` error; `scripts/check-size.mjs` also asserts the
      built file contains no bare `from 'lit'` import.
      **Done when**: `pnpm --filter @ever-works/app-launcher build test` passes on an empty element, and
      `pnpm turbo build --filter=ever-works-web...` builds `@ever-works/app-launcher` first (APW11-G14).

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
      cancellable `:item-activate`, `:manage`, `:retry`, **`:empty-action` with
      `{ action: 'createAppWork' | 'goToWorks' }` emitted by the S8 button (the element never navigates itself in
      host-fed mode, and it uses `appWorksAvailable` — the property, else the registry's `meta.appWorksAvailable`
      — to choose which button to render)**; `--ever-app-launcher-*` custom properties; no
      global style insertion; guarded `customElements.define`.
      **Test**: `packages/app-launcher/src/__tests__/ever-app-launcher.spec.ts` (**new**) — sections Pinned / Ever apps
      / Your apps / Manage apps in order and 3 vs 2 columns (ACC-11-02); 6 skeleton tiles at 88 px while `loading`
      (ACC-11-03); **You're here** not a link (ACC-11-06); cancelled activation opens nothing (ACC-11-40);
      **both empty states render the right button and dispatch `:empty-action` with the right `detail`, and no
      navigation happens inside the element (ACC-11-48)**; focus trap;
      no `<style>` added to `document.head`.
      **Done when**: the size check passes and the spec is green.

## P1.5 — Web integration

- [ ] **T13. Flag helper and public config plumbing.**
      **Create** `apps/web/src/lib/feature-flags/app-launcher.ts` (**new**, `server-only`) —
      `isAppLauncherEnabled(distinctId)`: `features.appLauncherEnabled === true` **and** (PostHog not configured
      **or** `isFeatureEnabled('app-launcher', distinctId) === true` within 1,500 ms). Any error or timeout →
      `false`.
      **Name the reader (APW11-G12).** No web code reads `/api/config` today (`git grep` in `apps/web/src` finds
      no caller), so the helper must own the read: a server-side `fetch(`${API_URL}/api/config`, { cache: 'no-store',
signal: AbortSignal.timeout(1_500) })`, the boolean read from `features.appLauncherEnabled`, and `false` on
      any non-`200`, parse error or timeout — the same fail-closed posture as the PostHog half. It must not read
      `EVER_WORKS_APP_LAUNCHER_ENABLED` from its own environment: the web and the API are separate deployments, and
      a web-side copy of the environment would drift from the API's answer.
      **Modify** `apps/web/src/app/[locale]/(dashboard)/layout.tsx` and `layout-client.tsx` — compute
      once, pass `appLauncherEnabled` to `DashboardHeader`, the palette context and the settings layout.
      **Test**: `apps/web/src/lib/feature-flags/app-launcher.unit.spec.ts` (**new**) — the fail-closed
      matrix (config off; config unreachable; config times out; PostHog unset; flag true/false/undefined/timeout)
      (ACC-11-28 flag half).
      **Done when**: the spec passes, a PostHog timeout yields `false`, and a `/api/config` timeout yields `false`.

- [ ] **T14. BFF route and React wrapper.**
      **Create** `apps/web/src/app/api/me/apps/route.ts` (**new**) — `GET` proxy that forwards only `includeHidden`
      as a query parameter and **must carry the workspace scope**. Do not copy
      `apps/web/src/app/api/usage/costs/[section]/route.ts` as the plan's earlier draft suggested: that route sets
      only `Authorization` (`route.ts:35-40`), and a request without the scope header is resolved by the API as
      **personal** scope (`apps/api/src/scope/scope-resolver.middleware.ts:41-45`,
      `apps/api/src/scope/session-scope.guard.ts:124-128`), so no Organization-scoped Work would ever be listed.
      Proxy through `serverFetch` (`apps/web/src/lib/api/server-api.ts:102-131`, which reads `x-ever-workspace` and
      sets the API scope header at `:108-120`) or reproduce those four lines, and assert the header in the spec
      below (APW11-G04).
      **Create** `apps/web/src/components/app-launcher/AppLauncherButton.tsx` and
      `AppLauncherProvider.tsx` (**new**) per [plan §6.4](./plan.md): lazy element import in `useEffect`,
      **a 5-minute module cache keyed by the serialized workspace scope** — an entry from another scope is never
      rendered, and the element closes when the scope changes (spec FR-66, ACC-11-49) —
      `browserApiFetch('/api/me/apps')`, strings from
      `useTranslations('dashboard.appLauncher')`, `:manage` → `ROUTES.DASHBOARD_SETTINGS_APP_LAUNCHER`,
      `:empty-action` → `ROUTES.DASHBOARD_WORKS_NEW` (with the `app` kind pre-chosen) or `ROUTES.DASHBOARD_WORKS`
      (`apps/web/src/lib/constants.ts:144-145`), the element's `appWorksAvailable` from
      `meta.appWorksAvailable`, chunk-load failure renders a disabled control with
      `dashboard.appLauncher.controlUnavailable`.
      **Modify** `apps/web/messages/en.json` and the 20 sibling locale files — the `dashboard.appLauncher.*` keys
      this task renders from [plan §8](./plan.md), including `controlUnavailable` and `emptyActionFailed`, in this
      same PR (README §7 rule 11, APW11-G23).
      **Create** `apps/web/src/lib/app-launcher/app-launcher-telemetry.ts` (**new**) — closed union of the
      four events in [plan §9.1](./plan.md), copying `apps/web/src/lib/help/help-telemetry.ts`.
      **Modify** `apps/web/src/components/dashboard/DashboardHeader.tsx` — optional `appLauncher?: boolean`
      prop; render `<AppLauncherButton />` after the Help button (line 149). Nothing else in the header
      moves.
      **Test**: `apps/web/src/components/app-launcher/AppLauncherButton.unit.spec.tsx` (**new**) — a second open within
      5 minutes renders from cache with no fetch (ACC-11-03), refetch after, **a switch to another Organization
      closes the element and never renders the previous scope's items (ACC-11-49)**, **`:empty-action` routes to the
      right constant for each detail and a failed push renders the failure copy (ACC-11-48)**, the telemetry payload
      of three tile opens has no host, URL or Work name (ACC-11-32); `apps/web/src/app/api/me/apps/route.unit.spec.ts`
      (**new**) — forwards only `includeHidden`, **forwards the workspace scope header to the API**, never puts the
      token in the upstream URL (ACC-11-24 unit half, APW11-G04);
      `apps/web/src/components/dashboard/DashboardHeader.app-launcher.unit.spec.tsx` (**new**) — without the prop the
      right cluster is unchanged, with it the control is last (ACC-11-01).
      **Done when**: the three specs pass, the message spec of T19 sees every `dashboard.appLauncher.*` key in all
      21 files, and `apps/web/e2e/command-palette.spec.ts` passes unchanged with the flag off.

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
      **Modify** `apps/web/src/app/[locale]/(dashboard)/settings/layout.tsx` — the nested server layout renders the
      nav and already computes a flag of its own (`isFleetEnabled()` at `:21`); a parent App Router layout cannot
      pass props into it, so this file calls `isAppLauncherEnabled` and passes `appLauncherEnabled` to
      `SettingsLayoutClient` with a default of `false` (APW11-G13).
      **Create** `apps/web/src/app/[locale]/(dashboard)/settings/app-launcher/page.tsx` (**new**, server;
      `notFound()` when disabled), `apps/web/src/components/settings/AppLauncherSettings.tsx` (**new**),
      `apps/web/src/lib/api/app-launcher.ts` (**new**, server-only `serverFetch`), and
      `apps/web/src/app/actions/settings/app-launcher.ts` (**new**, `saveAppLauncherPreferencesAction`).
      Rows: Show toggle, Pin toggle (7th disabled with tooltip), Move up/down, `Alt+↑/↓`, native drag
      handle; 500 ms debounced batch save; `Saving…`/`Saved`/`Couldn't save. Try again.`; a reorder that writes
      `order` for **every** item of the section it moves within (spec FR-62); past 200 eligible items the header
      **Showing 200 of {count}** with the `Filter apps` control (spec FR-63).
      **Modify** `apps/web/messages/en.json` and the 20 sibling locale files — the
      `dashboard.settings.appLauncher.*` and `dashboard.settings.tabs.appLauncher` keys this task renders from
      [plan §8](./plan.md), including the section headings, the **Hidden by the Work** row action, the filter and
      the count, and the accessible names of the Show, Pin and drag controls, in this same PR (APW11-G23).
      **Test**: `apps/web/src/components/settings/AppLauncherSettings.unit.spec.tsx` (**new**) — debounce batches
      changes into one save, pin counter, seventh pin disabled with "Six pins is the limit. Unpin one first."
      (ACC-11-19, ACC-11-18 unit half); **a move sends `order` for every row of its section (ACC-11-47)**; **past 200
      items the count line and filter render and every eligible item stays reachable (ACC-11-47)**; extend
      `apps/web/src/app/[locale]/(dashboard)/settings/settings-layout-client.unit.spec.tsx`
      — the tab renders only when enabled (ACC-11-28) — and add
      `apps/web/src/app/[locale]/(dashboard)/settings/layout.unit.spec.tsx` (**new**) for the prop being passed and
      defaulting to `false`.
      **Done when**: reloading the page after each control shows the saved state, and the message spec of T19 finds
      every `dashboard.settings.appLauncher.*` key in all 21 locales.

- [ ] **T17. Work setting toggle, on both surfaces.**
      **Create** `apps/web/src/components/works/detail/settings/AppLauncherExposureSetting.tsx` (**new**) —
      reads `work.appLauncher`, disabled with the not-live copy, read-only for viewers.
      **Do not save through `useSettings().handleUpdate`** (APW11-G02). `handleUpdate`
      (`apps/web/src/components/works/detail/settings/SettingsContext.tsx:76-92`) submits the whole General form to
      `updateWork`, whose zod object (`apps/web/src/app/actions/dashboard/works.ts:596-614`) lists only
      `name`/`description`/`owner`/`organization`/`websiteTemplateId`/`readmeConfig` and therefore **strips**
      `appLauncherExposed`, after which the action calls `workAPI.update` (`:639`) and `workAPI.updateReadme`
      (`:641`) — the choice would never persist and every toggle would rewrite the Work's README.
      **Create** `setWorkAppLauncherExposureAction(workId, value: boolean | null)` in
      `apps/web/src/app/actions/dashboard/works.ts` instead: it calls `PUT /api/works/:id` with exactly
      `{ appLauncherExposed: value }`, saves on the toggle, renders `Saved` / `Couldn't save. Try again.` in place,
      and **never** calls `updateReadme`.
      **Create** `apps/web/src/components/works/detail/overview/AppLauncherExposureCard.tsx` (**new**) and mount it
      in `apps/web/src/app/[locale]/(dashboard)/works/[id]/page.tsx` (APW11-G03): the settings page answers
      `notFound()` unless `canAccessSettings(work.userRole)` (`works/[id]/settings/page.tsx:31-33`, MANAGER per
      `apps/web/src/lib/permissions.ts:70-71`) while the API grants the change to EDITOR
      (`packages/agent/src/services/work-ownership.service.ts:142-143`), so editors and viewers need the Overview
      card. Both surfaces render the same state and use the same action; the settings card is not moved or changed.
      **Modify** `apps/web/src/components/works/detail/settings/GeneralSettings.tsx` — mount the setting at the
      end of the card, only when the launcher is enabled.
      **Modify** `apps/web/src/components/works/detail/settings/SettingsForm.tsx` (or the `SettingsProvider`
      context) and `apps/web/src/app/[locale]/(dashboard)/works/[id]/settings/page.tsx` — carry the
      `appLauncherEnabled` prop from T13 to `GeneralSettings`, defaulting to `false` (APW11-G13).
      **Modify** the web Work type in `apps/web/src/lib/api/work.ts` — add the optional `appLauncher`
      object **and** `appLauncherExposed?: boolean | null` to `UpdateWorkDto` (`:111`) so the action's body is typed.
      **Modify** `apps/web/messages/en.json` and the 20 sibling locale files — the
      `dashboard.workDetail.settings.appLauncher.*` keys from [plan §8](./plan.md), including
      `resetToDefault`, the toggle's accessible name and the save states, in this same PR (APW11-G23).
      **Test**: `apps/web/src/components/works/detail/settings/AppLauncherExposureSetting.unit.spec.tsx`
      (**new**) — a viewer sees it read-only with "Only editors can change this." (ACC-11-15); a not-live Work shows it
      disabled with the stored choice kept (ACC-11-17); **the toggle calls the dedicated action with exactly one field
      and never `updateWork`/`updateReadme` (ACC-11-46)**; **`Reset to default` sends `null` and offers itself only
      when an explicit choice is stored (ACC-11-46)**;
      `apps/web/src/components/works/detail/overview/AppLauncherExposureCard.unit.spec.tsx` (**new**) — viewer
      read-only copy, editor toggle, same state as the settings card (ACC-11-45).
      **Done when**: the two specs pass, `SettingsForm.unit.spec.tsx` passes unchanged with the flag off, and no
      path in the launcher calls `updateReadme`.

## P1.6 — Catalog repository, i18n, e2e, docs

- [ ] **T18. Land the `ever-works/platforms` catalog content.** _(owner action — outside this monorepo)_
      **The repository exists** (created 2026-09-17; `BUILD-READINESS.md` §6 item 4), so this task is no longer
      "create it": it reviews the drafts in [`catalog-draft/`](./catalog-draft/), supplies the per-environment
      addresses, and lands them as the repository's first commit content, with the layout, schema and CI exactly as
      [plan §5.1](./plan.md): `platforms.json`, `schema/platforms.schema.json`,
      `.github/workflows/validate.yml`, `fixtures/platforms.fixture.json`, `icons/ever-works.svg`,
      `icons/ever-gauzy.svg`, `icons/ever-teams.svg`, `README.md`, `CONTRIBUTING.md`, `LICENSE`; first entries: Ever
      Works, Ever Gauzy, Ever Teams with owner-supplied addresses per environment; tag `v1.0.0`.
      **Decide read access** (plan §5.1): either the repository is made public, as the sibling listing
      `ever-works/templates` is, or the reader carries a token. The reader fetches over the raw host, so a private
      repository with neither makes every read fail and leaves **Ever apps** showing S9 forever. Record whichever
      answer is chosen here.
      **Name an owner per entry** beyond the first three: README §1 names **Ever Rec** as a launcher destination and
      it is not in the seeded set, so it needs an entry and a named owner (spec §9 question 3), and so does every
      platform added later.
      **Test**: that repository's `.github/workflows/validate.yml` (schema, icon size, https-only, unique ids, ≤ 24
      entries) passes on the tag and fails on a fixture pull request adding a 25th entry; `apps/api`'s
      `platform-catalog.service.spec.ts` reads `fixtures/platforms.fixture.json` from the same draft set (T8).
      **Done when**: its `validate.yml` passes, the chosen answer on read access is recorded, and
      `EVER_WORKS_PLATFORM_CATALOG_REF=v1.0.0` on stage renders the catalog's tiles.

- [ ] **T19. i18n keys — cross-locale completeness.**
      **Modify** `apps/web/messages/en.json` — every key in [plan §8](./plan.md) (P1 keys only; the three
      P2 keys land in T27), then the same keys in the 20 sibling locale files in `apps/web/messages/`.
      Leaf names camelCase with no literal `.`.
      **The keys themselves land with their surfaces (APW11-G23).** T14 (panel and palette context keys), T16
      (Manage apps and settings-tab keys) and T17 (Work-setting keys) each add the group they first render in their
      own PR, because README §7 rule 11 and this file's task rules both require each task to keep `develop`
      deployable; this task is the **completeness** pass — it verifies all 21 files carry every key, fills any
      locale a component task added only to `en.json`, and owns nothing that a component already renders.
      **Test**: `apps/web/src/lib/app-launcher/__tests__/app-launcher-messages.unit.spec.ts` (**new**) — every P1 key of
      plan §8 resolves to a non-empty string in all 21 locale files, no leaf name contains a dot, and every
      `t('…')` key used by `AppLauncherButton.tsx`, `AppLauncherSettings.tsx`, `AppLauncherExposureSetting.tsx` and
      `AppLauncherExposureCard.tsx` exists in `en.json` (ACC-11-31).
      **Done when**: the spec passes and `pnpm --filter ever-works-web build` reports no missing messages.

- [ ] **T20. P1 e2e.**
      **Create** `apps/web/e2e/flow-app-launcher-apps.spec.ts` (the file ACCEPTANCE.md E2E-12 names; owned by this epic
      per Resolution R-22 — APW-13 references it and does not create it), `apps/web/e2e/app-launcher-manage.spec.ts`,
      `apps/web/e2e/app-launcher-exposure.spec.ts`, `apps/web/e2e/app-launcher-keyboard-a11y.spec.ts`,
      `apps/web/e2e/app-launcher-flag-off.spec.ts` (**new**) per [plan §10.5](./plan.md) and
      `apps/web/e2e/helpers/app-launcher-seed.ts` (**new**). Prefer `getByTestId` for tiles
      (`app-launcher-tile-<key>`).
      **Modify** `.github/workflows/e2e.yml` — `EVER_WORKS_APP_LAUNCHER_ENABLED: 'true'` and
      `E2E_APP_LAUNCHER_SEED: 'true'` in the main shard's env block (the `env:` at `:261`, beside
      `SUBSCRIPTIONS_ENABLED: 'true'` at `:351`), **and** a new, separately gated job that boots the same local stack
      with `EVER_WORKS_APP_LAUNCHER_ENABLED` **unset** and runs only `app-launcher-flag-off.spec.ts`. The file sets
      the API environment once for the whole prebuilt stack and has no per-spec toggle, so this is the only way both
      lanes can run in the PR without weakening ACC-11-28 (APW11-G08). `EVER_WORKS_PLATFORM_CATALOG_BASE_URL` points
      the API at the fixture catalog in both jobs, with `EVER_WORKS_E2E_FAKES: '1'` (T8, APW11-G06).
      **Seed through the route, never the database** (APW11-G07). The lane's API runs on in-memory sqlite
      (`DATABASE_IN_MEMORY: 'true'`, `e2e.yml:271-272`) and no e2e helper touches a database — the file the earlier
      draft named, `apps/web/e2e/flow-org-upgrade-from-account.spec.ts`, is API-only. The helper
      `apps/web/e2e/helpers/app-launcher-seed.ts` therefore calls T33's `POST /api/e2e/app-launcher/seed` (404 unless
      `NODE_ENV !== 'production'` and `E2E_APP_LAUNCHER_SEED === 'true'`) and names the rows each case needs: one Work
      with a `READY` production deployment + managed subdomain, one with an earlier `READY` and a later `ERROR`
      deployment, one with a verified production custom domain, one never deployed, and one with
      `kind: 'app'` written as the raw varchar until APW-01 lands.
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
      (ACC-11-29); axe over control, panel and **Manage apps** with no new violation (ACC-11-30); **the exposure toggle
      from the Work Overview by an editor, with the settings page agreeing (ACC-11-45)**; **the empty state's two
      actions reaching their routes (ACC-11-48)**; **the seeded states themselves (ACC-11-52)**.
      **Done when**: the five specs pass in both lanes, `command-palette.spec.ts`,
      `flow-org-settings-persistence.spec.ts` and the Work settings specs pass unchanged, and the flag-off job's log
      shows the variable absent from the API environment.

- [ ] **T21. G-09 copy guard.**
      **Create** `apps/web/src/lib/app-launcher/__tests__/no-sso-claims.unit.spec.ts` (**new**) — loads
      `dashboard.appLauncher`, `dashboard.settings.appLauncher` and
      `dashboard.workDetail.settings.appLauncher` from every locale file and fails on
      `/single sign-on|\bsso\b|one login|already signed in/i` (English) plus
      [`no-sso-terms-draft.md`](./no-sso-terms-draft.md) — the per-locale term list this epic ships beside the spec
      (APW11-G21), whose rows carry a review state so an unconfirmed locale is visible rather than silently passing.
      Remove the prohibition only when APW-12 ships (TRACKER note).
      **Test**: that spec (ACC-11-33); run `pnpm --filter ever-works-web test -- no-sso-claims`.
      **Done when**: adding `"Single sign-on"` to any launcher key makes the spec fail, and adding a listed
      translated phrase to a reviewed locale makes it fail too.

- [ ] **T22. Docs.**
      **Create** `docs/features/app-launcher.md` (**new**) — what appears, why a Work appears, pins and
      hides, exposure, what the launcher does not do (no sign-on). **Modify** `apps/docs/sidebarsPlatform.ts`
      to list it. **Modify** `docs/features/managed-hosting.md` "Related" list with one link. **Modify**
      `docs/specs/features/app-works/TRACKER.md` — APW-11 impl status.
      **Modify** `docs/specs/features/app-works/user-docs/app-works.md` — the **The App Launcher** section
      (`:135-138`) currently says "Turn on **Show in App Launcher** in an App Work's settings to add its live URL",
      while spec FR-19 defaults an App Work to **on** and ACC-11-09 asserts it appears "with no setting changed".
      Reword it additively — App Works appear once live, and any other Work appears when **Show in App Launcher** is
      turned on — keeping the existing sentence about pinning, hiding and reordering (APW11-G25).
      **Test**: run `pnpm --filter ever-works-docs build`; T21's pattern applied to `docs/features/app-launcher.md` finds
      nothing; the reworded user-docs section matches FR-19's default.
      **Done when**: `pnpm --filter ever-works-docs build` has no broken links and the user docs no longer tells an
      App Work's owner to switch on something that is already on.

- [ ] **T23. P1 ship gate.**
      Root `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`; enable
      `EVER_WORKS_APP_LAUNCHER_ENABLED=true` on stage (with `EVER_WORKS_PLATFORM_CATALOG_{REPO,REF,ENV,SELF_ID}`
      from T31); walk ACC-11-01…ACC-11-54.
      **Modify** `docs/specs/features/app-works/ACCEPTANCE.md` — the APW-11 rows point at the files named in T1–T21 and
      at the 14 ids ACC-11-41…ACC-11-54 (sent to the program owner of that file) — and
      `docs/specs/features/app-works/TRACKER.md` — APW-11 P1 row.
      **Test**: the PR lane runs T20's five specs in both jobs; ACC-E2E-12's nightly
      `apps/web/e2e/flow-app-works-live-launcher.spec.ts`
      (APW-13) passes against stage.
      **Done when**: all 54 are ticked on stage, and flipping `EVER_WORKS_APP_LAUNCHER_ENABLED` off and on again on
      stage leaves every stored preference and exposure value unchanged (ACC-11-50).

---

# Phase P2 — The launcher inside other Ever platforms (Wave 3)

_Delivers spec FR-45…FR-52 and ACC-11-34…ACC-11-40. Blocked by APW-12 (token issuance, identity-provider
facade). The `ManagedHostRootResolver` binding is **APW-06 T48 in P1** (R-16) and only replaces the default T6
ships, so it is not a P2 blocker (APW11-G01)._

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

- [ ] **T28. Extraction and publication.** _(owner decision — README §8 open question 7; registered as APW-11
      question 2)_
      Extract `packages/app-launcher` with history (`git subtree split`) into the owner-chosen public
      repository, set `"private": false`, publish under the owner-chosen npm scope, and switch
      `apps/web` to the published version. Document the element API from [plan §6.2](./plan.md) in that
      repository's README.
      **Still needs the owner (APW11-G21/EXT-30):** the target repository, the npm scope, and a **names-only**
      publish credential provisioned before P2 starts (no secret value in this public repository, per README
      rule 10 and Constitution VII). P1 is unaffected — the package is `"private": true` in the monorepo, is
      **declared by `apps/web`'s `package.json` from T10**, and mounts in the header from T14, so nothing here blocks
      Wave 1 and nothing shipped in P1 is withdrawn by the extraction.
      **Modify** `apps/web/package.json` — the dependency points at the published version.
      **Test**: the extracted repository's CI runs the moved `src/__tests__/*.spec.ts` and `scripts/check-size.mjs`;
      in this monorepo `apps/web/e2e/app-launcher-cross-framework.spec.ts` and T20's specs pass against the published
      version.
      **Done when**: Ever Works and one other Ever platform load the same published version, and the names-only
      credential's name is recorded in the private operations repository.

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

- [ ] **T31 (P1, lands with T9; blocks T23). Operator switches in the deploy manifests.**
      **Modify** `.deploy/k8s/k8s-manifest.dev.yaml`, `.deploy/k8s/k8s-manifest.stage.yaml` and
      `.deploy/k8s/k8s-manifest.prod.yaml` — add, beside the existing `EVER_WORKS_DOMAIN` block
      (`k8s-manifest.stage.yaml:293-294`), the API variables this epic introduces, in the file's own
      `-"name": X` / `value: "$X"` style:
      `EVER_WORKS_APP_LAUNCHER_ENABLED`, `EVER_WORKS_PLATFORM_CATALOG_REPO`,
      `EVER_WORKS_PLATFORM_CATALOG_REF`, `EVER_WORKS_PLATFORM_CATALOG_ENV` (**`develop`** in the dev file,
      **`stage`** in the stage file, **`production`** in the production file — the value is per file, and the
      default `production` is what would otherwise show production addresses on stage and dev, contradicting spec
      FR-10) and `EVER_WORKS_PLATFORM_CATALOG_SELF_ID`. **Modify** `apps/api/.env.example` with the same names and
      their defaults.
      **Do not add anything by removal**: no existing variable is renamed, moved or deleted, and the switch is wired
      through the one accessor T9 adds (`config.appLauncher.isEnabled()`), so flipping it in a manifest is the whole
      operation — no code change, no redeploy of a new image (XC-10's APW-11 slice, spec FR-65).
      **Test**: `git grep -n "EVER_WORKS_APP_LAUNCHER_ENABLED\|EVER_WORKS_PLATFORM_CATALOG"` shows all five variables
      in all three manifests and in `.env.example`; a render check (`helm`/`kustomize` or the repository's manifest
      lint) keeps the YAML valid; extend T9's controller spec with the case that flipping the variable off leaves
      every stored row untouched and answers 404 on all three routes, then on again restores the same list
      (ACC-11-50).
      **Done when**: the three manifests and `.env.example` carry the variables with per-environment `_ENV`, and the
      on-stage off/on walk of T23 shows the same tiles, order, pins, hides and exposure values before and after.

- [ ] **T32 (P1, lands with T14; independent). `app_launcher` Activity badge and filter translations (XC-24).**
      **Modify** `apps/web/src/components/activity-log/ActivityTypeBadge.tsx` — add `app_launcher: 'appLauncher'`
      to `TYPE_TO_I18N` (`:31-50`) and an entry to the colour map, so the row stops falling through to the raw
      `actionType.replace(/_/g, ' ')` label at `:58`.
      **Modify** `apps/web/messages/en.json` and the 20 sibling locale files — `dashboard.activity.filters.types.appLauncher`
      (and the badge label if the badge reads a second key), in every locale, in this PR.
      **Create** `apps/web/src/components/activity-log/ActivityTypeBadge.unit.spec.tsx` (**new**) — the
      `app_launcher` row renders the translated label, not `app launcher`, in a non-English locale.
      **Test**: that spec (ACC-11-53); run `pnpm --filter ever-works-web test -- ActivityTypeBadge`.
      **Done when**: the spec passes and removing the `TYPE_TO_I18N` entry makes it fail.

- [ ] **T33 (P1, lands with T9; blocks T20). Non-production seed route for the PR lane (APW11-G07).**
      **Create** `apps/api/src/app-launcher/e2e-seed.controller.ts` and `dto/e2e-seed.dto.ts` (**new**) —
      `POST /api/e2e/app-launcher/seed`, reaching the API only when
      `NODE_ENV !== 'production'` **and** `E2E_APP_LAUNCHER_SEED === 'true'` (the gate is read through a getter
      added beside `config.subscriptions.bypassSeatLimitsInE2E()` at
      `packages/agent/src/config/index.ts:824-829`, with the same production-first shape); otherwise
      `404`, before the handler. Session-authenticated: it creates rows for the signed-in person's own scope.
      The DTO takes a closed set of fixture shapes — `{ kind: 'app' | 'website', name, managedSubdomain?,
deployments: [{ state, environment, website? }], customDomain?: { domain, verified, environment } }` — and
      creates the `works`, `work_deployments` and `work_custom_domains` rows the specs need (`kind: 'app'` as the raw
      varchar until APW-01 lands; no cluster, no build, no network).
      **Modify** `apps/api/src/app-launcher/app-launcher.module.ts` — register it only when the gate is open.
      **Test**: `apps/api/src/app-launcher/e2e-seed.controller.spec.ts` (**new**) — `404` with
      `NODE_ENV=production` even when the variable is set; `404` with the variable unset; a request without a session
      refused; and a seeded Work with a `READY` production deployment plus a managed subdomain then appears in
      `GET /api/me/apps` with the expected `url` (ACC-11-52).
      **Done when**: the spec passes and T20's helper renders every state it needs without touching a database.

---

## Definition of Done

- Every checkbox above is ticked.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test` and `pnpm build` are green.
- Every acceptance criterion in [spec §8](./spec.md) has been walked on stage — ACC-11-01…ACC-11-54.
- The existing header, command-palette, Organization-settings and Work-settings e2e specs pass unchanged.
- CONTRACTS.md rows named in the plan header exist and match the merged code — including the audit round's
  additions: the two ports of plan §4.6, `EVER_WORKS_PLATFORM_CATALOG_BASE_URL`, `E2E_APP_LAUNCHER_SEED`, the
  catalog repository row for `ever-works/platforms`, and the R-2 sentence that every new `actionType` also gets a
  `FEED_KIND_RULES` entry (T7).
- No string anywhere in the launcher claims single sign-on before APW-12 is live.
- No suite for this epic lives under `apps/api/test/` (Resolution R-22).
- Nothing this epic added earlier has been withdrawn: every FR, scenario, ACC id, task and default from the
  original draft is still present, and the audit round's changes are additions (Resolution R-26).
