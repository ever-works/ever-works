# Task Breakdown: App spec, Apps catalog and license gate

> Ordered tasks derived from [`plan.md`](./plan.md). Each is small enough to land in one PR and ships with
> tests per **Constitution VI**. The schema task ships its migration in the same PR per **Constitution V**.

**Epic ID**: `APW-03-app-spec-and-catalog`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md) · **Reference**: [`./schema.md`](./schema.md), [`./catalog.md`](./catalog.md)
**Status**: `Draft`
**Last updated**: 2026-09-17 (program audit fix pass — CONTRACTS.md §0 R-1…R-24 applied)

---

## How to use

- Tasks are **sequential by default**. `(parallel)` means it may run alongside its predecessor.
- Every task names the exact files to create or modify (**Create** / **Modify**), the test that proves it
  (**Test** — for a test-only task, the command that runs it) and an observable **Done when**.
- Add new tasks at the bottom rather than renumbering (T53+ were added by the program audit; each names the phase
  it ships in). T55–T58 were added by the 2026-09-17 ordering and wiring pass.
- Phase boundaries are ship boundaries: `develop` is green and deployable at the end of each phase.
- Commands run from the monorepo root; migrations are authored from `apps/api/`.
- **Prerequisites (exact tasks).** **P1: none** — T1–T21, T54 depend on no other App Works epic. **T11 (the Wave 1
  catalog seam) lands first, on its own, immediately after APW-02 T15**, because T26 below binds
  `APP_SOURCE_CATALOG_PORT` in `packages/agent/src/app-works/` — the folder APW-02 T15 creates. **P2: APW-01 T11
  (the port file and its barrel export) and APW-06 T1–T3** (`packages/contracts/src/apps/app-runtime.ts`, the
  `IDeploymentPlugin` App additions and `packages/agent/src/app-runtime/ports.ts` with `APPS_TIER_POLICY` and
  `DisabledAppsTierPolicy`) are merged. Two pieces of P2 are **interface-first and merge ahead of APW-01 P1** —
  T22's `commitFiles?`, and T26's `AppSourceCatalogAdapter` — and the whole of P2 merges ahead of APW-01 P1, so no
  phase-level loop exists (T55 below states the ordering). **P3: P1 and P2** (plan §11 snapshot exception).
  **If `packages/agent/src/app-runtime/ports.ts` does not exist when T24 or T26 lands** (APW-06 T3 not yet merged),
  that task **creates it from CONTRACTS §3 verbatim** — the `AppsTierPolicy` interface, the `APPS_TIER_POLICY`
  symbol and `DisabledAppsTierPolicy` — and APW-06 T3 then **modifies** it instead of creating it; nothing here
  ever removes or renames what APW-06 declared.
- **Own-PR seam (no phase-level loop).** The program merge order runs **APW-01 T11 → the APW-03 P2 seam
  (T22, T24, T26, T28 + T53, T32) → APW-01 P1 (its remaining tasks) → APW-05 P1 → APW-06 P1 (T4 onward)**. T55
  restates that ordering in one place; no task in this file waits on APW-01 P1.
- Test commands: agent package `pnpm --filter @ever-works/agent test -- <pattern>` (Jest); API
  `pnpm --filter ever-works-api test -- <pattern>` (Jest); web unit `pnpm --filter ever-works-web test -- <pattern>`
  (Vitest); web e2e `pnpm --filter ever-works-web test:e2e -- <file>` (Playwright, `apps/web/e2e/`). Nothing is placed
  under `apps/api/test/` (Resolution R-22).
- Binding program resolutions ([CONTRACTS.md §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5)):
  R-1 shared types in `packages/contracts/src/apps/`; R-2 Activity `action` = dotted name, `actionType` = family;
  R-3 red/amber hosting; R-4 first write; R-5 `AppsTierPolicy`; R-11 key pair formats; R-13 `auto`; R-22 test
  locations.

---

# Phase P1 — The App spec reads true

_Delivers spec FR-1…FR-26 and the App spec tab (FR-66…FR-70, FR-74…FR-80 for it). No catalog, no license
gate._

## P1.1 — Contracts

- [ ] **T1. Shared App Works types and limits.**
      **Create** in `packages/contracts/src/apps/` (R-1): `app-spec.types.ts`, `app-spec-issues.ts`,
      `app-license.types.ts`, `apps-catalog.types.ts`, `work-app-spec.dto.ts`, `apps-limits.ts`, `index.ts` exactly as
      [plan §3.2](./plan.md) — every constant; `APP_SPEC_ISSUE_CODES` with every code of
      [schema.md §22–§23](./schema.md) including `keypair_format_unsupported` and `keypair_password_invalid`;
      `ManagedHostingReason` with `upstreamAgreementMissing`; `BlueprintMatchSource` with `explicit`;
      `AppSpecBuildStrategy = 'dockerfile' | 'image' | 'auto' | 'none'` (R-13); `AppSpecKeypairFormat` as
      `'pem' | 'base64url-raw' | 'pkcs12'` (R-11); `AppSpecValidationMode` as
      `'draft' | 'data-repository' | 'blueprint'` (schema.md §3); the pure `isSourceOnlyAppSpec(spec)` helper that
      T12 and APW-01 consume; and `spec.agents.requireHumanMergePaths` (a `string[]` of globs, ≤ 50, default `[]`)
      on the App spec types (CONTRACTS §1 "Additions (APW-08)"; T3 owns the schema and schema.md §18 defines it).
      **Modify** `packages/contracts/src/index.ts` — `export * from './apps/index.js';`.
      **Test**: `packages/contracts/src/apps/__tests__/apps-contracts.spec.ts` — pins the issue-code tuple
      (append-only snapshot), the `ManagedHostingReason` union in evaluation order, `BlueprintMatchSource`, both new
      string unions, the `AppSpecValidationMode` tuple and every numeric constant.
      **Done when**: `pnpm --filter @ever-works/contracts build` emits the declarations and `apps/api` imports
      `AppSpecIssue` from `@ever-works/contracts`; no file is created under a `src/app-works/` folder.

- [ ] **T2 (parallel). Activity action types and domain events.**
      **Modify** `packages/agent/src/entities/activity-log.types.ts` — append `APP_SPEC = 'app_spec'`,
      `APP_BLUEPRINT = 'app_blueprint'`, `APP_LICENSE = 'app_license'` to `ActivityActionType` (append only; varchar
      column, no migration). Rows written by this epic use these as `actionType` and the dotted CONTRACTS §6 name as
      `action` (R-2).
      **Three fields every row of these three families must carry** (`CreateActivityLogDto` requires them —
      `packages/agent/src/entities/activity-log.types.ts:427-433` — while the plan defines only the event name and
      its `details`, §6.2, §6.3 and §2.5; Resolution **R-34** is the binding rule this task implements): - **`status`** — `ActivityStatus.COMPLETED` for a classification, an apply, an attestation, an upgrade notice
      or a catalog refresh; `FAILED` for `app.spec.invalid`, an apply failure, a license refusal, a catalog read
      that failed, and any `app.license.*` row that records a mismatch; `CANCELLED` only when a member cancels. - **`summary`** — one English template per event, plus its i18n key, because the web renders the summary
      rather than deriving one: `app.spec.validated` → "App spec checked — {warningCount} warnings";
      `app.spec.invalid` → "App spec has {errorCount} problems"; `app.spec.applied` → "App spec applied";
      `app.blueprint.matched` → "Blueprint {name} matched"; `app.blueprint.applied` → "Blueprint {name} applied";
      `app.blueprint.apply_failed` → "Blueprint {name} could not be applied"; `app.license.classified` →
      "License classified: {class}"; `app.license.changed` → "License changed from {fromSpdx} to {toSpdx}";
      `app.license.attestation_required` → "License attestation needed"; `app.license.declared_mismatch` →
      "Declared license does not match the registry"; `apps.catalog.refreshed` → "Apps catalog refreshed".
      (The final copy and its keys land with T18; this task declares the fields and the per-event templates so no
      row is ever written with an empty `summary`.) - **`userId`** — the App Work's owner, **always**, including for webhook-, cron- and apply-job-triggered rows:
      there is no system actor in the model, so a background row is attributed to the member whose Work it is
      (the same rule T53's conflict comment uses). A row whose Work has no resolvable owner is not written; it is
      counted and logged instead.
      **Modify** `apps/web/src/components/activity-log/ActivityTypeBadge.tsx` — one colour and one
      `TYPE_TO_I18N` entry per family (`app_spec`, `app_blueprint`, `app_license`), as APW-02 T30 does for its
      three and APW-08 for its own; without this the three families render as raw enum text
      (`ActivityTypeBadge.tsx:29-49`). **Modify** `apps/web/src/components/activity-log/ActivityFilters.tsx` and
      `apps/web/messages/en.json` (+ the 20 siblings) — the matching filter labels and badge colours, which T18's
      message spec asserts.
      **Create** `packages/agent/src/events/app-spec-applied.event.ts` (`EVENT_NAME = 'app.spec.applied'`,
      payload `{ workId, commitSha, previousCommitSha, specHash, addedDependencies, changedEnvNames, changedBlocks }`)
      and `packages/agent/src/events/app-license-changed.event.ts` (`'app.license.changed'`).
      **Modify** `packages/agent/src/events/index.ts` — export both.
      **Test**: extend `packages/agent/src/events/events.spec.ts` — names are unique and dotted; extend
      `packages/agent/src/entities/__tests__/activity-log.types.spec.ts` — the three values exist and existing values
      are unchanged; extend `packages/agent/src/activity-log/feed-kind.spec.ts` (via the `FEED_KIND_RULES` entry R-34
      requires) and the publishable-activity spec so three new members are classified; **create**
      `packages/agent/src/activity-log/__tests__/app-works-activity-rows.spec.ts` — every row written by this epic
      carries a non-empty `summary`, a `status` and the Work owner's `userId`, and a row with no resolvable owner is
      dropped rather than written blank (R-34).
      **Done when**: `pnpm --filter @ever-works/agent test -- events.spec activity-log.types app-works-activity-rows`
      passes, no existing enum value changed, and `ActivityTypeBadge` renders all three families with a colour and a
      label instead of raw text.

## P1.2 — Schema and validator

- [ ] **T3. Structural App spec schema.**
      **Create** `packages/agent/src/works-config/schema/app-spec.schema.ts` — `z.strictObject` for every
      block of schema.md §5–§20 with bounds, enums and `.describe()` defaults (`build.strategy` enum
      `dockerfile | image | auto | none` — no builder name, R-13; `generate.keypair` `{ type, format, passwordEnv }`,
      R-11; **`agents.requireHumanMergePaths`: an array of glob strings, ≤ 50, default `[]`** — schema.md §18,
      CONTRACTS §1 "Additions (APW-08)", R-11-style additive key); `appSpecSchema`;
      `stripExtensionKeys(value)` returning a copy without `x-*` keys at any depth; and the validation modes of
      schema.md §3 exactly as that table now reads — `blueprint` mode **allows and expects `spec.source` and
      `spec.blueprint`** (the 2026-09-17 correction to §3's row; `blueprint_mode_forbidden_key` stays in §23's list
      for the structural cases §2 describes but is no longer emitted for those two keys), so a Blueprint
      repository's own file is validatable with the same rules the platform runs.
      **Modify** `packages/agent/src/works-config/schema/works-config.schema.ts` — add `app: appSpecSchema`
      to `KIND_SPEC_SCHEMAS`.
      **Test**: `packages/agent/src/works-config/schema/__tests__/app-spec.schema.spec.ts` — the three
      schema.md §24.1–§24.3 examples parse (ACC-03-01); one failing case per bound and enum; `x-` keys accepted and a
      newer `appSpecVersion` downgrades `unknown_field` (ACC-03-02); `auto` accepted, any other strategy string
      refused, and each §12 key pair example — `pem`, `base64url-raw`, `pkcs12` — parses (ACC-03-49); a type-level
      assertion that `z.input<typeof appSpecSchema>` and `AppSpec` (T1) are mutually assignable.
      **Done when**: the spec passes and no other kind's fixture changes.

- [ ] **T4. Reference grammar and resolution.**
      **Create** `packages/agent/src/works-config/schema/app-spec.refs.ts` — tokenizer for schema.md §21,
      `resolveReference(ref, spec)`, output tables per dependency, secrecy and phase propagation, Tarjan cycle
      detection over `template` edges, depth limit 10; `build.commitSha` resolves for `dockerfile` and `auto`.
      **Test**: `packages/agent/src/works-config/schema/__tests__/app-spec.refs.spec.ts` — every row of schema.md
      §21's table (incl. `build.commitSha` under `auto` and its refusal under `image`), `bucket.<name>`, a three-entry
      cycle naming all three, depth 11 refused.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-spec.refs` passes with one case per §21 row.

- [ ] **T5. Cross-field rules R1–R26.**
      **Create** `packages/agent/src/works-config/schema/app-spec.rules.ts` — one exported pure function per
      rule; R4 counts each keypair entry's implicit `<NAME>_PUBLIC`; R9 generates 3 samples from a fixed seed (a
      `base64url-raw` key pair has generated length 43); R10 uses `scanForSecrets` (re-exported by
      `packages/agent/src/utils/secret-scan.ts`) plus the name list; R21 uses `computeNextCronFire` from
      `packages/agent/src/schedules/cadence.ts`; R25 `keypair_format_unsupported`; R26 `keypair_password_invalid`.
      **Test**: `packages/agent/src/works-config/schema/__tests__/app-spec.rules.spec.ts` — a failing and a passing
      fixture per rule R1–R26, asserting code, severity, line and column (ACC-03-03); R19 is an error in `blueprint`
      mode for a verified entry context; the §12 invalid examples report exactly R25 and R26 (ACC-03-49).
      **Done when**: every rule id in schema.md §22 has a named failing and passing case.

- [ ] **T6. Positioned validation and issue builder.**
      **Create** `packages/agent/src/works-config/schema/app-spec.issues.ts` — `describeIssue(code, params)`
      whose params type admits names only; Damerau–Levenshtein suggestion ≤ 2.
      **Create** `packages/agent/src/works-config/schema/app-spec.validate.ts` — `validateAppSpecDocument(text, { mode, context? })` and `validateAppSpecObject(obj, options)` per [plan §2.2](./plan.md): 256 KiB,
      `uniqueKeys`, `maxAliasCount: 100`, depth 12, `LineCounter` pointer map, nearest-ancestor positions,
      `displayPath` by names, sort, 200 cap, newer `appSpecVersion` downgrade, never throws; server-only
      `build_strategy_unavailable` when `context.buildStrategies` lacks the declared strategy **and that strategy is
      `dockerfile` or `auto`** (`image` and `none` need no builder, so they never warn). **`RuleContext` is defined
      here and is the only place the server-only rules read from:** `recordedRelation` (`link` · `fork` ·
      `private-copy`), `catalogIds` or `catalogUnavailable`, `buildStrategies` or `null`, `dependencyProviders`
      keyed by deploy target or `null`, `trackedBranchExists`. **A `null` (unknown) field skips its rule**, so
      before APW-05 and APW-07 exist nothing is reported for a strategy or a dependency nobody could have resolved;
      `AppSpecService.evaluate` fills each field from `Work.sourceRepository`, `AppsCatalogService`'s registry,
      `IBuildPlugin.supportedStrategies` over the enabled build plugins and `IAppDependencyProvider.supports` over
      the configured providers for the Work's target — an unavailable source is `null`, never an empty list.
      **The rule set runs whenever the document parses** (plan §2.2, ACC-03-01/S5): structural errors that stop
      parsing are `yaml_syntax`, `file_too_large` and `yaml_alias_limit`/depth failures; every other structural
      error is reported **and** R1–R26 run on a best-effort copy with the offending keys and invalid leaves removed,
      so §24.4 yields its six codes together and a single invalid leaf never produces a duplicate report. A subtree
      that cannot be copied is named in the issue's `details` and suppresses only the rules that read it.
      **Test**: `packages/agent/src/works-config/schema/__tests__/app-spec.validate.spec.ts` — schema.md §24.4 yields
      exactly its six codes and display paths **with the rules having run despite the structural `unknown_field`**
      (ACC-03-01); S5's pair (`unknown_field` + `web_component_needs_port`) together; `yaml_syntax`,
      `file_too_large` and the alias/depth failures are the only inputs that suppress the rule set, each asserted;
      a case where one invalid leaf suppresses exactly the rules that read it and no others; unknown key suggestion,
      `x-` silence, newer version warning (ACC-03-02); line/column for present and absent keys; a property test inserting random secret-shaped strings
      into `build.args`, secret `value`s and `prompt.example` and asserting no issue string contains them
      (ACC-03-04); 300 KiB, 101-alias and 13-level files each report one error (ACC-03-05); a 256 KiB draft validates
      under 2 s (ACC-03-08); `auto` with an empty `buildStrategies` context reports `build_strategy_unavailable`
      (ACC-03-49); `auto` with an empty `buildStrategies` context reports `build_strategy_unavailable`, while
      `image` and `none` never do (ACC-03-49); every `RuleContext` field left `null` skips its rule, so a default
      context produces no server-only issue at all (ACC-03-58); the `blueprint-draft` mode accepts a draft carrying
      `source` and `blueprint` that the strict `blueprint` mode reports as `blueprint_mode_forbidden_key`
      (ACC-03-52).
      **Done when**: a 256 KiB fixture validates in under 2 seconds on CI.

- [ ] **T7. Route `kind: app` through the new validator.**
      **Modify** `packages/agent/src/works-config/schema/works-config.schema.ts` — in `validateWorksConfig`,
      when the resolved kind is `app`, call `validateAppSpecObject` and map issues through the existing
      `formatIssues` string shape (errors → `errors`, warnings → `warnings`).
      **Modify** `packages/agent/src/works-config/index.ts` — export the validator, schema and refs modules.
      **Test**: extend `packages/agent/src/works-config/schema/__tests__/works-config.schema.spec.ts` with
      `kind: app` cases; every existing case passes unmodified (ACC-03-06).
      **Done when**: the diff of `works-config.schema.spec.ts` contains only added cases.

- [ ] **T8. JSON Schemas and the public route.**
      **Modify** `packages/agent/src/works-config/schema/emit-json-schema.ts` — root `allOf` if/then for
      `kind: app`; post-process `patternProperties: { "^x-": {} }` on strict objects.
      **Create** `packages/agent/src/works-config/schema/emit-app-spec-json-schema.ts` and the committed
      `packages/agent/src/works-config/schema/app-spec.v1.schema.json`.
      **Modify** `packages/agent/src/works-config/schema/works.v2.schema.json` (regenerated).
      **Modify** `apps/api/src/onboarding/works-schema.controller.ts` — `@Public()`
      `GET api/schema/app-spec.schema.json`, `Cache-Control: public, max-age=300`.
      **Test**: extend `packages/agent/src/works-config/schema/__tests__/emit-json-schema.spec.ts` (an in-test JSON
      Schema validator rejects `replica` under an app component; the escape branch still accepts an unknown kind);
      create `packages/agent/src/works-config/schema/__tests__/emit-app-spec-json-schema.spec.ts` (drift guard) and
      `apps/api/src/onboarding/works-schema.controller.spec.ts` (both public routes, 5-minute cache header) —
      ACC-03-07.
      **Done when**: both committed JSON files equal their generators' output and `GET /api/schema/app-spec.schema.json`
      answers 200 without authentication.

## P1.3 — Entity, table, migration

- [ ] **T9. `WorkAppSpecState` entity.**
      **Create** `packages/agent/src/entities/work-app-spec-state.entity.ts` — every column and index of
      [plan §3.1](./plan.md) (incl. `blueprintMatchedAt`), modelled on
      `packages/agent/src/entities/skill-tag.entity.ts`.
      **Modify** `packages/agent/src/entities/index.ts`, `packages/agent/src/database/_entity-names.ts`,
      `packages/agent/src/database/_entities-inventory.ts`.
      **Test**: `packages/agent/src/entities/__tests__/work-app-spec-state.entity.spec.ts` — index names,
      scope columns, portable dates.
      **Done when**: the database drift specs pass without a magic-number edit.

- [ ] **T10. Migration.**
      **Create** `apps/api/src/migrations/1792030000000-CreateWorkAppSpecStates.ts` — generate with
      `cd apps/api && pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/CreateWorkAppSpecStates`,
      then re-stamp to `1792030000000` (re-stamp again if `develop` has a newer migration than
      `1791240000000-AddSafetyRailsCore.ts`).
      **Test**: `apps/api/src/migrations/__tests__/CreateWorkAppSpecStates.spec.ts` — creates only the new
      table and three indexes; `down()` drops only them; no `ALTER` of an existing table.
      **Done when**: a fresh database migrates up, down and up again.

- [ ] **T11. State repository.**
      **Create** `packages/agent/src/database/repositories/work-app-spec-state.repository.ts` —
      `findByWorkId`, `initialize(workId, branch, scope)`, `requestEvaluation(workId)` (one
      `UPDATE … RETURNING` implementing the coalescing rule), `markStarted(workId)`,
      `writeEvaluation(workId, seq, result)` guarded by `evaluatedSeq < :seq`, `writeLicense`,
      `markBlueprintMatched(workId, blueprintId, version, matchSource)` (the once-only guard of plan §2.5 step 0),
      `findUpgradeCandidates`, `findStaleRegistry`.
      **Modify** `packages/agent/src/database/repositories/work.repository.ts` — **add**
      `findAppWorksByDataRepoFullName(fullName, { userId?, organizationId? })`: kind `app` only, matching the Work
      Repository (`website` role) case-insensitively, with **no `githubAppInstalled` filter** and scoped to the
      binding's user or organization. This is the lookup the push consumer of T14 uses —
      `findByDataRepoFullName` selects only Works with the platform GitHub App installed
      (`work.repository.ts:263-277`), so an App Work on a member's own fork (the normal Wave 1 case, whose webhook
      APW-02 created) would never be found, and it ignores the delivery's owner binding, so one tenant's delivery
      would request evaluations for every tenant's Works on that repository. `findByDataRepoFullName` itself is
      unchanged.
      **Modify** `packages/agent/src/database/index.ts` — export it.
      **Test**: `packages/agent/src/database/repositories/__tests__/work-app-spec-state.repository.spec.ts` —
      coalescing arithmetic (dispatch / skip), an older seq writes nothing so the newer result stays (ACC-03-12), a
      deleted Work affects 0 rows, `markBlueprintMatched` returns `true` once per id + version.
      **Done when**: the spec passes on SQLite and the out-of-order case is a named test.

## P1.4 — Evaluation service and jobs

- [ ] **T12. `AppSpecService`.**
      **Create** `packages/agent/src/app-spec/app-spec.service.ts`, `packages/agent/src/app-spec/app-spec-hash.ts`,
      `packages/agent/src/app-spec/app-spec-guarded-blocks.ts` (`diffGuardedSpecBlocks` over `source`, `blueprint`,
      `license`, `display.protectedPaths`, `upstreamPullRequests`, `provisioning`; `isProtectedPath`),
      `packages/agent/src/app-spec/app-spec.module.ts`, `packages/agent/src/app-spec/index.ts`.
      Methods: `initialize`, `requestEvaluation(workId, trigger)`, `evaluate(workId)` (lock
      `app-spec-evaluate:<workId>` via `DistributedTaskLockService.runExclusive`, read head with
      `GitFacadeService.getLatestCommit` + `getFileContent`, validate, write, emit Activity through
      `ActivityLogService.log` with `actionType: APP_SPEC` and the dotted `action` only on head-hash change, emit
      `AppSpecAppliedEvent` on effective-hash change, tracked-branch move per plan §2.3),
      `getEffectiveSpec(workId, commitSha?)`, `validateDraft(workId, text)`, `getState(workId)` with the
      60-second lazy head check, and
      **`hasValidAppSpec(workId, commitSha): Promise<boolean>`** — true only when `.works/works.yml` at `commitSha`
      parses, selects kind `app`, validates with **zero errors** (warnings allowed) and its `spec` holds at least
      one key outside `{ kind, appSpecVersion, source }`; `x-*` keys are ignored, and a file holding only `source` is
      therefore **false**. It reads that commit synchronously through `GitFacadeService`, never
      `WorkAppSpecState.validationStatus` or the effective-spec cache (both are asynchronous — the row APW-01 just
      initialized has not been evaluated yet), and it never writes state. The key set comes from one pure helper,
      `isSourceOnlyAppSpec(spec)` in `packages/contracts/src/apps/`, which APW-03's apply-job fresh rule and APW-01
      use too. Without this predicate the minimal path's `{version, kind, spec.source}` file would read as _valid_
      (R2 requires `build`/`components` only when one of them is present), so the App Provisioner would never start
      and APW-01 FR-29a could not hold.
      `diffGuardedSpecBlocks` reports **removals** from `display.protectedPaths` and
      `agents.requireHumanMergePaths` (additions stay allowed) over `source`, `blueprint`, `license`, both path
      lists, `upstreamPullRequests` and `provisioning`; `isProtectedPath` uses **`minimatch` with `{ dot: true }`**
      — the matcher APW-08 plan §4 uses — added to `packages/agent/package.json` at the version the lockfile
      resolves, so both epics match globs identically.
      **Modify** `packages/agent/package.json` — add the `./app-spec` export.
      **Test**: `packages/agent/src/app-spec/__tests__/app-spec.service.spec.ts` — every branch in plan §10.1 for
      this file: a push that changes the spec updates the state and one on another branch changes nothing
      (ACC-03-09); an invalid head keeps the effective commit and `getEffectiveSpec(workId, badSha)` returns `invalid`
      (ACC-03-10); no Activity on an identical re-evaluation (ACC-03-11); the lazy check schedules at most once a
      minute (ACC-03-14); `unreadable` keeps the effective spec.
      `packages/agent/src/app-spec/__tests__/app-spec-hash.spec.ts` — canonical hash stability;
      `packages/agent/src/app-spec/__tests__/app-spec-guarded-blocks.spec.ts` — a `license.class` change and a
      removed protected path are reported (ACC-03-15), and so is a removal from `agents.requireHumanMergePaths`
      while an addition to either list is not;
      `hasValidAppSpec` cases in the same spec: file absent ⇒ false; `source` only ⇒ false; `source` plus an `x-`
      key ⇒ false; `source` + a valid `build` + `components` ⇒ true; the same with an R1 error ⇒ false; and it
      returns the right answer **while `validationStatus` is still `missing`** (nothing evaluated yet) (ACC-03-57).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-spec` passes and `getEffectiveSpec` is exported from
      `@ever-works/agent/app-spec`.

- [ ] **T13. `app-spec-evaluate` dispatcher and job.**
      **Create** `packages/agent/src/tasks/app-spec-evaluate.types.ts`,
      `packages/agent/src/tasks/app-spec-evaluate-dispatcher.ts` (`APP_SPEC_EVALUATE_DISPATCHER`, modelled on
      `packages/agent/src/tasks/work-import-dispatcher.ts`), `packages/agent/src/tasks/app-works-jobs.ts` (job ids +
      handlers, like `packages/agent/src/tasks/memory-fact-jobs.ts`),
      `packages/tasks/src/tasks/trigger/app-spec-evaluate.task.ts`.
      **Modify** `packages/agent/src/tasks/index.ts`, `packages/agent/src/tasks/_tasks-symbols.ts`,
      `packages/agent/src/tasks/job-runtime.providers.ts` (`DISPATCHER_SYMBOLS` + recounted provider arity),
      `packages/tasks/src/tasks/trigger/index.ts`.
      **Test**: `packages/agent/src/tasks/__tests__/app-works-dispatchers.spec.ts` — the symbol is `Symbol(...)`,
      listed in the barrel inventory and in `DISPATCHER_SYMBOLS`; `packages/agent/src/tasks/tasks.spec.ts` and
      `packages/agent/src/tasks/__tests__/job-runtime.providers.spec.ts` pass after recounting.
      **Done when**: a `null` dispatch runs the handler in-process for this job only.

- [ ] **T14. GitHub push and merge intake.**
      **Create** `apps/api/src/ingest/github/app-spec-github-intake.service.ts` implementing
      `GitHubWebhookConsumer` (`events: ['push', 'pull_request']`), registered in `onModuleInit` like
      `apps/api/src/ingest/github/github-check-intake.service.ts`; Works found with
      `WorkRepository.findByDataRepoFullName`; per-Work cap 30 dispatches per minute.
      **Modify** `apps/api/src/ingest/ingest.module.ts` — provide the new consumer next to `GitHubCheckIntakeService`.
      **Test**: `apps/api/src/ingest/github/app-spec-github-intake.service.spec.ts` — a push to the tracked branch
      requests evaluation and a push to another branch does not (ACC-03-09); merged vs closed-unmerged; non-app Works
      ignored; the cap; **an App Work whose repository has no platform GitHub App installed is still found**; **a
      delivery bound to another user or organization matches nothing** (ACC-03-56); extend
      `packages/agent/src/database/repositories/__tests__/work.repository.spec.ts` — the new lookup ignores
      `githubAppInstalled`, matches case-insensitively and honours the owner binding.
      **Done when**: `pnpm --filter ever-works-api test -- app-spec-github-intake` passes and existing
      `github-check-intake` specs pass unchanged.

## P1.5 — API

- [ ] **T15. `GET app-spec` and `POST app-spec/validate`.**
      **Create** `apps/api/src/works/work-app-spec.controller.ts` and `apps/api/src/works/dto/app-spec.dto.ts`
      — the two routes of [plan §4.1](./plan.md) with `WorkOwnershipService.ensureCanView` / `ensureCanEdit`,
      `422 notAnAppWork`, `413 file_too_large`, throttles (6/min per Work for `branch`, 30/min per member for
      `content`), `@ApiOperation` on both.
      **Modify** `apps/api/src/works/works.module.ts` — register the controller and import `AppSpecModule`.
      **Test**: `apps/api/src/works/work-app-spec.controller.spec.ts` — every P1 row of plan §4.1–§4.2; a `content`
      validation stores nothing and the 31st request in a minute is refused (ACC-03-08); three Re-check presses in
      5 s run one evaluation and the 7th in a minute is refused (ACC-03-13); `GET` with a stale head schedules at most
      one evaluation per minute (ACC-03-14); viewer vs editor and cross-account 404 (ACC-03-41); `202` never awaits
      the job.
      **Done when**: both routes appear in the generated OpenAPI document with their error codes.

## P1.6 — Web

- [ ] **T16. Route, tab and clients.**
      **Modify** `apps/web/src/lib/constants.ts` — `ROUTES.DASHBOARD_WORK_SETTINGS_APP_SPEC`.
      **Modify** `apps/web/src/components/works/detail/settings/SettingsSubTabs.tsx` — fourth tab visible when
      `useWorkDetail().work.kind === 'app'`; General's `isActive` excludes `/settings/app-spec`.
      **Create** `apps/web/src/lib/api/work-app-spec.ts` (`server-only`) and
      `apps/web/src/app/actions/dashboard/app-spec.ts` (`recheckAppSpecAction`).
      **Test**: `apps/web/src/components/works/detail/settings/SettingsSubTabs.unit.spec.tsx` (new) — tab present for
      `app`, absent for `website` (ACC-03-39).
      **Done when**: `pnpm --filter ever-works-web test -- SettingsSubTabs` passes and the three existing tabs render
      unchanged for every other kind.

- [ ] **T17. App spec page (P1 surfaces).**
      **Create** `apps/web/src/app/[locale]/(dashboard)/works/[id]/settings/app-spec/page.tsx` and, under
      `apps/web/src/components/works/detail/settings/app-spec/`, `AppSpecPageClient.tsx`,
      `AppSpecStatusBanner.tsx`, `AppSpecProblemsList.tsx`, `AppSpecSections.tsx` per
      [plan §5](./plan.md); slots left for the Blueprint and License cards (filled in T31, T45).
      **Test**: `apps/web/src/components/works/detail/settings/app-spec/AppSpecStatusBanner.unit.spec.tsx`,
      `apps/web/src/components/works/detail/settings/app-spec/AppSpecProblemsList.unit.spec.tsx` — every §6.2 banner
      state, sorting, filtering, link built from `links.file` + `lineAnchor` (ACC-03-40), polling stops after 24 polls.
      **Done when**: the banner state is present in server-rendered HTML.

## P1.7 — i18n, tests, docs

- [ ] **T18. P1 i18n.**
      **Modify** `apps/web/messages/en.json` — `dashboard.workDetail.settings.tabs.appSpec` and the
      `dashboard.workDetail.settings.appSpec` status, problems, env and `issues.<camelCode>` keys of
      [plan §8](./plan.md) (incl. `issues.keypairFormatUnsupported`, `issues.keypairPasswordInvalid`); the same keys
      in the 20 sibling locale files `apps/web/messages/{ar,bg,de,es,fr,he,hi,id,it,ja,ko,nl,pl,pt,ru,th,tr,uk,vi,zh}.json`.
      **Create** `apps/web/src/components/works/detail/settings/app-spec/app-spec-messages.unit.spec.ts` — modelled on
      `apps/web/src/components/meetings/meetings-messages.unit.spec.ts`: discovers ≥ 21 locales; every key the
      P1 components read exists in every locale; every leaf is camelCase with no `.`; every message survives a
      `createTranslator` round trip; one `issues.<camelCode>` leaf per `APP_SPEC_ISSUE_CODES` entry.
      **Test**: `pnpm --filter ever-works-web test -- app-spec-messages` (ACC-03-43, P1 surfaces).
      **Done when**: the spec passes and the web build reports no missing messages.

- [ ] **T19. P1 e2e.**
      **Create** `apps/web/e2e/flow-app-spec-settings.spec.ts` and `apps/web/e2e/flow-app-spec-recheck.spec.ts`
      ([plan §10.3](./plan.md)); prefer `getByTestId` for problem rows.
      **Test**: `pnpm --filter ever-works-web test:e2e -- flow-app-spec-settings flow-app-spec-recheck` — tab absent on
      a `website` Work and present on an App Work (ACC-03-39); every seeded banner state and problem link (ACC-03-40);
      Re-check → Checking… with one evaluation (ACC-03-13); a viewer sees no Re-check (ACC-03-41).
      **Done when**: both pass and `apps/web/e2e/flow-work-kind-template-activation-deep.spec.ts` passes unchanged.

- [ ] **T20 (parallel). P1 docs.**
      **Modify** `docs/agent-services/works-yml-schema.md` — add `app` to the kind table, a `### app` section
      with the schema.md §24.1 example, a link to the published reference, and a "Validation behaviour" note
      that `app` specs are strict in reporting and still preserved on write; document `build.strategy: auto` without
      naming a builder and the key pair `format` values.
      **Modify** `docs/api/works.md` — document `GET /api/works/:id/app-spec` and
      `POST /api/works/:id/app-spec/validate` with request, response and error tables.
      **Test**: `pnpm --filter ever-works-docs build` — no broken-link warning for the two pages.
      **Done when**: the docs build is green and both routes appear in `docs/api/works.md`.

- [ ] **T21. P1 ship gate.**
      **Modify** `docs/specs/features/app-works/APW-03-app-spec-and-catalog/tasks.md` (tick T1–T20) and the APW-03 row
      of `docs/specs/features/app-works/TRACKER.md`.
      **Test**: `pnpm format:check && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
      **Done when**: all five commands are green on the P1 merge commit and TRACKER shows APW-03 P1 merged.

---

# Phase P2 — Apps catalog and Blueprints

_Delivers spec FR-27…FR-52, FR-71…FR-73, FR-81 and FR-82._

- [ ] **T22. Git provider additions for catalogs.**
      **Status (2026-09-25): partially done.** `GitRepository.topics?` is in the contract (`e74f6e045`) and the GitHub
      plugin maps it (an absent key means "not reported", `[]` means "no topics", non-string entries are dropped);
      `commitFiles?` and `getFileWebUrl?` are not declared yet. Shipped beside it: the pure licence classifier
      (`classifyLicenseExpression` in `packages/agent/src/app-license/license-classify.ts`, with `NOASSERTION` fixed
      red — `catalog.md` §4) and `AppSourceCatalogAdapter`, bound to `APP_SOURCE_CATALOG_PORT` in the packages/agent
      `AppWorksModule` rather than an `apps-catalog.module.ts`. The adapter classifies on the bundled seed snapshot —
      a typed `.ts` constant (`license-registry.snapshot.ts`, a verbatim copy of `ever-works/templates@46d12bb`'s
      `licenses.yml`, not yet legal-reviewed) instead of plan §2.6's `license-registry.snapshot.yml`, because
      `nest build -b swc` copies no non-TS assets. Open: the live / last-good registry read (T24/T38), obligations
      output, the forced `managedHosting: false` for a snapshot classification (FR-38), and the Blueprint match, held
      behind the apply gate until T28 binds `APP_BLUEPRINT_APPLY_SERVICE`.
      **Modify** `packages/plugin/src/contracts/capabilities/git-provider.interface.ts` — `GitRepository.topics?`,
      `commitFiles?`, `getFileWebUrl?` exactly as [plan §7](./plan.md).
      **Modify** `packages/plugins/github/src/github-api.service.ts` (map `topics`; Git Data API commit with
      non-force `updateRef` and a `nonFastForward` error code; file URL + `#L{line}` anchor),
      `packages/plugins/github/src/github.plugin.ts` (delegations), `packages/agent/src/facades/git.facade.ts`
      (wrappers that return `null` / throw `unsupported` when the plugin lacks a method).
      **Test**: `packages/plugins/github/src/__tests__/github-api.app-works.spec.ts` (Vitest, mocked Octokit) —
      topics mapping, multi-file commit with non-fast-forward code, file URL anchor; and
      `packages/agent/src/facades/__tests__/git.facade.app-works.spec.ts` — the unsupported paths.
      **Done when**: `pnpm --filter @ever-works/github-plugin test` and `pnpm --filter @ever-works/agent test -- git.facade.app-works` pass.

- [ ] **T23 (parallel). Catalog sanitizer and managed availability.**
      **Create** `packages/agent/src/apps-catalog/apps-catalog.mapper.ts` and `packages/agent/src/apps-catalog/apps-catalog.types.ts`
      — every rule of [catalog.md §3](./catalog.md), `isVerified`, and the pure
      `managedHostingAvailability(entry, registry, tier, match?)` of plan §2.4: drops a row whose license classifies
      `red` (R-3); strips `managedHosting.upstreamAgreement` from non-amber rows; reasons in order `licenseNotGreen`,
      `upstreamAgreementMissing`, `entryDisallows`, `blueprintNotVerified`, `managedTierDisabled`, with the tier state
      passed in — never read from `EVER_WORKS_APPS_MANAGED_ENABLED` (R-5).
      **Test**: `packages/agent/src/apps-catalog/__tests__/apps-catalog.mapper.spec.ts` — one fixture per rule, a bad
      row dropped while the rest survive (ACC-03-17); expired evidence unverified (ACC-03-20); each availability
      reason from its fixture (ACC-03-21); a `red` row dropped (ACC-03-46); amber with and without an agreement, red
      and unknown (ACC-03-47); `{ open: false }` ⇒ `managedTierDisabled` and `{ open: true, scope: 'verified-blueprints' }` + unverified ⇒ `blueprintNotVerified` (ACC-03-48); an explicit match for an unlisted
      repository never `available` (ACC-03-44); **the purity guard** — the same inputs give the same verdict with
      `EVER_WORKS_APPS_MANAGED_ENABLED` set to both values in turn and with a throw-on-touch spy standing in for
      `APPS_TIER_POLICY`, proving `managedHostingAvailability` and the mapper never reach for a policy or an
      environment of their own (plan §2.4).
      **Done when**: the mapper file imports nothing from `process.env`, neither `managedHostingAvailability` nor the
      mapper calls `AppsTierPolicy` (the tier argument is the only way tier state enters), and every reason has a
      named case.

- [ ] **T24. `AppsCatalogService`.**
      **Create** `packages/agent/src/apps-catalog/apps-catalog.service.ts`, `packages/agent/src/apps-catalog/apps-catalog.module.ts`,
      `packages/agent/src/apps-catalog/index.ts` per [plan §2.4](./plan.md) (tokenless → authenticated, byte-counted
      bodies, 1 h / 30 s cache, last-good registry for 7 days, mutable-ref warning, `getDetail` README ≤ 64 KiB and spec
      summary at the pinned sha, `refresh()`); tier state read from `APPS_TIER_POLICY` —
      **imported from `packages/agent/src/app-runtime/ports.ts` (APW-06 T3, merged before this phase); if that file
      does not exist yet, create it from CONTRACTS §3 verbatim and let APW-06 T3 modify it** — (`isOpen()`,
      `managedScope()`, `@Optional()`, unbound ⇒ closed — R-5).
      **Modify** `packages/agent/package.json` — `./apps-catalog` export.
      **Test**: `packages/agent/src/apps-catalog/__tests__/apps-catalog.service.spec.ts` — both read paths, TTLs, size
      guards; an unreachable catalog yields an empty `available: false` result and no refetch within 30 s (ACC-03-16);
      a fetch/facade spy failing the test on any request whose repository is not the catalog repository or an
      `ever-works/*` Blueprint repository (ACC-03-18); an unbound port ⇒ `managedTierDisabled`, a bound open port with
      `EVER_WORKS_APPS_MANAGED_ENABLED` unset still reports tier-driven availability (ACC-03-48).
      **Done when**: `pnpm --filter @ever-works/agent test -- apps-catalog.service` passes.

- [ ] **T25. Public catalog API and web client.**
      **Create** `apps/api/src/apps-catalog/apps-catalog.controller.ts` and `apps/api/src/apps-catalog/apps-catalog.module.ts`
      — the three public routes of plan §4.1 (`licenses` declared before `:id`), `@Throttle` 120/min,
      `Cache-Control: public, max-age=300`.
      **Modify** `apps/api/src/api.module.ts` — import `AppsCatalogModule`.
      **Create** `apps/web/src/lib/api/apps-catalog.ts`, `apps/web/src/lib/api/apps-catalog.server.ts`,
      `apps/web/src/app/api/apps-catalog/route.ts` (mirrors `apps/web/src/app/api/work-templates/route.ts`).
      **Test**: `apps/api/src/apps-catalog/apps-catalog.controller.spec.ts` — filters each narrow and search `ca`
      finds Cal.diy while `c` is ignored (ACC-03-19), `limit` capped at 100, route order, unavailable ⇒ 200
      `available: false` (ACC-03-16), a red fixture row absent from list and detail (ACC-03-46).
      **Done when**: `GET /api/apps-catalog` answers without authentication with the cache header.

- [ ] **T26. Blueprint resolver.**
      **Status (2026-09-25): explicit (FR-81) and probe (FR-43) paths done** in `AppBlueprintResolverService`
      (`781f9a2e5`): ≤ 3 reads, a 1 h / 10 min in-process cache (500 entries, oldest evicted; it replaces plan §2.5's
      `CACHE_MANAGER` key because `AppWorksModule` has no cache module), SSRF-contained to `ever-works/<[a-z0-9-]>` and
      `.works/works.yml` (`APP_BLUEPRINT_SPEC_PATH` — the only file the resolver reads). Acceptance also requires a
      public repository, an `ever-works/` `fullName` after redirects, the topic `ever-works-app-blueprint`, root
      `kind: app` and `spec.blueprint.repo` equal to the repository. Credential: the GitHub App installation on
      `ever-works`, else `EVER_WORKS_APPS_CATALOG_TOKEN`, else `GITHUB_TOKEN`. A match is held behind the apply gate
      until T28 binds `APP_BLUEPRINT_APPLY_SERVICE` in the packages/agent `AppWorksModule` graph. Open: manifest lookup,
      aliases and rename re-lookup, fork network, ref constraints.
      **Create** `packages/agent/src/apps-catalog/app-blueprint-resolver.service.ts` per plan §2.5 (index of repos
      and aliases, `getRepository` rename; fork networks matched by the root `source` repository and then `parent`;
      explicit `blueprintId` path — `source: explicit`, no ref check for an unlisted repository, never verified; probe
      with ≤ 3 reads and `blueprint`-mode validation; ref constraints with `semver`; 1 h / 10 min caches), reusing the
      parser in `packages/agent/src/works/repository-work-source.ts`.
      **Create** `packages/agent/src/apps-catalog/app-source-catalog.adapter.ts` — binds APW-01's
      `APP_SOURCE_CATALOG_PORT` (`matchBlueprint({ owner, repo, blueprintId? })` → resolver, `null` on `none`,
      `refMismatch` or an unconfirmed fork match; `classifyLicense` → the registry, `unknown` until P3 lands), and
      maps the resolver's match source onto the port's `matchSource`, carries `displayName` (FR-63's default Work
      name, APW-01 T13 consumes it) and the entry's `prompts` descriptors (names and descriptions only, never a
      value — APW-01 FR-55), in `packages/agent/src/apps-catalog/apps-catalog.module.ts`. **The port is APW-01
      T11's file** (`packages/agent/src/app-works/app-source-catalog.port.ts`, an own PR that merges first); this
      task binds it and declares no port of its own. If `packages/agent/src/app-runtime/ports.ts` is absent, create
      it from CONTRACTS §3 verbatim (see "How to use").
      **Test**: `packages/agent/src/apps-catalog/__tests__/app-blueprint-resolver.spec.ts` — `calcom/cal.com` and
      `CALCOM/CAL.DIY` resolve to `cal` (ACC-03-23); a fork of a listed upstream needs confirmation and an
      excluded tag gives the ref reason (ACC-03-24); the probe finds a topic-carrying template as Unlisted with ≤ 3
      reads (ACC-03-25); an explicit id for a per-run generated repository resolves with `source: explicit` and an
      unknown id gives `blueprintNotFound` (ACC-03-44); a fork of a fork resolves through the root `source`
      (ACC-03-45). `packages/agent/src/apps-catalog/__tests__/app-source-catalog.adapter.spec.ts` — each `null` case,
      `blueprintId` passed through, a throwing resolver mapped to `null` (ACC-03-24).
      **Done when**: APW-01's inspect endpoint returns a match through the port with no APW-01 code change, the
      adapter spec satisfies APW-01's `AppSourceCatalogPort` interface for every `null` case and a match, and
      resolving writes no Activity.

- [ ] **T27 (parallel). Three-way spec merge.**
      **Create** `packages/agent/src/apps-catalog/app-spec-merge.ts` — key-wise merge, named-array merge by
      `name`, conflict list, `source` from ours.
      **Test**: `packages/agent/src/apps-catalog/__tests__/app-spec-merge.spec.ts` — user change kept, both
      sides changed ⇒ conflict, removed-by-Blueprint env entry kept when user edited it (ACC-03-29).
      **Done when**: the merge is pure (no I/O) and `source` never comes from `theirs`.

- [ ] **T28. Apply and upgrade job.**
      **Create** `packages/agent/src/apps-catalog/app-blueprint-apply.service.ts`,
      `packages/agent/src/tasks/app-blueprint-apply.types.ts`, `packages/agent/src/tasks/app-blueprint-apply-dispatcher.ts`
      (`APP_BLUEPRINT_APPLY_DISPATCHER`), `packages/tasks/src/tasks/trigger/app-blueprint-apply.task.ts`.
      **Modify** `packages/agent/src/tasks/app-works-jobs.ts` (handler), `packages/agent/src/tasks/index.ts`,
      `packages/agent/src/tasks/_tasks-symbols.ts`, `packages/agent/src/tasks/job-runtime.providers.ts`,
      `packages/tasks/src/tasks/trigger/index.ts`.
      Behaviour: plan §2.5 steps 1–6 and the upgrade branch — R-4: a fresh fork or private copy (file absent or
      `source`-only) gets `source` from `Work.sourceRepository` + the Blueprint spec in one `commitFiles` commit (no
      clone); Link and everything else get a pull request and never a push; after apply, request spec **and** license
      evaluation. Activity `app.blueprint.applied` / `app.blueprint.apply_failed` with `actionType: APP_BLUEPRINT`
      (R-2). The `app.blueprint.matched` record is T53. Three bindings this task must honour: - **Resolve against the right repository (G05).** `request` resolves the Blueprint against
      `sourceRepository.upstream` for relations `fork` and `private-copy`, and against the Work Repository for
      `link` — never against the fork itself. `userId` is optional with a documented fallback: the Work owner for
      a system-triggered apply. The match source and any fork confirmation APW-01 persisted
      (`sourceRepository.blueprintMatchSource`) are reused, so a ready-handler apply never re-asks for a
      confirmation the member already gave. - **Compose a spec that validates for every relation (GAP-02).** Before validation, adapt relation-dependent
      blocks: when the relation is `link`, drop `upstreamSync` from the Blueprint's spec and force
      `upstreamPullRequests.enabled: false`, because schema.md R13 makes `source.relation: link` with
      `upstreamSync` an error (`upstream_sync_requires_upstream`). The dropped keys are listed in the pull
      request body and in the Activity details — nothing is silently discarded, and the Blueprint repository's own
      file is never edited. - **Report the outcome (APW-01 FR-29b/FR-29a).** After persisting `blueprintApplyRef`, call APW-02's
      `APP_SOURCE_APPLY_REPORTER.recordSourceApplied(workId, result)` `@Optional()` with
      `{kind:'commit', sha}`, `{kind:'pull_request', number, url}` or `{kind:'failed', reason}`; a missing port or
      a throw is logged by code and never fatal. **The Blueprint's trademark display name (FR-63) is applied
      here**: `WorkAppSpecState.displayName` from the entry's `displayName`, and `works.name` is set to it only
      while the Work still carries the creation default (APW-01 T13's name), so a member who renamed the Work is
      never overridden. Upgrade mode makes **no** reporter call and no rename.
      **Test**: `packages/agent/src/apps-catalog/__tests__/app-blueprint-apply.spec.ts` — a fresh Fork App Work gets
      exactly one commit holding spec + add-only overlays and a Link App Work gets a PR with no push (ACC-03-26); a
      `.github/workflows/x.yml` overlay refused and an existing file never overwritten (ACC-03-27); a missing pinned
      commit refuses and writes nothing (ACC-03-28); upgrade PR keeps a user field, lists a conflict and is updated by a
      newer version (ACC-03-29); an explicit Blueprint applied to a generated repository (ACC-03-44); **Link plus a
      Blueprint whose spec carries `upstreamSync` composes a valid spec, drops that key and forces
      `upstreamPullRequests.enabled: false`, and lists what it dropped** (ACC-03-53); **a fork App Work resolves
      against its upstream and not against the fork, reusing the persisted match source, and `userId` omitted falls
      back to the Work owner** (ACC-03-54); **the reporter receives `commit`, `pull_request` and `failed` in their
      three cases and the upgrade mode makes no reporter call** (ACC-03-55); **the trademark display name lands on
      `WorkAppSpecState.displayName` and on `works.name` while the name is still the creation default, and a renamed
      Work keeps its name** (ACC-03-37).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-blueprint-apply` passes and the dispatcher symbol is in
      `DISPATCHER_SYMBOLS`.

- [ ] **T29. Apply, upgrade and dismiss endpoints.**
      **Modify** `apps/api/src/works/work-app-spec.controller.ts` and `apps/api/src/works/dto/app-spec.dto.ts` —
      `POST …/app-spec/blueprint`, `…/blueprint/upgrade`, `…/blueprint/dismiss` with the plan §4.2 codes and
      5/hour throttles.
      **Test**: extend `apps/api/src/works/work-app-spec.controller.spec.ts` — `blueprintNotFound`,
      `forkMatchNeedsConfirmation`, `applyInProgress`, `noUpgrade`; a viewer gets no upgrade action and another
      account's Work is 404 (ACC-03-41).
      **Done when**: the three routes are in the OpenAPI document and return `202`/`200` without awaiting a job.

- [ ] **T30. Hourly catalog refresh.**
      **Create** `packages/tasks/src/tasks/trigger/apps-catalog-refresh.task.ts` (cron `23 * * * *`, pinned
      equal to `APPS_CATALOG_REFRESH_CRON`) and `apps/api/src/apps-catalog/apps-catalog-refresh-cron.service.ts`
      (fallback when Trigger.dev is not the runtime, locked like
      `apps/api/src/skills/skill-readiness-sweep-cron.service.ts`); upgrade fan-out ≤ 500 per run emitting
      `app.blueprint.upgrade_available` once per version.
      **Modify** `packages/tasks/src/tasks/trigger/index.ts` — register the scheduled task.
      **Test**: `packages/tasks/src/__tests__/apps-catalog-refresh.task.spec.ts` and
      `apps/api/src/apps-catalog/apps-catalog-refresh-cron.service.spec.ts` — cron string, the 500 cap per run
      (ACC-03-22, upgrade half), once-per-version, one failing Work does not abort the run.
      **Done when**: both specs pass and the cron constant is asserted equal in both files.

- [ ] **T31. Blueprint card and upgrade dialog.**
      **Create** `apps/web/src/components/works/detail/settings/app-spec/AppBlueprintCard.tsx` and
      `apps/web/src/components/works/detail/settings/app-spec/AppBlueprintUpgradeDialog.tsx` (apply and upgrade
      variants).
      **Modify** `apps/web/src/components/works/detail/settings/app-spec/AppSpecPageClient.tsx` (fill the slot) and
      `apps/web/src/app/actions/dashboard/app-spec.ts` — `applyBlueprintAction`, `upgradeBlueprintAction`,
      `dismissBlueprintUpgradeAction`.
      **Test**: `apps/web/src/components/works/detail/settings/app-spec/AppBlueprintCard.unit.spec.tsx` — chips
      (incl. `Chosen for this repository` for an explicit match), breaking notice, pending PR state, dismiss hides only
      that version (ACC-03-29).
      **Done when**: `pnpm --filter ever-works-web test -- AppBlueprintCard` passes.

- [ ] **T32 (parallel). Apps catalog browser.**
      **Create** `apps/web/src/components/apps-catalog/AppsCatalogBrowser.tsx`, `apps/web/src/components/apps-catalog/AppsCatalogCard.tsx`,
      `apps/web/src/components/apps-catalog/AppsCatalogDetailsDrawer.tsx` with the `{ onSelect, initialQuery? }`
      contract of plan §5.1.
      **Test**: `apps/web/src/components/apps-catalog/AppsCatalogBrowser.unit.spec.tsx`,
      `apps/web/src/components/apps-catalog/AppsCatalogCard.unit.spec.tsx` — 300 ms debounce, 2-character minimum
      (ACC-03-19), category chips, placeholder not selectable, three distinct empty states, `/` focus, arrow-key roving
      focus, icon rendered with `<img>` only, the `upstreamAgreementMissing` tooltip copy.
      **Done when**: APW-01 can mount it with no change to the component.

- [ ] **T33. The `ever-works/templates` catalog repository** _(outside this monorepo)_.
      **Status (2026-09-26):** the repository is a **pure listing** (its PRs #1 `542a96c` and #2 `8437f29`,
      2026-09-25): `manifest.json` (one row per `-template` repository, website and app alike — the app rows `cal` →
      `ever-works/cal-template` (metadata-only) and `umami` → `ever-works/umami-template`, both `placeholder`),
      `schema/templates-manifest.schema.json`, `schema/app-spec.schema.json`, `licenses.yml`, and a validator
      (`tools/validate-specs.mjs`, run by its `validate.yml` workflow on push to `main`, on pull requests and weekly)
      that fetches each app row's own
      `.works/works.yml` from its template repository and validates it. It holds **no per-template folders and no copy
      of any App spec**; the spec lives only in the template repository's `.works/works.yml`, which is the only file the
      platform's resolver reads (`APP_BLUEPRINT_SPEC_PATH`). The fixture Blueprint `ever-works/app-fixture-hello-template`
      stays private and is not listed. `CONTRIBUTING.md` and `README.md` exist; the rest of this task (checks C1–C12 in
      its `validate.mjs` script, `release.yml`, `verify-expiry.yml`, `CODEOWNERS`, as below) is still the target.
      **Create** in `ever-works/templates` — **the repository that exists (2026-09-17); the earlier drafts called it
      `ever-works/apps`, and `EVER_WORKS_APPS_CATALOG_REPO` accepts either value, so the older name keeps working
      and nothing is renamed away** — `manifest.json` (`schemaVersion: 1`, empty `apps`), `licenses.yml`
      (legal-review draft per [catalog.md §4](./catalog.md), classes fixed per R-3), `schema/manifest.schema.json`
      (incl. `managedHosting.upstreamAgreement`), `schema/licenses.schema.json`, `schema/app-spec.schema.json` (copy of
      T8's output), `scripts/validate.mjs` (checks C1–C12, with C5 failing `red` and C6 the upstream-agreement rule;
      its C4 leg runs **T57's published validator package** — `@ever-works/contracts` at the version pinned in this
      repository's `package.json` — and its C12 leg compares the vendored schema against that same package's
      committed schema, so nothing here re-implements the platform's rules),
      `.github/workflows/validate.yml` (blueprint-draft mode for `.works/works.yml`, data-repository mode with a
      stub `source` for `profiles/*.works.yml`), `.github/workflows/release.yml` (tag `vX.Y.Z` and print the commit
      sha the catalog pull request pins into `sha:` — **never** stamp `blueprint:` into the file: blueprint mode
      forbids it), `.github/workflows/verify-expiry.yml`,
      `.github/CODEOWNERS` (legal reviewers own `licenses.yml` and `managedHosting.upstreamAgreement` changes),
      `CONTRIBUTING.md`, `README.md`.
      **Test**: `scripts/__tests__/validate.test.mjs` in that repository (`node --test scripts/__tests__`) — one failing
      fixture per check C1–C12, including a `red` entry (C5) and an amber `allowed: true` entry without an agreement
      (C6), and the listed Blueprint repositories' own `.works/works.yml` passing the C4 leg (the APW-13 drafts were
      the source until the live repositories replaced them, 2026-09-25).
      **Done when**: the repository is public, `validate.yml` is required on `main`, and the platform reads an
      empty catalog as `available: true` with zero entries.

- [ ] **T34. P2 i18n.**
      **Modify** `apps/web/messages/en.json` — `dashboard.workCreation.appsCatalog` (incl.
      `managedReason.upstreamAgreementMissing`) and `dashboard.workDetail.settings.appSpec.blueprint` (incl.
      `chipChosen`) keys of plan §8, plus the 20 sibling locale files under `apps/web/messages/`.
      **Modify** `apps/web/src/components/works/detail/settings/app-spec/app-spec-messages.unit.spec.ts` — add the two
      namespaces and the keys the T31/T32 components read.
      **Test**: `pnpm --filter ever-works-web test -- app-spec-messages` (ACC-03-43, P2 surfaces).
      **Done when**: the spec passes with the P2 namespaces listed.

- [ ] **T35. P2 e2e.**
      **Create** `apps/web/e2e/flow-apps-catalog-browse.spec.ts` (stubbed catalog, mounted in a test harness
      page until APW-01's form exists) and `apps/web/e2e/flow-app-blueprint-upgrade.spec.ts`.
      **Test**: `pnpm --filter ever-works-web test:e2e -- flow-apps-catalog-browse flow-app-blueprint-upgrade` — search,
      category, badges, details drawer, placeholder not selectable (ACC-03-19); unavailable state (ACC-03-16); notice →
      dialog → pending PR, dismiss hides only that version (ACC-03-29).
      **Done when**: both pass and `apps/web/e2e/flow-templates-catalog-pagination.spec.ts` and
      `apps/web/e2e/flow-website-template-catalog.spec.ts` pass unchanged.

- [ ] **T36 (parallel). P2 docs.**
      **Create** `docs/api/apps-catalog.md` — the three public routes, query parameters, response shape,
      caching, availability reasons (incl. `upstreamAgreementMissing`), examples.
      **Modify** `docs/api/works.md` — apply, upgrade, dismiss; the explicit `blueprintId` on create.
      **Modify** `docs/environment-variables.md` — `EVER_WORKS_APPS_CATALOG_REPO`, `EVER_WORKS_APPS_CATALOG_REF`
      (pin a sha or tag in production), `EVER_WORKS_APPS_CATALOG_TOKEN`.
      **Test**: `pnpm --filter ever-works-docs build` — no broken-link warning.
      **Done when**: the docs build is green and the three variables are listed.

- [ ] **T37. P2 ship gate.**
      **Modify** `docs/specs/features/app-works/APW-03-app-spec-and-catalog/tasks.md` (tick T22–T36, T53) and the APW-03
      row of `docs/specs/features/app-works/TRACKER.md`.
      **Test**: `pnpm format:check && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
      **Done when**: all five commands are green on the P2 merge commit.

---

# Phase P3 — License gate

_Delivers spec FR-53…FR-65._

- [ ] **T38. Recursive repository listing.**
      **Modify** `packages/plugin/src/contracts/capabilities/git-provider.interface.ts` —
      `getRepositoryTree?` per plan §7; `packages/plugins/github/src/github-api.service.ts` (`git.getTree`
      `recursive=1`, `truncated`, `maxEntries`), `packages/plugins/github/src/github.plugin.ts`,
      `packages/agent/src/facades/git.facade.ts`.
      **Test**: extend `packages/plugins/github/src/__tests__/github-api.app-works.spec.ts` — truncation flag,
      entry cap.
      **Done when**: `pnpm --filter @ever-works/github-plugin test` passes and a provider without the method makes the
      facade return `null`.

- [ ] **T39 (parallel). SPDX expressions and classification.**
      **Create** `packages/agent/src/app-license/spdx-expression.ts` (OR, AND, WITH, parentheses,
      `LicenseRef-*`; ≤ 200 chars) and `packages/agent/src/app-license/license-classify.ts` (best/worst/exception
      rules, obligations union, mixed and unknown handling).
      **Test**: `packages/agent/src/app-license/__tests__/spdx-expression.spec.ts`,
      `packages/agent/src/app-license/__tests__/license-classify.spec.ts` — MIT, Apache-2.0, AGPL green, BUSL-1.1
      amber, no license unknown (ACC-03-30); `MIT OR BUSL-1.1` green and `MIT AND BUSL-1.1` amber (ACC-03-31).
      **Done when**: both modules are pure and `pnpm --filter @ever-works/agent test -- spdx-expression license-classify` passes.

- [ ] **T40 (parallel). Registry, snapshot and reference texts.**
      **Create** `packages/agent/src/app-license/license-registry.ts` (validation per catalog.md §4 incl. the fixed
      R-3 `classes`, source preference live → last good → snapshot),
      `packages/agent/src/app-license/license-registry.snapshot.yml`, and
      `packages/agent/src/app-license/texts/<spdx>.txt` for every identifier in the snapshot.
      **Test**: `packages/agent/src/app-license/__tests__/license-registry.spec.ts` — every catalog.md §4 rule; a
      snapshot-sourced verdict carries `managedHosting: false` after 8 days without a live read (ACC-03-38); a changed
      `text` under an unchanged `textId` is rejected; a registry that sets `red.catalog: true` or loosens a class is
      rejected for the last good copy (ACC-03-46).
      **Done when**: every identifier in the snapshot has a text file (asserted by the spec).

- [ ] **T41. Detection and header scanning.**
      **Create** `packages/agent/src/app-license/license-detect.ts` (root files, four package manifests,
      normalised word-bigram Dice ≥ 0.90, aliases, mixed directories at depth ≤ 4, nested license files,
      evidence ≤ 20) and `packages/agent/src/app-license/license-headers.ts` (`scanLicenseHeaders`, first 2 KiB per file).
      **Test**: `packages/agent/src/app-license/__tests__/license-detect.spec.ts` — similarity 0.89 vs 0.90, depth 4 vs
      5, an `ee/` directory makes the repository mixed and at least amber with the path in evidence (ACC-03-32), ≤ 12
      reads; `packages/agent/src/app-license/__tests__/license-headers.spec.ts`.
      **Done when**: both specs pass and detection performs no write.

- [ ] **T42. `AppLicenseService`, dispatcher and job.**
      **Create** `packages/agent/src/app-license/app-license.service.ts` (`request`, `evaluate`,
      `getHostingEligibility`, `attest`, `previewUpstream`, `recordEvidence`), `packages/agent/src/app-license/app-license.module.ts`,
      `packages/agent/src/app-license/index.ts`; `packages/agent/src/tasks/app-license-evaluate.types.ts`,
      `packages/agent/src/tasks/app-license-evaluate-dispatcher.ts` (`APP_LICENSE_EVALUATE_DISPATCHER`),
      `packages/tasks/src/tasks/trigger/app-license-evaluate.task.ts`.
      **Modify** `packages/agent/package.json` (`./app-license`), `packages/agent/src/tasks/app-works-jobs.ts`
      (handler), `packages/agent/src/tasks/index.ts`, `packages/agent/src/tasks/_tasks-symbols.ts`,
      `packages/agent/src/tasks/job-runtime.providers.ts`, `packages/tasks/src/tasks/trigger/index.ts`.
      Eligibility per R-3 (plan §2.6): Your cluster after the owner's attestation for amber, red and unknown; Ever Works
      Apps for green, and for amber only with a recorded upstream agreement; red and unknown never. Source offer
      required only when the obligation applies and the relation is `link` or the Work Repository is ahead of upstream
      (plan §2.6, same condition as APW-06 FR-44). The four settled points of plan §2.6 are written into the code:
      `getHostingEligibility(workId, opts?: { commitSha?: string })`, a **null** `aheadBy` counts as required, the
      public check is `GitRepository.visibility === 'public'` (falling back to `isPrivate === false` from
      `getRepository`, with `internal` or a failed lookup counting as not public), and `sourceOffer.url` is built with
      `getFileWebUrl(dataOwner, dataRepo, commitSha, '')` — an **empty path returns the tree URL at that commit**
      (`https://github.com/<o>/<r>/tree/<sha>`, no `lineAnchor`) and is `null` when the call carried no `commitSha`.
      Activity `app.license.classified` / `changed` /
      `attestation_required` / `attested` with `actionType: APP_LICENSE` (R-2); `AppLicenseChangedEvent` on change.
      **Test**: `packages/agent/src/app-license/__tests__/app-license.service.spec.ts` — an amber Work refused for Ever
      Works Apps by `getHostingEligibility` (ACC-03-33); manager refused, owner recorded with text hash and commit, a new
      text id clears it (ACC-03-34); MIT → BUSL-1.1 notifies, keeps running Deployments and requires attestation next
      (ACC-03-35); private AGPL without `sourceOfferUrl` ⇒ `sourceOfferMissing` (ACC-03-36); 8-day registry outage never
      managed-eligible (ACC-03-38); amber with an agreement eligible, red on Your cluster only after attestation and
      never managed (ACC-03-47); the eligibility line for a Work whose Blueprint carries a trademark notice names the
      notice the Blueprint set (`WorkAppSpecState.displayName`, written by T28 — **the license service never creates
      or renames a Work**, so ACC-03-37's Work-name assertion lives in
      `packages/agent/src/apps-catalog/__tests__/app-blueprint-apply.spec.ts` and in APW-01's create spec).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-license.service` passes and the dispatcher symbol is in
      `DISPATCHER_SYMBOLS`.

- [ ] **T43. Wire the triggers.**
      **Modify** `packages/agent/src/app-spec/app-spec.service.ts` — after an effective-commit change, request
      license evaluation when `getCompareDiff(licenseCommitSha, head)` touches a license-relevant path (or
      `licenseCommitSha` is null).
      **Modify** `apps/api/src/apps-catalog/apps-catalog-refresh-cron.service.ts` and
      `packages/tasks/src/tasks/trigger/apps-catalog-refresh.task.ts` — registry-change fan-out ≤ 500 per run.
      **Test**: extend `packages/agent/src/app-spec/__tests__/app-spec.service.spec.ts` (license request on a relevant
      diff only), `packages/tasks/src/__tests__/apps-catalog-refresh.task.spec.ts` and
      `apps/api/src/apps-catalog/apps-catalog-refresh-cron.service.spec.ts` — a registry change re-classifies at most
      500 Works per run and continues next run (ACC-03-22).
      **Done when**: the three specs pass.

- [ ] **T44. Attestation endpoint.**
      **Modify** `apps/api/src/works/work-app-spec.controller.ts` and `apps/api/src/works/dto/app-spec.dto.ts` —
      `POST /api/works/:id/app-license/attest` with `WorkOwnershipService.ensureIsOwner`, `403 ownerOnly`,
      `422 attestationNotRequired`, `409 licenseChanged`, 10/min throttle; include the license part in the
      `GET app-spec` DTO.
      **Test**: extend `apps/api/src/works/work-app-spec.controller.spec.ts` — manager `403 ownerOnly`, owner `200`
      (ACC-03-34); viewer and cross-account Work (ACC-03-41).
      **Done when**: the route is in the OpenAPI document with its four error codes.

- [ ] **T45. License card and attestation dialog.**
      **Create** `apps/web/src/components/works/detail/settings/app-spec/AppLicenseCard.tsx` and
      `apps/web/src/components/works/detail/settings/app-spec/AppLicenseAttestDialog.tsx`.
      **Modify** `apps/web/src/components/works/detail/settings/app-spec/AppSpecPageClient.tsx` (fill the slot) and
      `apps/web/src/app/actions/dashboard/app-spec.ts` — `attestLicenseAction`.
      **Test**: `apps/web/src/components/works/detail/settings/app-spec/AppLicenseCard.unit.spec.tsx`,
      `apps/web/src/components/works/detail/settings/app-spec/AppLicenseAttestDialog.unit.spec.tsx` — every eligibility
      line (incl. `allowed under an agreement with the app's authors`), mixed and incomplete evidence, source-offer
      variants, checkbox gating, owner-only copy, disclaimer present (ACC-03-34).
      **Done when**: `pnpm --filter ever-works-web test -- AppLicenseCard AppLicenseAttestDialog` passes.

- [ ] **T46. P3 i18n.**
      **Modify** `apps/web/messages/en.json` — `dashboard.workDetail.settings.appSpec.license` keys of plan §8 (incl.
      `managedAllowedAgreement`); the 20 sibling locale files under `apps/web/messages/`.
      **Modify** `apps/web/src/components/works/detail/settings/app-spec/app-spec-messages.unit.spec.ts` — add the
      license namespace and the keys T45 reads.
      **Test**: `pnpm --filter ever-works-web test -- app-spec-messages` (ACC-03-43, P3 surfaces — the full criterion).
      **Done when**: the spec lists every namespace of the App spec tab, catalog browser, Blueprint card, License card
      and attestation dialog and passes in all 21 locales.

- [ ] **T47. P3 e2e.**
      **Create** `apps/web/e2e/flow-app-license-attest.spec.ts` and `apps/web/e2e/flow-app-works-a11y.spec.ts`.
      **Test**: `pnpm --filter ever-works-web test:e2e -- flow-app-license-attest flow-app-works-a11y` — amber Work:
      owner confirms, manager sees owner-only copy, eligibility lines update (ACC-03-34, ACC-03-41); axe over the
      catalog browser, problems list and attestation dialog plus the spec §6.4 keyboard paths (ACC-03-42).
      **Done when**: both pass with no new axe violations against the recorded baseline.

- [ ] **T48. P3 ship gate.**
      **Modify** `docs/specs/features/app-works/APW-03-app-spec-and-catalog/tasks.md` (tick T38–T47) and the APW-03 row
      of `docs/specs/features/app-works/TRACKER.md`.
      **Test**: `pnpm format:check && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
      **Done when**: all five commands are green on the P3 merge commit.

---

# Cross-phase closing tasks

- [ ] **T49. Telemetry.**
      **Create** `packages/agent/src/app-spec/app-spec-telemetry.port.ts` — `AppSpecTelemetryEvent`, the per-event
      property allow-list and `APP_SPEC_TELEMETRY_SINK` per [plan §9.1](./plan.md): `track(event, props, distinctId)`,
      fire-and-forget, never throwing; a property outside the allow-list is dropped at the port boundary; unbound ⇒
      counted and dropped. **`packages/agent` gains no dependency**: it does not depend on `@ever-works/monitoring`
      today (only `apps/api` does), and the agent-package precedent is a narrow injected client port
      (`packages/agent/src/services/knowledge-base-reconcile.service.ts:55-67`).
      **Create** `packages/monitoring/src/posthog/app-spec-events.ts` — `emitAppSpecEvent(client, distinctId, event)`
      for the eight events of [plan §9.1](./plan.md) with a forbidden-property list (file content, env values, search
      text, user-typed repository names), modelled on `packages/monitoring/src/posthog/kb-events.ts`.
      **Modify** `packages/monitoring/src/posthog/index.ts` — export it.
      **Modify** `apps/api/src/app-works/app-works.module.ts` (created by APW-02 T27) — bind
      `APP_SPEC_TELEMETRY_SINK` to a sink that calls `emitAppSpecEvent` with the API's PostHog client, exactly as
      `FunnelAnalyticsSink` is bound for `zero-friction-funnel.service.ts`. **Modify**
      `packages/agent/src/app-spec/app-spec.service.ts`,
      `packages/agent/src/apps-catalog/apps-catalog.service.ts`, `packages/agent/src/apps-catalog/app-blueprint-apply.service.ts`,
      `packages/agent/src/app-license/app-license.service.ts` — inject the port `@Optional()` and emit through it;
      no service imports the monitoring package.
      **Test**: `packages/monitoring/src/posthog/__tests__/app-spec-events.spec.ts` — no payload contains file
      content, an env value, a search query or an upstream repository name typed by a user; forbidden keys throw; and
      `packages/agent/src/app-spec/__tests__/app-spec-telemetry.spec.ts` — the four services emit through the bound
      fake, nothing is thrown with the port unbound, and a property outside the allow-list never reaches the sink.
      **Done when**: `pnpm --filter @ever-works/monitoring test -- app-spec-events` passes,
      `git grep -n "monitoring" packages/agent/package.json` still matches nothing, and the four services' specs are
      green with the sink unbound.

- [ ] **T50. User documentation.**
      **Create** `docs/features/app-blueprints.md` from [`user-doc-draft.md`](./user-doc-draft.md), updated to
      what shipped.
      **Modify** `apps/docs/sidebarsPlatform.ts` — list it next to `features/work-blueprints`.
      **Modify** `docs/features/work-blueprints.md` — add a row for the Apps catalog to "Three catalogs, one
      picker" and a link.
      **Test**: `pnpm --filter ever-works-docs build` — no broken-link warning.
      **Done when**: the page is reachable from the platform docs sidebar.

- [ ] **T51. Acceptance wiring.**
      **Modify** `docs/specs/features/app-works/ACCEPTANCE.md` — map ACC-03-01…ACC-03-49 to the test files that
      prove them.
      **Modify** `docs/specs/features/app-works/TRACKER.md` — APW-03 spec and implementation status.
      **Test**: `rg -c "ACC-03-(0[1-9]|[1-4][0-9])" docs/specs/features/app-works/ACCEPTANCE.md` counts every id
      with a named file and no `TBD` cell remains for APW-03.
      **Done when**: ACCEPTANCE §3 APW-03 has 49 rows, each with a test file.

- [ ] **T52. Close out.**
      **Modify** `docs/specs/features/app-works/APW-03-app-spec-and-catalog/spec.md`, `…/plan.md` and this file — set
      `Implemented` / `Done`; `docs/specs/features/app-works/CONTRACTS.md` only if a shipped name differs.
      **Test**: walk every gate in [plan §12](./plan.md) against the merged code and diff CONTRACTS §1–§6 APW-03 names
      against `packages/contracts/src/apps/`.
      **Done when**: statuses read `Implemented` / `Done` and CONTRACTS.md matches every shipped name.

- [ ] **T53 (P2, lands with T28). Record `app.blueprint.matched`.**
      **Modify** `packages/agent/src/apps-catalog/app-blueprint-apply.service.ts` — `request(workId, blueprintId, { userId, matchSource, confirmForkMatch })` per plan §2.5 step 0: resolve (explicit id honoured for any
      repository, spec FR-81), persist the match, then `WorkAppSpecStateRepository.markBlueprintMatched` and, only when it
      returns `true`, `ActivityLogService.log({ action: 'app.blueprint.matched', actionType: APP_BLUEPRINT, details: { blueprintId, version, matchSource } })` before dispatching `APP_BLUEPRINT_APPLY_DISPATCHER`.
      **Modify** `packages/agent/src/database/repositories/work-app-spec-state.repository.ts` — `markBlueprintMatched`
      (if not already added in T11).
      **Test**: `packages/agent/src/apps-catalog/__tests__/app-blueprint-matched.spec.ts` — exactly one
      `app.blueprint.matched` per Work + version for a manifest match, a catalog pick and an explicit id on a per-run
      generated repository; it precedes `app.blueprint.applied` and `app.blueprint.apply_failed`; a retried request, a
      job retry and a re-dispatch record nothing new; details hold only id, version and match source; inspect
      (`AppSourceCatalogAdapter.matchBlueprint`) records nothing (ACC-03-44).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-blueprint-matched` passes and the ACC-E2E-05 Activity
      order (`app.blueprint.matched` → `app.blueprint.applied` → `app.spec.applied`) holds in the service-level
      integration case.

- [ ] **T54 (P1, lands with T9–T10). Classify new tables for workspace backup (R-25).**
      **Modify** `packages/agent/src/account-transfer/backup/collectors/domain-specs.ts` — append to the `works` domain:
      `{ file: 'app-spec-states.jsonl', entity: 'WorkAppSpecState', scope: { by: 'parent', column: 'workId', from: 'workIds' } }`.
      **Modify** `packages/agent/src/account-transfer/backup/redaction.ts` — add `headSpecHash`, `effectiveSpecHash` and
      `licenseRegistryHash` to `BACKUP_BENIGN_COLUMNS`, each with its reason (a sha256 of the canonical App spec, which
      holds no secret values, or of the public license registry). Nothing joins `BACKUP_DROPPED_ENTITIES`;
      `effectiveSpec` and `attestation` export as stored.
      **Test**: extend `packages/agent/src/account-transfer/backup/collectors/collectors.spec.ts` — `WorkAppSpecState`
      is referenced exactly once, in `works`, scoped `parent` on `workId` from `workIds`, not dropped; an
      `EntityBackupCollector` over the `works` spec yields a fixture row with its three `*Hash` columns unchanged.
      **Done when**: `pnpm --filter @ever-works/agent test -- collectors redaction` is green — including the
      secret-shaped-column guard in `redaction.spec.ts` — and a backup of a workspace holding one App Work lists
      `data/works/app-spec-states.jsonl`.

- [ ] **T55 (P2 seam, own PRs — the interface-first split; no whole-phase loop).** Three small PRs, in this order,
      each complete on its own and each merged before APW-01 P1: 1. **`commitFiles?`** — the git-capability slice of T22: `GitRepository.commitFiles?` in
      `packages/plugin/src/contracts/capabilities/git-provider.interface.ts`, its GitHub implementation in
      `packages/plugins/github/src/github-api.service.ts`, the delegation in
      `packages/plugins/github/src/github.plugin.ts` and the `null`/`unsupported` wrapper in
      `packages/agent/src/facades/git.facade.ts`. T22 then adds only `topics?` and `getFileWebUrl?`. 2. **The catalog seam** — T24's read paths and T26's adapter, so `packages/agent/src/app-works/` gains its
      binding: `AppSourceCatalogAdapter` implements APW-01 T11's `AppSourceCatalogPort` (including
      `matchSource`, `displayName` and `prompts`) in `packages/agent/src/apps-catalog/apps-catalog.module.ts`. 3. **The apply seam** — T28 with T53 (the apply job and the `app.blueprint.matched` record), which
      `AppSourceInitializerService` (APW-01 T15) calls.
      **Create** nothing beyond those three PRs' own files; the point of this task is the ordering, recorded once.
      **Test**: each PR runs its own task's spec (T22's, T24/T26's, T28/T53's) and `pnpm --filter @ever-works/agent
test -- app-spec` stays green.
      **Done when**: APW-01 P1 can be built against all three without any other APW-03 task having merged, and
      `git grep -n "APW-01 P1" docs/specs/features/app-works/APW-03-app-spec-and-catalog/tasks.md` finds only this
      sentence.

- [ ] **T56 (P1 and P2, lands with T13, T28 and T42). Job wiring: Trigger.dev bindings, worker RPC and where each
      event is emitted.** The three jobs this epic dispatches follow the existing `MEMORY_FACT_EMBED_DISPATCHER`
      pattern end to end; symbol files and a trigger task alone are not enough.
      **Create** (P1, with T13) `packages/tasks/src/dispatchers/app-spec-evaluate.dispatcher.ts`; **Create** (P2,
      with T28) `packages/tasks/src/dispatchers/app-blueprint-apply.dispatcher.ts`; **Create** (P3, with T42)
      `packages/tasks/src/dispatchers/app-license-evaluate.dispatcher.ts`.
      **Modify** `packages/tasks/src/trigger/trigger.service.ts` (`dispatchAppSpecEvaluate`,
      `dispatchAppBlueprintApply`, `dispatchAppLicenseEvaluate`, mirroring `dispatchMemoryFactEmbed`, with the
      idempotency keys APW-03's payloads carry), `packages/tasks/src/trigger/trigger-tenant-client.factory.ts`
      (the three ids), `packages/tasks/src/trigger/trigger.module.ts` (provider + export, beside the existing
      dispatcher at `:164`), `packages/tasks/src/index.ts` (exports) and `packages/tasks/src/tasks/trigger/index.ts`.
      **Modify** `apps/api/src/trigger/trigger-internal.controller.ts` — add `@Optional()`
      `AppSpecService`, `AppBlueprintApplyService` and `AppLicenseService` parameters **appended last**, and their
      `remoteMap` entries; **Modify** `apps/api/src/trigger/trigger-internal.module.ts` — import the agent
      `AppSpecModule`, `AppsCatalogModule` and `AppLicenseModule`; **Modify**
      `packages/tasks/src/trigger/worker/modules/trigger-internal.module.ts` —
      `APP_SPEC_SERVICE`, `APP_BLUEPRINT_APPLY_SERVICE` and `APP_LICENSE_SERVICE` through `createRemoteProxy`,
      exported, following `MemoryFactEmbedService` (`:431-433`).
      **The worker never evaluates.** Every Trigger task calls its service through the RPC proxy, so the
      evaluation, the database writes and the in-process events all run **in the API process** — which is what
      makes `AppSpecAppliedEvent` and `AppLicenseChangedEvent` reach APW-05, APW-07 and APW-08, whose `@OnEvent`
      listeners live in API-side agent modules. The worker has its own `EventEmitterModule`
      (`trigger-plugins.module.ts:41`), so an event emitted inside the worker would reach nobody; plan §6.1 states
      this and names the emitting process.
      **Test**: **create** `packages/tasks/src/dispatchers/__tests__/app-spec-evaluate.dispatcher.spec.ts` (and the
      sibling specs for the other two) — the id is forwarded, a `null` dispatch runs the handler in-process;
      extend `packages/tasks/src/__tests__/trigger.service.spec.ts` — three dispatchers, unconfigured ⇒ `null`,
      idempotency-key shape; extend `apps/api/src/trigger/trigger-internal.controller.spec.ts` — the three names in
      `remoteMap` with their method allow-lists; extend
      `packages/tasks/src/trigger/worker/modules/trigger-internal.module.spec.ts` — the worker compiles with no
      database module and each of the three resolves to a remote proxy, and an event emitted by a service call
      reaches an API-side `@OnEvent` listener in the integration case (ACC-03-50).
      **Done when**: all four specs are green and `git grep -n "AppSpecAppliedEvent" packages/tasks/src` finds no
      emit site.

- [ ] **T57 (P2, lands with T33 and T8). The published validator artifact C4 and C12 run.**
      **Create** `packages/contracts/src/apps/validator/` — a publishable entry point re-exporting the pure
      validator (`validateAppSpecDocument`, `validateAppSpecObject`, `APP_SPEC_ISSUE_CODES`) from
      `packages/agent/src/works-config/schema/`'s pure modules, plus the committed JSON Schema of T8. It lives in
      `packages/contracts` because that package is **not** private, so Blueprint CI can install it; nothing is moved
      out of `packages/agent` — the agent package re-exports the same modules it does today.
      **Modify** `packages/contracts/package.json` — a `./apps/validator` subpath export and the `files` entry;
      **Create** `.github/workflows/publish-app-spec-validator.yml` — publishes `@ever-works/contracts` on a tag,
      with `EVER_WORKS_APP_SPEC_VALIDATOR_VERSION` recorded in the catalog repository's `package.json` pin.
      **Test**: `packages/contracts/src/apps/__tests__/validator-entry.spec.ts` — the entry validates schema.md
      §24.1–§24.4 and reports the same codes the agent package reports; a drift guard asserts the committed JSON
      Schema equals T8's generator output (ACC-03-51).
      **Done when**: a scratch install of the packed tarball validates a Blueprint draft and the catalog
      repository's `package.json` names its exact version.

- [ ] **T58 (P2, lands with T33). Validate every Blueprint draft in `blueprint` mode.**
      **Note (2026-09-26):** the `cal-diy/` and `umami/` drafts under `APW-13-golden-paths/blueprints/` are being
      retired: the live repositories [`ever-works/cal-template`](https://github.com/ever-works/cal-template) (formerly
      `cal-diy-template`) and [`ever-works/umami-template`](https://github.com/ever-works/umami-template) are the
      source, and `ever-works/templates`' CI validates their own `.works/works.yml` (T33 status). Once they are gone
      this walk covers the drafts still present (the private `app-fixture-hello` fixture) and "all three drafts" below
      reads "every draft present".
      **Create** `packages/agent/src/works-config/schema/__tests__/blueprint-drafts.spec.ts` — walks
      `docs/specs/features/app-works/APW-13-golden-paths/blueprints/*/.works/works.yml` and validates each in
      **`blueprint` mode**, which schema.md §3's corrected row defines as allowing and expecting `source` and
      `blueprint` (the 2026-09-17 correction — the drafts declare both, and the apply job composes the real `source`
      itself), asserting zero errors; warnings are reported but not fatal (ACC-03-52). This is the same mode and the
      same rules catalog CI check C4 runs through T57's published artifact, so a draft that passes here cannot fail
      there.
      **Modify** `docs/specs/features/app-works/APW-03-app-spec-and-catalog/catalog.md` §5 — reference this spec as
      the mechanism behind catalog check C4's blueprint-mode leg.
      **Test**: `pnpm --filter @ever-works/agent test -- blueprint-drafts` — every draft directory present under
      `blueprints/` is validated, and the spec fails loudly if the folder holds a draft it did not read.
      **Done when**: the spec is green for all three drafts, and the same three files still fail for the reasons
      that are real defects (a reserved `EVER_WORKS_*` env name, a look-around `validate.pattern`, a below-minimum
      memory request) whenever those are reintroduced — a contrast case keeps that honest.

- [ ] **T59 (P2, lands with T8 and T33). A machine-checkable schema and a fixture corpus beside the prose.**
      This file is normative prose; until T8's generator exists there is nothing a Blueprint draft, a profile draft
      or a CI job can be checked against, and drift has already happened once (a small validator found two invalid
      Blueprint drafts). The corpus below is **additive documentation, committed with the spec**, not a second
      source of truth: schema.md stays the reference and T8's generated schema stays the artifact the platform
      ships.
      **Create** `docs/specs/features/app-works/contracts/app-spec.schema.json` — JSON Schema **2020-12** mirroring
      schema.md §1–§22: types, enums, bounds (`minLength`/`maxLength`/`maximum`/`minimum`), `required`,
      `additionalProperties: false` with `patternProperties` `'^x-'` for extension keys. Structural only — the
      cross-field rules (schema.md §22) stay in code, and the file's header comment says so.
      **Create** `docs/specs/features/app-works/contracts/fixtures/app-spec/valid/*.yml` — the three Blueprint
      drafts under `APW-13-golden-paths/blueprints/` plus schema.md §24.1, §24.2 and §24.3 (see T58's note: the live
      repositories' `.works/works.yml` replace the retired Cal and Umami drafts).
      **Create** `docs/specs/features/app-works/contracts/fixtures/app-spec/invalid/<code>.yml` — one file per
      structural issue code and one per rule in schema.md §22, each with a `# expect: <code>` header, so a failure
      names the file that must report it.
      **Modify** `docs/specs/features/app-works/APW-03-app-spec-and-catalog/schema.md` §0 — state that the
      machine-checkable mirror of §1–§22 is `contracts/app-spec.schema.json` with its corpus, that it is checked in
      CI, and that where the two ever disagree the **prose wins** and the JSON Schema is corrected.
      **Test**: **create** `packages/agent/src/works-config/schema/__tests__/app-spec.corpus.spec.ts` — T8's
      generated schema and `validateAppSpecDocument`/`validateAppSpecObject` give **identical** verdicts over every
      file in the corpus (each `valid/*.yml` ⇒ no errors, each `invalid/<code>.yml` ⇒ exactly the code in its
      header); the committed `contracts/app-spec.schema.json` accepts every `valid/*.yml` under `ajv` 2020-12
      (`Ajv2020` from the root `node_modules`); and a drift guard fails when a `valid/*.yml` is edited without the
      verdict being re-checked, so the corpus cannot rot silently.
      **Done when**: the corpus spec is green, `npx ajv`-style validation of the corpus through
      `contracts/app-spec.schema.json` agrees with the code validator, and the three Blueprint drafts are in the
      corpus as `valid/` files (T58 keeps validating them where they live).

---

## Definition of Done

- Every checkbox above is ticked.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test` and `pnpm build` are green from the root.
- Every pre-existing `works-config` schema test and the three catalog e2e specs named in T19 and T35 pass
  **unchanged** — the additive-only proof.
- `works.v2.schema.json` and `app-spec.v1.schema.json` match their generators; the copy in `ever-works/apps`
  matches `app-spec.v1.schema.json`.
- `pnpm --filter ever-works-docs build` produces no broken-link warnings.
- Every ACC-03 box in [spec §8](./spec.md) (ACC-03-01…ACC-03-49) has a named test above and has been walked against a
  running build.
- No catalog-service test observed a request to an upstream repository or a manifest link.
- No code path reads `EVER_WORKS_APPS_MANAGED_ENABLED` in this epic's modules, no App spec names a builder for
  `auto`, and no test file lives under `apps/api/test/`.
