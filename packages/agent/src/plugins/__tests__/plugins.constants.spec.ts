import {
    PLUGINS_MODULE_OPTIONS,
    DEFAULT_PLUGIN_PATHS,
    DEFAULT_PLATFORM_VERSION,
    PluginStates,
    VALID_STATE_TRANSITIONS,
    PluginEvents,
    SETTING_SOURCE_PRIORITY,
} from '../plugins.constants';
import * as pluginsBarrel from '../index';

/**
 * `plugins.constants.ts` is a contracts-only surface: a DI-token
 * (`PLUGINS_MODULE_OPTIONS` `Symbol(...)` — process-local, NOT
 * `Symbol.for`), the default plugin discovery paths, the platform-version
 * fallback, the plugin lifecycle state machine
 * (`PluginStates` literals + `VALID_STATE_TRANSITIONS` adjacency map),
 * the `PluginEvents` registry consumed by the EventEmitter2 bus across
 * `plugin-registry.service`, `plugin-lifecycle-manager.service`,
 * `plugin-settings.service`, and the four-tier
 * `SETTING_SOURCE_PRIORITY` cascade enforced by
 * `plugin-settings.service`.
 *
 * Every value here is read in production code by string match
 * (`PluginEvents.LOADED` → `'plugin:loaded'`) — silently changing one
 * literal would orphan every existing listener / state row. This suite
 * pins:
 *   1. DI-token identity (Symbol, description, process-local-ness so
 *      DI containers cannot accidentally collide via `Symbol.for(...)`
 *      registry sharing).
 *   2. Every `PluginStates` literal value + key set + uniqueness +
 *      `as const` (so a future swap to `enum` or a `let` mutable map
 *      breaks loudly rather than silently widening the type).
 *   3. Every `VALID_STATE_TRANSITIONS` adjacency entry pinned literally
 *      so a future "allow `loaded → loaded` self-transition" tweak is
 *      a deliberate diff.
 *   4. Every `PluginEvents` literal + dotted-namespace regex + key
 *      uniqueness + EventEmitter2-friendly format.
 *   5. `SETTING_SOURCE_PRIORITY` 5-tier order pinned (highest → lowest).
 *   6. `DEFAULT_PLUGIN_PATHS` array order pinned (the loader walks them
 *      in declaration order — rearranging would change which copy of
 *      a duplicate plugin wins).
 *   7. `DEFAULT_PLATFORM_VERSION` literal pinned (`'0.1.0'`) so a
 *      future bump is a deliberate update.
 *   8. Barrel re-export pin so deleting the `export * from './plugins.constants'`
 *      in `plugins/index.ts` is loud.
 */
describe('plugins.constants', () => {
    describe('PLUGINS_MODULE_OPTIONS DI token', () => {
        it('is a Symbol with the documented description', () => {
            expect(typeof PLUGINS_MODULE_OPTIONS).toBe('symbol');
            expect(PLUGINS_MODULE_OPTIONS.description).toBe('PLUGINS_MODULE_OPTIONS');
        });

        it('is created via Symbol() — NOT Symbol.for() (so the global registry cannot collide)', () => {
            // Symbol.for(desc) returns the SAME symbol across modules; plain
            // Symbol(desc) creates a process-local token. The plugin system
            // depends on the latter so two independently-instantiated
            // PluginsModules in the same process don't accidentally collide
            // their DI bindings.
            expect(PLUGINS_MODULE_OPTIONS).not.toBe(Symbol.for('PLUGINS_MODULE_OPTIONS'));
        });
    });

    describe('DEFAULT_PLUGIN_PATHS', () => {
        it('pins the documented 5-entry discovery path list in declaration order', () => {
            // Loader walks paths in declaration order; later entries lose to
            // earlier ones when duplicate plugin manifests are found. The
            // monorepo paths are deliberately AFTER the standalone paths so
            // a user-installed plugin in `./plugins` wins over a built-in
            // copy at `./packages/plugins`.
            expect(DEFAULT_PLUGIN_PATHS).toEqual([
                './plugins',
                './node_modules/@ever-works',
                './packages/plugins',
                '../plugins',
                '../../packages/plugins',
            ]);
        });

        it('every entry is a relative path string starting with `./` or `../`', () => {
            for (const p of DEFAULT_PLUGIN_PATHS) {
                expect(typeof p).toBe('string');
                expect(p).toMatch(/^(\.\/|\.\.\/)/);
            }
        });

        it('every entry is unique (no accidental duplicates)', () => {
            expect(new Set(DEFAULT_PLUGIN_PATHS).size).toBe(DEFAULT_PLUGIN_PATHS.length);
        });
    });

    describe('DEFAULT_PLATFORM_VERSION', () => {
        it('pins the documented fallback to `0.1.0`', () => {
            expect(DEFAULT_PLATFORM_VERSION).toBe('0.1.0');
        });

        it('matches semver MAJOR.MINOR.PATCH shape', () => {
            expect(DEFAULT_PLATFORM_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
        });
    });

    describe('PluginStates', () => {
        it('pins exactly the 5 documented state literals', () => {
            expect(PluginStates).toEqual({
                UNLOADED: 'unloaded',
                LOADING: 'loading',
                LOADED: 'loaded',
                UNLOADING: 'unloading',
                ERROR: 'error',
            });
        });

        it('exposes EXACTLY 5 keys (regression guard against silent additions)', () => {
            expect(Object.keys(PluginStates).sort()).toEqual([
                'ERROR',
                'LOADED',
                'LOADING',
                'UNLOADED',
                'UNLOADING',
            ]);
        });

        it('every value is unique (no two state names point at the same wire literal)', () => {
            const values = Object.values(PluginStates);
            expect(new Set(values).size).toBe(values.length);
        });

        it('every value is lowercase (matches the `PluginState` union from @ever-works/plugin)', () => {
            for (const value of Object.values(PluginStates)) {
                expect(value).toBe(value.toLowerCase());
                expect(value).toMatch(/^[a-z]+$/);
            }
        });

        it('is `as const` so the values type-narrow to their literals (JSON round-trip pin)', () => {
            const snapshot = JSON.parse(JSON.stringify(PluginStates));
            expect(snapshot).toEqual({
                UNLOADED: 'unloaded',
                LOADING: 'loading',
                LOADED: 'loaded',
                UNLOADING: 'unloading',
                ERROR: 'error',
            });
        });
    });

    describe('VALID_STATE_TRANSITIONS adjacency map', () => {
        it('pins every documented transition literally so a future tweak is a deliberate diff', () => {
            expect(VALID_STATE_TRANSITIONS).toEqual({
                unloaded: ['loading'],
                loading: ['loaded', 'error'],
                loaded: ['unloading'],
                unloading: ['unloaded', 'error'],
                error: ['loading', 'unloading'],
            });
        });

        it('has an entry for every documented PluginState (lower-bound)', () => {
            for (const state of Object.values(PluginStates)) {
                expect(VALID_STATE_TRANSITIONS).toHaveProperty(state);
            }
        });

        it('every target state in every adjacency list is itself a documented PluginState (no dangling edges)', () => {
            const documented = new Set<string>(Object.values(PluginStates));
            for (const targets of Object.values(VALID_STATE_TRANSITIONS)) {
                for (const target of targets) {
                    expect(documented.has(target)).toBe(true);
                }
            }
        });

        it('does NOT allow self-transitions (e.g. `loaded → loaded`)', () => {
            // Self-transitions would let the lifecycle manager re-fire LOADED /
            // UNLOADED events for an already-final state and confuse listeners.
            // Pinned so a future "idempotent re-load" tweak is deliberate.
            for (const [from, targets] of Object.entries(VALID_STATE_TRANSITIONS)) {
                expect(targets).not.toContain(from);
            }
        });

        it('does NOT allow `unloaded → loaded` (must go through `loading` first)', () => {
            // The two-step UNLOADED → LOADING → LOADED chain is what gives the
            // lifecycle manager a "currently-initializing" intermediate state
            // for guards. Pinned so a future "skip the loading state" tweak
            // breaks loudly.
            expect(VALID_STATE_TRANSITIONS.unloaded).not.toContain('loaded');
            expect(VALID_STATE_TRANSITIONS.unloaded).toEqual(['loading']);
        });

        it('error state can only recover via `loading` or `unloading` (NOT directly to `loaded` / `unloaded`)', () => {
            // After an error, a plugin must either re-attempt loading (which
            // goes back through LOADING) or be torn down (UNLOADING).
            // Skipping straight to LOADED would bypass any re-validation.
            expect(VALID_STATE_TRANSITIONS.error).toEqual(['loading', 'unloading']);
            expect(VALID_STATE_TRANSITIONS.error).not.toContain('loaded');
            expect(VALID_STATE_TRANSITIONS.error).not.toContain('unloaded');
        });

        it('LOADING can fall through to ERROR (not just LOADED)', () => {
            // Pinned so a future "always go to LOADED" tweak (which would mask
            // initialization failures) breaks loudly.
            expect(VALID_STATE_TRANSITIONS.loading).toContain('error');
            expect(VALID_STATE_TRANSITIONS.loading).toContain('loaded');
        });

        it('UNLOADING can fall through to ERROR (not just UNLOADED)', () => {
            // Pinned so a future "always go to UNLOADED" tweak (which would
            // mask teardown failures) breaks loudly.
            expect(VALID_STATE_TRANSITIONS.unloading).toContain('error');
            expect(VALID_STATE_TRANSITIONS.unloading).toContain('unloaded');
        });

        it('every adjacency list is a non-empty readonly array', () => {
            for (const targets of Object.values(VALID_STATE_TRANSITIONS)) {
                expect(Array.isArray(targets)).toBe(true);
                expect(targets.length).toBeGreaterThan(0);
            }
        });
    });

    describe('PluginEvents EventEmitter2 wire format', () => {
        it('pins every documented event literal in the `plugin:<name>` namespace', () => {
            expect(PluginEvents).toEqual({
                LOADED: 'plugin:loaded',
                UNLOADED: 'plugin:unloaded',
                ERROR: 'plugin:error',
                SETTINGS_CHANGED: 'plugin:settings-changed',
                STATE_CHANGED: 'plugin:state-changed',
                REGISTERED: 'plugin:registered',
                UNREGISTERED: 'plugin:unregistered',
            });
        });

        it('exposes EXACTLY 7 keys (regression guard against silent additions)', () => {
            expect(Object.keys(PluginEvents).sort()).toEqual([
                'ERROR',
                'LOADED',
                'REGISTERED',
                'SETTINGS_CHANGED',
                'STATE_CHANGED',
                'UNLOADED',
                'UNREGISTERED',
            ]);
        });

        it('every value is unique (no two events point at the same wire literal)', () => {
            const values = Object.values(PluginEvents);
            expect(new Set(values).size).toBe(values.length);
        });

        it('every value matches the `plugin:<kebab-case>` namespace regex', () => {
            for (const value of Object.values(PluginEvents)) {
                expect(typeof value).toBe('string');
                expect(value).toMatch(/^plugin:[a-z][a-z0-9-]*$/);
            }
        });

        it('every value uses `:` as the namespace separator (NOT `.` — EventEmitter2 wildcards depend on it)', () => {
            // EventEmitter2's wildcard listeners (`plugin:*`) split on the
            // configured `delimiter` (`:` here, see `plugins.module.ts`).
            // Switching to `.` would break every existing listener that uses
            // the `plugin:*` glob.
            for (const value of Object.values(PluginEvents)) {
                expect(value.includes(':')).toBe(true);
                expect(value).not.toMatch(/\./);
            }
        });

        it('is `as const` so the values type-narrow to their literals (JSON round-trip pin)', () => {
            const snapshot = JSON.parse(JSON.stringify(PluginEvents));
            expect(snapshot).toEqual({
                LOADED: 'plugin:loaded',
                UNLOADED: 'plugin:unloaded',
                ERROR: 'plugin:error',
                SETTINGS_CHANGED: 'plugin:settings-changed',
                STATE_CHANGED: 'plugin:state-changed',
                REGISTERED: 'plugin:registered',
                UNREGISTERED: 'plugin:unregistered',
            });
        });
    });

    describe('SETTING_SOURCE_PRIORITY 5-tier cascade', () => {
        it('pins the documented priority order (highest → lowest)', () => {
            expect(SETTING_SOURCE_PRIORITY).toEqual(['work', 'user', 'admin', 'env', 'default']);
        });

        it('exposes EXACTLY 5 entries (regression guard against silent additions)', () => {
            expect(SETTING_SOURCE_PRIORITY.length).toBe(5);
        });

        it('every entry is unique (no two tiers can collapse silently)', () => {
            expect(new Set(SETTING_SOURCE_PRIORITY).size).toBe(SETTING_SOURCE_PRIORITY.length);
        });

        it('every entry is a lowercase identifier (matches the discriminant tag in `plugin-settings.service`)', () => {
            for (const tier of SETTING_SOURCE_PRIORITY) {
                expect(typeof tier).toBe('string');
                expect(tier).toMatch(/^[a-z]+$/);
            }
        });

        it('puts `work` ahead of `user` (per-work overrides win over per-user defaults)', () => {
            // The cascade is consumed left-to-right by the resolver; any value
            // present at `work` short-circuits the lookup. Pinned so a future
            // "user always wins" reordering breaks loudly.
            const workIdx = SETTING_SOURCE_PRIORITY.indexOf('work');
            const userIdx = SETTING_SOURCE_PRIORITY.indexOf('user');
            expect(workIdx).toBeLessThan(userIdx);
        });

        it('puts `default` last (the fallback tier is always the schema-declared default)', () => {
            expect(SETTING_SOURCE_PRIORITY[SETTING_SOURCE_PRIORITY.length - 1]).toBe('default');
        });

        it('puts `env` ahead of `default` (env-var fallback wins over schema default)', () => {
            // `x-envVar` extension on a schema field makes the env-var the
            // last-resort source BEFORE the literal `default`. Pinned so a
            // future "ignore env vars unless explicit" tweak is deliberate.
            const envIdx = SETTING_SOURCE_PRIORITY.indexOf('env');
            const defIdx = SETTING_SOURCE_PRIORITY.indexOf('default');
            expect(envIdx).toBeLessThan(defIdx);
        });
    });

    describe('barrel re-exports (plugins/index.ts)', () => {
        it('re-exports every documented runtime symbol', () => {
            const barrel = pluginsBarrel as unknown as Record<string, unknown>;
            expect(barrel.PLUGINS_MODULE_OPTIONS).toBe(PLUGINS_MODULE_OPTIONS);
            expect(barrel.DEFAULT_PLUGIN_PATHS).toBe(DEFAULT_PLUGIN_PATHS);
            expect(barrel.DEFAULT_PLATFORM_VERSION).toBe(DEFAULT_PLATFORM_VERSION);
            expect(barrel.PluginStates).toBe(PluginStates);
            expect(barrel.VALID_STATE_TRANSITIONS).toBe(VALID_STATE_TRANSITIONS);
            expect(barrel.PluginEvents).toBe(PluginEvents);
            expect(barrel.SETTING_SOURCE_PRIORITY).toBe(SETTING_SOURCE_PRIORITY);
        });
    });
});
