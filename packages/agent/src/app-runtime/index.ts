/**
 * Public API of the App runtime ports (APW-06 `plan.md` §9.6, §9.8:1510–1538).
 *
 * Imported as `@ever-works/agent/app-runtime`:
 *
 * - `./ports` — the port interfaces, their DI tokens and the typed refusal error.
 * - `./default-ports` — the fail-closed defaults the platform binds until APW-05, APW-07 and APW-10
 *   replace them.
 */

export * from './ports';
export * from './default-ports';
