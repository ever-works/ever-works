/**
 * Public API of the App Launcher (APW-11 plan §2.2:135-144).
 *
 * Imported as `@ever-works/agent/app-launcher`:
 *
 * - `./app-launcher.service` — `AppLauncherService` (the registry read and the
 *   arrangement save) plus the two `@Optional()` seams this epic consumes and
 *   does not own (APW-06's runtime-state reader, APW-03's display-name reader);
 * - `./app-launcher.errors` — `AppLauncherPinLimitError`, the `422 { code:
 *   'pinLimit', limit }` refusal of FR-25;
 * - `./managed-host-root.resolver` — `ManagedHostRootResolver` and
 *   `AppPublishedHostsPort`, their DI tokens and the default managed-root binding;
 * - `./launcher-address` and `./launcher-order` — the two pure modules, exported
 *   so the API's controller and the web's server action can reuse the same
 *   address model and the same section reorder helper instead of restating them;
 * - `./launcher-filter` — FR-63's one text fold and its substring match, so a
 *   caller that narrows a list itself folds it exactly as the registry does;
 * - `./app-launcher.module` — `AppLauncherModule`, what `apps/api` imports.
 */

export * from './app-launcher.errors';
export * from './app-launcher.service';
export * from './launcher-address';
export * from './launcher-filter';
export * from './launcher-order';
export * from './managed-host-root.resolver';
export * from './app-launcher.module';
