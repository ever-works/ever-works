/**
 * Public API of the App spec (APW-03 plan §2.1:97-99) — imported as
 * `@ever-works/agent/app-spec`.
 *
 * The barrel starts with what T12/T13 land and grows additively as the epic's
 * remaining P1 services arrive (T14's GitHub intake, T15's routes, T20+ catalog,
 * T31+ licence): each adds its own `export *` line here, so an importer never
 * reaches into a deep path
 * (`@ever-works/agent/app-spec/app-spec.service`). Nothing is re-exported
 * speculatively — a name that does not exist yet must not appear, or `apps/api`
 * and `packages/tasks` would compile against a module that does not resolve.
 *
 * - `./app-spec.service` — `AppSpecService` (T12) plus the string shapes its
 *   callers read: `AppSpecEvaluationOutcome`, `AppSpecEffectiveRead`,
 *   `AppSpecDraftValidation`, `AppSpecStateRead`, `AppSpecWorkContext`, the
 *   named failure codes and the lock key.
 * - `./app-spec-hash` — the canonical `spec` hash of FR-23 (`hashAppSpec`),
 *   `canonicalAppSpecJson` and the hash comparison.
 * - `./app-spec-guarded-blocks` — `diffGuardedSpecBlocks` and `isProtectedPath`
 *   (FR-26, ACC-03-15), the two functions APW-08's `AppChangeGuard` consumes, plus
 *   the additive companions `isRequireHumanMergePath`, `GUARDED_SPEC_BLOCKS` and
 *   `HUMAN_REQUIRED_SPEC_BLOCKS`.
 * - `./app-spec.module` — `AppSpecModule`, what `apps/api`'s Works module imports.
 *
 * The `app.spec.applied` event itself lives in `@ever-works/agent/events`
 * (`packages/agent/src/events/app-spec-applied.event.ts`), where every other
 * in-process event of this package lives — one bus, one import path, so a
 * listener never has to know which feature folder published it.
 */

export * from './app-spec.service';
export * from './app-spec-hash';
export * from './app-spec-guarded-blocks';
export * from './app-spec.module';
