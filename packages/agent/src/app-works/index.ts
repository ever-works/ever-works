/**
 * Public API of App Works (APW-02 plan §3.1:261-263) — imported as
 * `@ever-works/agent/app-works`.
 *
 * The barrel starts with the one thing this package exports today and grows
 * additively as the epic's P1.3 services land (T16–T39): each of them adds its
 * own `export *` line here, so an importer never has to reach into a deep path
 * (`@ever-works/agent/app-works/app-upstream-sync.service`). Nothing is
 * re-exported speculatively — a name that does not exist yet must not appear,
 * or `apps/api` and `packages/tasks` would compile against a module that does
 * not resolve.
 *
 * - `./app-works.module` — `AppWorksModule`, what `apps/api`'s App Works module
 *   imports: `TypeOrmModule.forFeature([WorkUpstreamState])` plus
 *   `WorkUpstreamStateRepository` (the fourth registration point of the entity,
 *   plan §3.1).
 */

export * from './app-works.module';
