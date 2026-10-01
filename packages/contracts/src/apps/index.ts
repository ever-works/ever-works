/**
 * App Works — the shared contract surface for the "any GitHub repository as a
 * Work" programme (APW-01…APW-13).
 *
 * Every module here is **types, closed unions, constants and pure resolvers
 * only** — no I/O, no dependency on another workspace package — so the API,
 * the web app, the agent package and the plugins can all agree on one
 * vocabulary without importing each other.
 *
 * Why a single folder rather than one per epic: an App Work crosses every epic
 * (create → fork → App spec → build → run → evolve → contribute), and the
 * failure this layout prevents is two epics declaring "the same" union or
 * constant slightly differently. Where a value already existed elsewhere in
 * this package it is imported or re-exported, never redeclared.
 *
 * | Module                 | Owner        | What it holds                                                     |
 * | ---------------------- | ------------ | ----------------------------------------------------------------- |
 * | `app-source`           | APW-01, 03   | source/inspect model, repository modes, deploy targets, reason codes, create + delete contracts |
 * | `apps-limits`          | APW-01       | the ONE per-stage repository-limits source (CONTRACTS §2A) and the quota caps (§7A) |
 * | `app-upstream`         | APW-02       | readiness, sync, Actions hygiene, divergence and the closed reason unions |
 * | `builds`               | APW-05       | build + preparation model, `AppVerificationPlan` v1, failure copy, the build-service defaults |
 * | `app-env`              | APW-07       | env entries, generated values and the keypair formats             |
 * | `app-dependencies`     | APW-07       | dependency kinds, outputs and the reconciliation contract          |
 * | `tenant-postgres-ddl`  | APW-07, 10   | the tenant DDL payload the provisioners render                     |
 * | `apps-tier`            | APW-10       | the managed tier's desired state, quota profiles, refusal codes and the pricebook |
 * | `ever-id`              | APW-12       | Ever ID constants, limits, relying-party config and the error vocabulary |
 * | `app-runtime`          | APW-06       | deploy targets/phases/states, the 38 precondition and 18 failure codes, the 52 runtime numbers, and the code→state and code→i18n-leaf totality maps |
 * | `app-launcher`         | APW-11       | launcher unions, item and response shapes, the pin/response/panel/catalog caps and two fail-closed predicates |
 *
 * (The table lists ten modules; `git ls-files` on this folder is the authority if the two ever disagree — two
 * modules were added without a row here once already, which is exactly how a table like this goes stale.)
 *
 * NOTHING here may be removed, narrowed or marked obsolete (CONTRACTS R-26,
 * the owner's additive-only rule): a closed union gains members, a limit is
 * raised deliberately, and an existing name keeps working.
 */
export * from './app-dependencies.js';
export * from './app-env.js';
export * from './app-launcher.js';
export * from './app-license.types.js';
export * from './app-runtime.js';
export * from './app-source.js';
export * from './app-spec-issues.js';
export * from './app-spec.types.js';
export * from './app-upstream.js';
export * from './apps-catalog.types.js';
export * from './apps-limits.js';
export * from './apps-tier.js';
export * from './builds.js';
export * from './ever-id.js';
export * from './tenant-postgres-ddl.js';
export * from './work-app-spec.dto.js';
export * from './app-provisioning.js';
export * from './app-provisioning-copy.js';
