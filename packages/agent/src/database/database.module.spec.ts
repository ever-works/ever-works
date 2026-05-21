import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from './database.module';
import { REPOSITORY_PROVIDERS } from './_repository-inventory';
import { AGENT_ENTITY_NAMES } from './_entity-names';
import * as entitiesBarrel from '../entities';

/**
 * `DatabaseModule` is a wire-format-stable contract: every NestJS feature
 * module across `packages/agent` and `apps/api` imports it and resolves
 * exactly the documented set of TypeORM-backed repositories. Adding a
 * provider without exporting it would silently break consumers; removing
 * one would orphan downstream services. Pinning the
 * `@Module()` Reflect-metadata snapshot here makes either change a
 * deliberate, noisy diff.
 *
 * The module is also responsible for two TypeORM imports:
 *   - `ConfigModule.forFeature(databaseConfig)` so `'database'` namespace
 *     config is injectable, and
 *   - `TypeOrmModule.forRootAsync(...)` plus `TypeOrmModule.forFeature(ENTITIES)`
 *     so the connection + per-entity repositories are bound.
 *
 * The async useFactory simply pulls `'database'` from `ConfigService` and
 * forwards it as the TypeORM connection options — covered separately in
 * `database-config.factory.spec.ts` / `database.config.spec.ts`. This
 * suite restricts itself to the static `@Module()` decorator metadata
 * (`imports` shape, providers list, exports list) so the surface is
 * pinned regardless of the runtime DataSource.
 *
 * EW-638 — the inventory of repository providers used to live duplicated
 * here. It now lives in `_repository-inventory.ts` so a new repository
 * is a single deliberate edit in one place. This suite asserts the
 * module's wiring matches the inventory.
 */
describe('DatabaseModule decorator metadata', () => {
    function getMeta(key: 'imports' | 'providers' | 'exports'): unknown[] {
        return (Reflect.getMetadata(key, DatabaseModule) ?? []) as unknown[];
    }

    describe('@Module() providers', () => {
        it('declares every documented repository provider (sourced from `_repository-inventory.ts`)', () => {
            const providers = getMeta('providers');
            for (const repo of REPOSITORY_PROVIDERS) {
                expect(providers).toContain(repo);
            }
        });

        it('declares EXACTLY as many providers as the inventory lists (regression guard against silent additions)', () => {
            const providers = getMeta('providers');
            expect(providers.length).toBe(REPOSITORY_PROVIDERS.length);
        });

        it('every provider is a class constructor (function with prototype) — pinned so a future `useClass`/`useFactory` swap is deliberate', () => {
            const providers = getMeta('providers');
            for (const provider of providers) {
                expect(typeof provider).toBe('function');
                expect((provider as { prototype?: unknown }).prototype).toBeDefined();
            }
        });

        it('does NOT include the DataSource / EntityManager directly — only repository wrappers', () => {
            // The intent is for consumers to depend on the typed repository
            // wrappers (which encapsulate query-builder usage), NOT the raw
            // DataSource. Pinned so a future "leak the DataSource" tweak
            // is a deliberate downgrade.
            const providers = getMeta('providers');
            const providerNames = providers.map((p) => (p as { name?: string })?.name ?? String(p));
            expect(providerNames).not.toContain('DataSource');
            expect(providerNames).not.toContain('EntityManager');
        });
    });

    describe('@Module() exports', () => {
        it('exports `TypeOrmModule` so consumers can resolve `getRepositoryToken(...)` directly when needed', () => {
            // Re-exporting `TypeOrmModule` from `forFeature(ENTITIES)` is
            // what lets downstream feature modules (e.g. `WorkModule`)
            // `@InjectRepository(Work)` even though the binding lives in
            // this module's scope.
            const exports = getMeta('exports');
            expect(exports).toContain(TypeOrmModule);
        });

        it('exports every documented repository (so consumers can `@Inject` the wrapper)', () => {
            const exports = getMeta('exports');
            for (const repo of REPOSITORY_PROVIDERS) {
                expect(exports).toContain(repo);
            }
        });

        it('exports the inventory count + 1 (TypeOrmModule) symbols — regression guard', () => {
            // Pinned so a future "stop exporting WorkRepository" tweak (which
            // would orphan every consumer) breaks loudly. The count tracks
            // `_repository-inventory.ts` automatically.
            const exports = getMeta('exports');
            expect(exports.length).toBe(REPOSITORY_PROVIDERS.length + 1);
        });

        it('exports list is exactly the providers list + TypeOrmModule (no provider held back from consumers)', () => {
            // This pins a property of the design: every repository is
            // exported. If we ever want to add a "private helper" repository
            // that's NOT exported, it has to be a deliberate change to this
            // assertion.
            const providers = getMeta('providers');
            const exports = getMeta('exports');
            const exportSet = new Set(exports);
            for (const provider of providers) {
                expect(exportSet.has(provider)).toBe(true);
            }
        });
    });

    describe('@Module() imports', () => {
        it('includes TWO TypeOrmModule entries — one `forRootAsync` (DB connection) and one `forFeature` (per-entity repositories)', () => {
            // Both `forRootAsync` and `forFeature` return DynamicModule
            // descriptors with `module: TypeOrmModule`. We can only count
            // them by iterating `imports`. Pinned so a future "merge into a
            // single forFeatureAsync" refactor is a deliberate diff.
            const imports = getMeta('imports');
            const typeormImports = imports.filter((m) => {
                const desc = m as { module?: unknown };
                return desc?.module === TypeOrmModule;
            });
            expect(typeormImports.length).toBe(2);
        });

        it('includes a `ConfigModule.forFeature(databaseConfig)` entry exposing the `database` namespace', () => {
            const imports = getMeta('imports');
            const configImports = imports.filter((m) => {
                const desc = m as { module?: unknown };
                return desc?.module === ConfigModule;
            });
            // `forFeature(databaseConfig)` returns a DynamicModule with
            // `module: ConfigModule`. Pinned so a future "drop the
            // forFeature scoping in favour of forRoot only" tweak breaks
            // loudly (the `config.get('database')` binding depends on this
            // forFeature call).
            expect(configImports.length).toBe(1);
        });

        it('declares EXACTLY 3 imports (1 ConfigModule.forFeature + 2 TypeOrmModule entries) — regression guard', () => {
            const imports = getMeta('imports');
            expect(imports.length).toBe(3);
        });

        it('the async TypeOrm DynamicModule wraps a single ConfigModule import so the inner factory can resolve ConfigService', () => {
            // `TypeOrmModule.forRootAsync({ imports: [ConfigModule], useFactory, inject })`
            // returns a DynamicModule shaped like
            // `{ module: TypeOrmModule, imports: [ConfigModule] }` at the
            // outer level — the actual `useFactory` is buried inside an
            // inner DynamicModule that NestJS' TypeOrmModule constructs
            // internally. We pin the OUTER shape (1 wrapped import) so a
            // future "drop the imports forwarding" tweak is a deliberate
            // diff (without it, the inner factory cannot resolve
            // ConfigService).
            const imports = getMeta('imports');
            const typeormImports = imports.filter((m) => {
                const desc = m as { module?: unknown };
                return desc?.module === TypeOrmModule;
            }) as Array<{ module: unknown; imports?: unknown[] }>;

            // Of the two TypeOrmModule entries, exactly one is the async
            // (forRootAsync) one — it carries a non-empty `imports` array
            // (the ConfigModule forwarding). The other is `forFeature`
            // which has providers/exports but no `imports` key.
            const asyncEntries = typeormImports.filter((m) => Array.isArray(m.imports));
            expect(asyncEntries.length).toBe(1);
            expect(asyncEntries[0].imports!.length).toBe(1);
        });

        it('the per-entity `forFeature` DynamicModule binds providers + exports (the per-entity repositories)', () => {
            // Pinned so a future "stop calling forFeature" tweak (which
            // would orphan every `@InjectRepository(...)` consumer) is a
            // deliberate diff.
            const imports = getMeta('imports');
            const typeormImports = imports.filter((m) => {
                const desc = m as { module?: unknown };
                return desc?.module === TypeOrmModule;
            }) as Array<{ module: unknown; providers?: unknown[]; exports?: unknown[] }>;

            const forFeatureEntries = typeormImports.filter(
                (m) => Array.isArray(m.providers) && Array.isArray(m.exports),
            );
            expect(forFeatureEntries.length).toBe(1);
            // `forFeature(ENTITIES)` provides one repository token per
            // entity. The exact entity count is owned by `database.config`
            // (covered in `database.config.spec.ts`); we only pin that the
            // forFeature call binds at least 1 entity (defence against a
            // future "empty forFeature call" no-op).
            expect(forFeatureEntries[0].providers!.length).toBeGreaterThan(0);
            expect(forFeatureEntries[0].exports!.length).toBeGreaterThan(0);
        });
    });

    describe('class identity', () => {
        it('DatabaseModule is a class function (so DI-resolution by class identity works)', () => {
            expect(typeof DatabaseModule).toBe('function');
            expect(DatabaseModule.prototype).toBeDefined();
        });

        it('exports the class under the documented name (so a string-based registry would still find it)', () => {
            expect(DatabaseModule.name).toBe('DatabaseModule');
        });
    });

    /**
     * EW-638 drift detection — `_entity-names.ts` MUST list exactly the
     * entity classes that the real `../entities` barrel exposes. If a new
     * entity ships without updating `_entity-names.ts`, the mock barrel
     * in `database.config.spec.ts` will be missing an entry and that
     * spec will fail with "every entry is a function" → "undefined".
     *
     * We catch the drift here instead, where the failure message is
     * actionable ("entity X is in the real barrel but missing from
     * `_entity-names.ts` — add it") rather than the cryptic mock-shadow
     * "undefined" error.
     */
    describe('entity-names inventory drift (EW-638)', () => {
        const realEntityNames = Object.keys(entitiesBarrel)
            .filter((name) => {
                const value = (entitiesBarrel as Record<string, unknown>)[name];
                // Entity classes are the only `function`-typed exports
                // the barrel emits. Interface/type exports erase at
                // runtime, and TypeScript enums + `const`-tuple arrays
                // become plain `object`-typed values — so a single
                // `typeof === 'function'` + PascalCase check is enough
                // to isolate entity classes without false positives.
                // (Entity NAMES are allowed to end in "Repository", e.g.
                // `GitHubAppInstallationRepository`, which models the
                // GitHub repo that an installation is granted access to;
                // a stricter suffix filter would wrongly strip it.)
                return typeof value === 'function' && /^[A-Z]/.test(name);
            })
            .sort();

        const inventoryNames = [...AGENT_ENTITY_NAMES].sort();

        it('every name in `_entity-names.ts` corresponds to a real export in `../entities`', () => {
            const missingFromReal = inventoryNames.filter((n) => !realEntityNames.includes(n));
            expect(missingFromReal).toEqual([]);
        });

        it('every entity class exported by `../entities` is listed in `_entity-names.ts`', () => {
            const missingFromInventory = realEntityNames.filter((n) => !inventoryNames.includes(n));
            expect(missingFromInventory).toEqual([]);
        });
    });
});
