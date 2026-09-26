import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ENTITIES } from '@ever-works/agent/database';
import { AppEnvResolver, AppEnvService } from '@ever-works/agent/app-env';
import {
    AppBuildPrepareRunner,
    AppBuildsService,
    AppBuildWatchRunner,
} from '@ever-works/agent/app-builds';
import { AppBuildSweepCronService } from './app-build-sweep-cron.service';
import { AppBuildsModule } from './app-builds.module';

/**
 * APW-05 — the Builds graph exactly as the API composes it, against a REAL Nest
 * container and a real (in-memory sqlite) DataSource.
 *
 * ## Why this spec exists
 *
 * `AppBuildsService` takes `APP_ENV_RESOLVER_FINGERPRINTS` `@Optional()`, and
 * `readCurrentInputs` answers `null` when it is absent — which §5.1's verdict
 * (`deployable-verdict.ts`) reads as `staleInputs`. The only provider of that
 * token is APW-07's `AppEnvModule`, which is not `@Global()`; and Nest resolves a
 * provider's dependencies in the module that DECLARES it, so whether the token
 * reaches the service depends on the agent `AppBuildsModule`'s own imports and on
 * the `@Global()` modules — never on a sibling module the API happens to import
 * beside it. Until 2026-09-26 nothing in `apps/api` or `packages/tasks` imported
 * `AppEnvModule` (or `AppRuntimeEnvModule`) at all, so in the running API every
 * App Build was `staleInputs` and none could ever be deployable. Every unit spec
 * passed, because each constructs its subject by hand.
 *
 * The same gap had two more victims in the same module, found by the same
 * container: `AppBuildPrepareRunner` injects `AppEnvResolver` by class (unbound ⇒
 * every secret-syncing prepare answers `buildValuesUnavailable`), and
 * `AppBuildWatchRunner` injects `AppEnvService` by class (unbound ⇒ no redactor ⇒
 * every observation is skipped `redactorUnavailable` rather than stored
 * unredacted). All three are asserted below.
 *
 * ## What is real and what is not
 *
 * Real: this module (`apps/api`'s wrapper), the agent `AppBuildsModule` it
 * imports, and everything that module imports. Stood in: only the external
 * infrastructure the API root provides — the DataSource (sqlite instead of
 * Postgres), and the two `forRoot()` modules the API root registers that this
 * graph touches (`EventEmitterModule` for the service's emitter, `ScheduleModule`
 * for the cron). `TriggerInternalModule` imports the same static agent module, so
 * Nest builds ONE instance of it for both doors and this graph is that instance.
 */

/** A uuid that exists in no database: a Work with no env rows and no App spec. */
const WORK_ID = '00000000-0000-4000-8000-0000000000fd';

/** The private collaborators this spec reads, named as the classes declare them. */
type WithFingerprints = {
    fingerprints?: unknown;
    readCurrentInputs(
        workId: string,
    ): Promise<readonly { name: string; fingerprint: string }[] | null>;
};
type WithEnv = { env?: unknown };

describe('AppBuildsModule (apps/api) — the Builds graph as the API composes it', () => {
    let moduleRef: TestingModule;

    beforeAll(async () => {
        moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                    logging: false,
                }),
                EventEmitterModule.forRoot(),
                ScheduleModule.forRoot(),
                AppBuildsModule,
            ],
        }).compile();
    });

    afterAll(async () => {
        await moduleRef?.close();
    });

    it('composes: the API cron and the agent services it reaches', () => {
        expect(moduleRef.get(AppBuildSweepCronService)).toBeInstanceOf(AppBuildSweepCronService);
        expect(moduleRef.get(AppBuildsService, { strict: false })).toBeInstanceOf(AppBuildsService);
    });

    it("hands AppBuildsService APW-07's resolver as its fingerprints collaborator", () => {
        const service = moduleRef.get(AppBuildsService, {
            strict: false,
        }) as unknown as WithFingerprints;

        // Absent, `readCurrentInputs` answers `null` and every Build is `staleInputs`.
        expect(service.fingerprints).toBeDefined();
        expect(service.fingerprints).toBeInstanceOf(AppEnvResolver);
    });

    it('answers the empty list — a REAL answer — for a Work with no env, not null (staleInputs)', async () => {
        const service = moduleRef.get(AppBuildsService, {
            strict: false,
        }) as unknown as WithFingerprints;

        // `deployable-verdict.ts` hashes `[]` and compares it with the Build's own
        // `buildInputsHash`; `null` never passes that clause.
        await expect(service.readCurrentInputs(WORK_ID)).resolves.toEqual([]);
    });

    it('hands the prepare runner the same resolver', () => {
        const service = moduleRef.get(AppBuildsService, {
            strict: false,
        }) as unknown as WithFingerprints;
        const prepare = moduleRef.get(AppBuildPrepareRunner, {
            strict: false,
        }) as unknown as WithEnv;

        // Unbound, a secret-syncing prepare answers `buildValuesUnavailable`.
        expect(prepare.env).toBeInstanceOf(AppEnvResolver);
        // One resolver for the whole graph, not a second instance per consumer.
        expect(prepare.env).toBe(service.fingerprints);
    });

    it('hands the watch runner the env service, so it has a redactor', () => {
        const watch = moduleRef.get(AppBuildWatchRunner, { strict: false }) as unknown as WithEnv;

        // Unbound, the watch has no redactor and skips every observation
        // `redactorUnavailable` rather than store an unredacted excerpt.
        expect(watch.env).toBeInstanceOf(AppEnvService);
    });
});
