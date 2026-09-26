import { DataSource, Repository } from 'typeorm';
import {
    APP_BUILD_LIST_MAX_PAGE_SIZE,
    APP_BUILD_LIST_PAGE_SIZE,
    APP_BUILD_POLL_AFTER_SILENCE_MS,
    APP_BUILD_SWEEP_BATCH,
} from '@ever-works/contracts';
import { WorkBuild } from '../../../entities/work-build.entity';
import { WorkBuildPreparation } from '../../../entities/work-build-preparation.entity';
import { Work } from '../../../entities/work.entity';
import { ENTITIES } from '../../_entities-inventory';
import {
    APP_BUILD_NUMBER_RETRIES,
    APP_BUILD_OPEN_STATUSES,
    APP_BUILD_ORPHANED_VERIFY_SECRET_MS,
    APP_BUILD_REQUESTED_TRIGGERS,
    AppBuildRepository,
} from '../app-build.repository';

/**
 * APW-05 T6 — the `work_builds` repository, executed against a real (in-memory
 * better-sqlite3) database rather than a mocked repository: the Work-row lock's
 * options, the transaction that assigns `number`, the epoch-`bigint`
 * comparisons, the `CASE` that makes "never observed" the stalest row and the
 * UNIQUE index behind the run identity are the ones production runs.
 *
 * better-sqlite3 is the default `DATABASE_TYPE` (every local and self-hosted
 * install) and the driver CI and the e2e lane use, so a rule that only holds
 * under a pooled driver is not a rule that holds.
 *
 * 🛑 **What this driver cannot reach, and is therefore asserted rather than
 * executed**: the `pessimistic_write` branch. SQLite has no row locks and the
 * repository deliberately skips the lock there, so `lockWorkRow` is exercised
 * against a recording manager in the last describe block — the option is the
 * only thing a SQLite-backed test can observe, exactly as
 * `credit-ledger.repository`'s regression test records for the same reason. The
 * PostgreSQL leg is NOT run here: no container is available in this environment
 * (see the report's cross-driver section).
 *
 * Spec FR-17, FR-34, FR-41, FR-42; plan §3.1 (`plan.md:381-396`), §7.3
 * (`:1384-1397`) and §7.4 (`:1399-1406`). Every uuid below is obviously
 * synthetic.
 */

const WORK_A = '11111111-1111-4111-8111-111111111111';
const WORK_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** A fixed "now" so every window is exact, never wall-clock flaky. */
const NOW = Date.parse('2026-03-01T06:00:00.000Z');
const MINUTE = 60_000;
const SECOND = 1_000;

describe('AppBuildRepository', () => {
    let dataSource: DataSource;
    let repository: AppBuildRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        repository = new AppBuildRepository(dataSource.getRepository(WorkBuild));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        // The owning Work row is not what is under test for most cases; the FK
        // itself (and its cascade) is asserted in
        // `apps/api/.../CreateWorkBuilds.spec.ts`.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        await dataSource.getRepository(WorkBuild).clear();
        await dataSource.getRepository(WorkBuildPreparation).clear();
        await dataSource.query('DELETE FROM "works"');
    });

    /** The four Work columns that carry no default (`work.entity.ts:166-274`). */
    function seedWork(workId: string, userId = USER_A, organizationId: string | null = null) {
        return dataSource.query(
            `INSERT INTO "works" ("id", "name", "slug", "userId", "description", "kind", "organizationId")
             VALUES ('${workId}', 'App Work ${workId.slice(0, 4)}', 'app-${workId.slice(0, 4)}', '${userId}', '', 'app', ${organizationId ? `'${organizationId}'` : 'NULL'})`,
        );
    }

    /** Insert a Build directly, so a test can start from any stored state. */
    function seedBuild(
        overrides: Partial<WorkBuild> & { readonly workId: string; readonly number: number },
    ): Promise<WorkBuild> {
        const rows = dataSource.getRepository(WorkBuild);
        return rows.save(
            rows.create({
                buildPluginId: 'github-actions',
                status: 'queued',
                trigger: 'push',
                branch: 'main',
                commitSha: SHA_A,
                ...overrides,
            }),
        );
    }

    /** Re-read a row from the database, never from the object a method returned. */
    async function stored(id: string): Promise<WorkBuild> {
        return dataSource.getRepository(WorkBuild).findOneOrFail({ where: { id } });
    }

    async function count(): Promise<number> {
        return dataSource.getRepository(WorkBuild).count();
    }

    const insert = (
        overrides: Partial<Parameters<AppBuildRepository['insertWithNextNumber']>[1]> = {},
    ): Parameters<AppBuildRepository['insertWithNextNumber']>[1] => ({
        buildPluginId: 'github-actions',
        status: 'queued',
        trigger: 'push',
        branch: 'main',
        commitSha: SHA_A,
        ...overrides,
    });

    describe('insertWithNextNumber', () => {
        beforeEach(async () => {
            await seedWork(WORK_A);
            await seedWork(WORK_B);
        });

        it('numbers the first Build of a Work 1 and the next one 2', async () => {
            const first = await repository.insertWithNextNumber(WORK_A, insert());
            const second = await repository.insertWithNextNumber(WORK_A, insert());

            expect(first.number).toBe(1);
            expect(second.number).toBe(2);
        });

        it('numbers each App Work independently', async () => {
            await repository.insertWithNextNumber(WORK_A, insert());
            const other = await repository.insertWithNextNumber(WORK_B, insert());

            expect(other.number).toBe(1);
        });

        it('yields 1…20 for 20 concurrent inserts, with no gap and no duplicate', async () => {
            // T6's own case. On this driver the queue in
            // `serializeOnSingleConnection` is what makes it hold; on a pooled
            // driver it is the Work-row lock plus the retry.
            const inserted = await Promise.all(
                Array.from({ length: 20 }, () => repository.insertWithNextNumber(WORK_A, insert())),
            );

            const numbers = inserted.map((build) => build.number).sort((a, b) => a - b);
            expect(numbers).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
            expect(await count()).toBe(20);
            expect(new Set(numbers).size).toBe(20);
        });

        it('writes the caller’s columns and leaves the rest NULL', async () => {
            const created = await repository.insertWithNextNumber(
                WORK_A,
                insert({ pullRequestNumber: 7, runnerClass: 'github-private', branch: 'feat/x' }),
            );

            const row = await stored(created.id);
            expect(row.pullRequestNumber).toBe(7);
            expect(row.runnerClass).toBe('github-private');
            expect(row.branch).toBe('feat/x');
            // The plan's own defaults, applied by the database.
            expect(row.runAttempt).toBe(1);
            expect(row.syncOrigin).toBe('none');
            expect(row.deployable).toBe(false);
            expect(row.digestConfirmed).toBe(false);
            expect(row.secretsSyncedAt).toBeNull();
        });

        it('refuses a Build for a Work that does not exist (the FK is real)', async () => {
            // The suite runs with the FK off so a test can seed any state; this
            // case is about the FK itself, so it is the one that turns it on.
            await dataSource.query('PRAGMA foreign_keys = ON');

            try {
                await expect(
                    repository.insertWithNextNumber(
                        '99999999-9999-4999-8999-999999999999',
                        insert(),
                    ),
                ).rejects.toThrow();
            } finally {
                await dataSource.query('PRAGMA foreign_keys = OFF');
            }
        });

        describe('stampFromPreparation (APW05-G03)', () => {
            const SYNCED_AT = new Date(NOW - 5 * MINUTE);

            beforeEach(async () => {
                const rows = dataSource.getRepository(WorkBuildPreparation);
                await rows.save(
                    rows.create({
                        workId: WORK_A,
                        buildPluginId: 'github-actions',
                        buildInputsHash: 'c'.repeat(64),
                        buildSecretNames: ['EW_DATABASE_URL', 'EW_STRIPE_KEY'],
                        secretsSyncedAt: SYNCED_AT,
                    }),
                );
            });

            it('copies the three columns from the preparation row of the same Work', async () => {
                const created = await repository.insertWithNextNumber(WORK_A, insert(), {
                    stampFromPreparation: true,
                });

                const row = await stored(created.id);
                expect(row.buildInputsHash).toBe('c'.repeat(64));
                expect(row.buildSecretNames).toEqual(['EW_DATABASE_URL', 'EW_STRIPE_KEY']);
                expect(row.secretsSyncedAt?.getTime()).toBe(SYNCED_AT.getTime());
            });

            it('leaves all three NULL when the Work has no preparation row', async () => {
                const created = await repository.insertWithNextNumber(WORK_B, insert(), {
                    stampFromPreparation: true,
                });

                const row = await stored(created.id);
                // NULL — not an empty hash — is what §5.1 reads as staleInputs.
                expect(row.buildInputsHash).toBeNull();
                expect(row.buildSecretNames).toBeNull();
                expect(row.secretsSyncedAt).toBeNull();
            });

            it('leaves all three NULL when the caller does not ask for the stamp', async () => {
                // The flag is what makes the preparation row authoritative: a
                // manual or verification Build must NOT inherit the sync of a
                // push run.
                const created = await repository.insertWithNextNumber(WORK_A, insert());

                const row = await stored(created.id);
                expect(row.buildInputsHash).toBeNull();
                expect(row.buildSecretNames).toBeNull();
                expect(row.secretsSyncedAt).toBeNull();
            });

            it('does not let a preparation row without a sync fabricate one', async () => {
                const rows = dataSource.getRepository(WorkBuildPreparation);
                await rows.update(
                    { workId: WORK_A },
                    { buildInputsHash: null, secretsSyncedAt: null },
                );

                const created = await repository.insertWithNextNumber(WORK_A, insert(), {
                    stampFromPreparation: true,
                });

                const row = await stored(created.id);
                expect(row.buildInputsHash).toBeNull();
                expect(row.secretsSyncedAt).toBeNull();
            });
        });
    });

    describe('upsertByProviderRun', () => {
        beforeEach(async () => {
            await seedWork(WORK_A);
        });

        const run = (
            overrides: Partial<Parameters<AppBuildRepository['upsertByProviderRun']>[1]> = {},
        ): Parameters<AppBuildRepository['upsertByProviderRun']>[1] => ({
            ...insert(),
            providerRunId: 'run-1',
            ...overrides,
        });

        it('creates on the first delivery, numbered from 1', async () => {
            const result = await repository.upsertByProviderRun(WORK_A, run());

            expect(result.created).toBe(true);
            expect(result.build.number).toBe(1);
            expect(await count()).toBe(1);
        });

        it('updates on a duplicate delivery, so the two intake paths converge on one row', async () => {
            await repository.upsertByProviderRun(WORK_A, run({ status: 'queued' }));

            const second = await repository.upsertByProviderRun(
                WORK_A,
                run({ status: 'running', runnerLabel: 'ubuntu-latest' }),
            );

            expect(second.created).toBe(false);
            expect(await count()).toBe(1);
            const row = await stored(second.build.id);
            expect(row.status).toBe('running');
            expect(row.runnerLabel).toBe('ubuntu-latest');
            expect(row.number).toBe(1);
        });

        it('treats a different attempt as a different Build', async () => {
            await repository.upsertByProviderRun(WORK_A, run());

            const attempt2 = await repository.upsertByProviderRun(WORK_A, run({ runAttempt: 2 }));

            expect(attempt2.created).toBe(true);
            expect(attempt2.build.number).toBe(2);
            expect(await count()).toBe(2);
        });

        it('treats a different plugin as a different Build', async () => {
            await repository.upsertByProviderRun(WORK_A, run());

            const other = await repository.upsertByProviderRun(
                WORK_A,
                run({ buildPluginId: 'apps-builder' }),
            );

            expect(other.created).toBe(true);
            expect(await count()).toBe(2);
        });

        it('recovers when the insert loses the race for the run identity', async () => {
            // Force the exact race the catch block exists for: the read finds
            // nothing, and the row appears before the insert lands.
            const sneaky = await repository.upsertByProviderRun(WORK_A, run());
            const insertSpy = jest.spyOn(repository, 'insertWithNextNumber').mockRejectedValueOnce(
                Object.assign(new Error('UNIQUE constraint failed: work_builds.buildPluginId'), {
                    code: 'SQLITE_CONSTRAINT_UNIQUE',
                }),
            );

            const result = await repository.upsertByProviderRun(WORK_A, run({ status: 'running' }));

            insertSpy.mockRestore();
            expect(result.created).toBe(false);
            expect(result.build.id).toBe(sneaky.build.id);
            expect(await count()).toBe(1);
        });

        it('re-throws an error that is not a unique violation', async () => {
            const insertSpy = jest
                .spyOn(repository, 'insertWithNextNumber')
                .mockRejectedValueOnce(new Error('disk I/O error'));

            await expect(repository.upsertByProviderRun(WORK_A, run())).rejects.toThrow(
                'disk I/O error',
            );
            insertSpy.mockRestore();
        });
    });

    describe('claimWatchLease (§7.3)', () => {
        beforeEach(async () => {
            await seedWork(WORK_A);
        });

        it('claims a Build nobody is watching', async () => {
            const build = await seedBuild({ workId: WORK_A, number: 1 });

            const claimed = await repository.claimWatchLease(build.id, 2 * MINUTE);

            expect(claimed).toBe(true);
            const row = await stored(build.id);
            expect(row.watchLeaseUntil).not.toBeNull();
            expect(row.watchLeaseUntil!.getTime()).toBeGreaterThan(Date.now());
        });

        it('returns false for a live lease, and leaves it exactly as it was', async () => {
            // T6's own case: "lease claim returns 0 rows for a live lease".
            const live = new Date(Date.now() + 90 * SECOND);
            const build = await seedBuild({
                workId: WORK_A,
                number: 1,
                watchLeaseUntil: live,
            });

            const claimed = await repository.claimWatchLease(build.id, 2 * MINUTE);

            expect(claimed).toBe(false);
            const row = await stored(build.id);
            expect(row.watchLeaseUntil?.getTime()).toBe(live.getTime());
        });

        it('re-claims a lease that has expired', async () => {
            const expired = new Date(Date.now() - SECOND);
            const build = await seedBuild({
                workId: WORK_A,
                number: 1,
                watchLeaseUntil: expired,
            });

            const claimed = await repository.claimWatchLease(build.id, 2 * MINUTE);

            expect(claimed).toBe(true);
            const row = await stored(build.id);
            expect(row.watchLeaseUntil!.getTime()).toBeGreaterThan(expired.getTime());
        });

        it('claims exactly one of two concurrent callers', async () => {
            const build = await seedBuild({ workId: WORK_A, number: 1 });

            const [first, second] = await Promise.all([
                repository.claimWatchLease(build.id, 2 * MINUTE),
                repository.claimWatchLease(build.id, 2 * MINUTE),
            ]);

            expect([first, second].filter(Boolean)).toHaveLength(1);
        });

        it('claims nothing for a Build that does not exist', async () => {
            await expect(
                repository.claimWatchLease('99999999-9999-4999-8999-999999999999', MINUTE),
            ).resolves.toBe(false);
        });
    });

    describe('findSilentNonTerminal (§7.4)', () => {
        beforeEach(async () => {
            await seedWork(WORK_A);
        });

        const silent = (minutes: number) => new Date(NOW - minutes * MINUTE);

        it('selects every open status the plan names, and both silence shapes', async () => {
            await seedBuild({
                workId: WORK_A,
                number: 1,
                status: 'queued',
                lastObservedAt: new Date(NOW - 91 * SECOND),
            });
            await seedBuild({
                workId: WORK_A,
                number: 2,
                status: 'running',
                lastObservedAt: silent(5),
            });
            await seedBuild({
                workId: WORK_A,
                number: 3,
                status: 'queued',
                dispatchedAt: new Date(NOW - 91 * SECOND),
            });

            const rows = await repository.findSilentNonTerminal(
                NOW,
                APP_BUILD_POLL_AFTER_SILENCE_MS,
                APP_BUILD_SWEEP_BATCH,
            );

            expect(rows.map((row) => row.number)).toEqual([3, 2, 1]);
            expect(rows.map((row) => row.status)).toEqual(['queued', 'running', 'queued']);
        });

        it('honours the 90 s silence on both halves — 89 s is not silent, 91 s is', async () => {
            const fresh = await seedBuild({
                workId: WORK_A,
                number: 1,
                lastObservedAt: new Date(NOW - 89 * SECOND),
            });
            const stale = await seedBuild({
                workId: WORK_A,
                number: 2,
                lastObservedAt: new Date(NOW - 91 * SECOND),
            });
            const freshDispatch = await seedBuild({
                workId: WORK_A,
                number: 3,
                dispatchedAt: new Date(NOW - 89 * SECOND),
            });
            const staleDispatch = await seedBuild({
                workId: WORK_A,
                number: 4,
                dispatchedAt: new Date(NOW - 91 * SECOND),
            });

            const rows = await repository.findSilentNonTerminal(
                NOW,
                APP_BUILD_POLL_AFTER_SILENCE_MS,
                APP_BUILD_SWEEP_BATCH,
            );
            const ids = rows.map((row) => row.id);

            expect(ids).toContain(stale.id);
            expect(ids).toContain(staleDispatch.id);
            expect(ids).not.toContain(fresh.id);
            expect(ids).not.toContain(freshDispatch.id);
        });

        it('excludes a row exactly at the cutoff — the plan says strictly older', async () => {
            // plan.md:1401 — `lastObservedAt < now() − 90 s`.
            const boundary = await seedBuild({
                workId: WORK_A,
                number: 1,
                lastObservedAt: new Date(NOW - APP_BUILD_POLL_AFTER_SILENCE_MS),
            });

            const rows = await repository.findSilentNonTerminal(
                NOW,
                APP_BUILD_POLL_AFTER_SILENCE_MS,
                APP_BUILD_SWEEP_BATCH,
            );

            expect(rows.map((row) => row.id)).not.toContain(boundary.id);
        });

        it('never selects a terminal or blocked Build, however silent', async () => {
            for (const [index, status] of (
                ['succeeded', 'failed', 'cancelled', 'blocked'] as const
            ).entries()) {
                await seedBuild({
                    workId: WORK_A,
                    number: index + 1,
                    status,
                    lastObservedAt: silent(600),
                });
            }

            const rows = await repository.findSilentNonTerminal(NOW, 90 * SECOND, 200);

            expect(rows).toEqual([]);
        });

        it('never selects a Build that was neither dispatched nor observed', async () => {
            // Nothing has failed to report yet: the sweep must not poll a Build
            // the platform has not handed to a provider.
            const never = await seedBuild({ workId: WORK_A, number: 1 });

            const rows = await repository.findSilentNonTerminal(NOW, 90 * SECOND, 200);

            expect(rows.map((row) => row.id)).not.toContain(never.id);
        });

        it('returns the stalest 200 of 205 silent Builds, oldest first', async () => {
            // T6's own case: "the 200 limit, oldest first".
            const rows = dataSource.getRepository(WorkBuild);
            await rows.save(
                Array.from({ length: 205 }, (_, index) =>
                    rows.create({
                        workId: WORK_A,
                        number: index + 1,
                        buildPluginId: 'github-actions',
                        status: 'running' as const,
                        trigger: 'push' as const,
                        branch: 'main',
                        commitSha: SHA_A,
                        // Build #1 is the stalest; #205 the freshest.
                        lastObservedAt: new Date(NOW - (205 - index) * MINUTE),
                    }),
                ),
            );

            const page = await repository.findSilentNonTerminal(
                NOW,
                APP_BUILD_POLL_AFTER_SILENCE_MS,
                APP_BUILD_SWEEP_BATCH,
            );

            expect(page).toHaveLength(200);
            expect(page[0].number).toBe(1);
            expect(page[199].number).toBe(200);
            expect(page.map((row) => row.number)).not.toContain(201);

            // 🌟 The clamp, asserted SEPARATELY from the caller's own limit: a
            // test that passes exactly 200 cannot tell a working ceiling from a
            // missing one, which a perturbation of the ceiling proved by staying
            // green. Asking for more is what exercises it.
            const generous = await repository.findSilentNonTerminal(
                NOW,
                APP_BUILD_POLL_AFTER_SILENCE_MS,
                1_000,
            );
            expect(generous).toHaveLength(APP_BUILD_SWEEP_BATCH);
            expect(generous[0].number).toBe(1);
            expect(generous[APP_BUILD_SWEEP_BATCH - 1].number).toBe(APP_BUILD_SWEEP_BATCH);
        });

        it('clamps a caller that asks for more than the sweep batch', async () => {
            await seedBuild({
                workId: WORK_A,
                number: 1,
                lastObservedAt: silent(5),
            });

            expect(APP_BUILD_SWEEP_BATCH).toBe(200);
            const rows = await repository.findSilentNonTerminal(NOW, 90 * SECOND, 100_000);

            expect(rows.length).toBeLessThanOrEqual(APP_BUILD_SWEEP_BATCH);
        });

        it('returns nothing for a non-positive limit', async () => {
            await seedBuild({ workId: WORK_A, number: 1, lastObservedAt: silent(5) });

            expect(await repository.findSilentNonTerminal(NOW, 90 * SECOND, 0)).toEqual([]);
        });
    });

    describe('findWithOrphanedVerifySecrets (§4.10, §7.4)', () => {
        beforeEach(async () => {
            await seedWork(WORK_A);
        });

        const names = ['EW_VERIFY__PROMPTED'];

        it('selects a verification Build whose secret outlived startedAt + 30 + 10 minutes', async () => {
            const orphan = await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'verification',
                status: 'failed',
                startedAt: new Date(NOW - 41 * MINUTE),
                verifySecretNames: names,
            });

            const rows = await repository.findWithOrphanedVerifySecrets(NOW, APP_BUILD_SWEEP_BATCH);

            expect(rows.map((row) => row.id)).toEqual([orphan.id]);
        });

        it('includes a Build exactly at 40 minutes — the grace is "30 + 10 after startedAt"', async () => {
            await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'verification',
                startedAt: new Date(NOW - APP_BUILD_ORPHANED_VERIFY_SECRET_MS),
                verifySecretNames: names,
            });

            const rows = await repository.findWithOrphanedVerifySecrets(NOW, APP_BUILD_SWEEP_BATCH);

            expect(rows).toHaveLength(1);
        });

        it('leaves a Build younger than 40 minutes alone — the run may still be using it', async () => {
            const running = await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'verification',
                status: 'running',
                startedAt: new Date(NOW - 39 * MINUTE),
                verifySecretNames: names,
            });

            const rows = await repository.findWithOrphanedVerifySecrets(NOW, APP_BUILD_SWEEP_BATCH);

            expect(rows.map((row) => row.id)).not.toContain(running.id);
        });

        it('selects nothing but verification Builds', async () => {
            await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'push',
                startedAt: new Date(NOW - 120 * MINUTE),
                verifySecretNames: names,
            });
            await seedBuild({
                workId: WORK_A,
                number: 2,
                trigger: 'manual',
                startedAt: new Date(NOW - 120 * MINUTE),
                verifySecretNames: names,
            });

            expect(
                await repository.findWithOrphanedVerifySecrets(NOW, APP_BUILD_SWEEP_BATCH),
            ).toEqual([]);
        });

        it('selects only a NON-EMPTY verifySecretNames', async () => {
            await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'verification',
                startedAt: new Date(NOW - 120 * MINUTE),
                // The shape a run with no prompted values leaves: nothing to
                // delete, and not an orphan.
                verifySecretNames: [],
            });
            await seedBuild({
                workId: WORK_A,
                number: 2,
                trigger: 'verification',
                startedAt: new Date(NOW - 120 * MINUTE),
                verifySecretNames: null,
            });
            const real = await seedBuild({
                workId: WORK_A,
                number: 3,
                trigger: 'verification',
                startedAt: new Date(NOW - 120 * MINUTE),
                verifySecretNames: names,
            });

            const rows = await repository.findWithOrphanedVerifySecrets(NOW, APP_BUILD_SWEEP_BATCH);

            expect(rows.map((row) => row.id)).toEqual([real.id]);
        });

        it('ignores a verification Build that never started', async () => {
            await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'verification',
                verifySecretNames: names,
            });

            expect(
                await repository.findWithOrphanedVerifySecrets(NOW, APP_BUILD_SWEEP_BATCH),
            ).toEqual([]);
        });

        it('returns the oldest first and honours the limit', async () => {
            for (const [index, minutes] of [90, 80, 70].entries()) {
                await seedBuild({
                    workId: WORK_A,
                    number: index + 1,
                    trigger: 'verification',
                    startedAt: new Date(NOW - minutes * MINUTE),
                    verifySecretNames: names,
                });
            }

            const rows = await repository.findWithOrphanedVerifySecrets(NOW, 2);

            expect(rows).toHaveLength(2);
            expect(rows.map((row) => row.number)).toEqual([1, 2]);
        });
    });

    describe('markLost (§7.4)', () => {
        beforeEach(async () => {
            await seedWork(WORK_A);
        });

        it('fails the Builds it is given, with the lost class and a completion stamp', async () => {
            const one = await seedBuild({ workId: WORK_A, number: 1, status: 'running' });
            const two = await seedBuild({ workId: WORK_A, number: 2, status: 'queued' });
            const completedAt = new Date(NOW);

            const affected = await repository.markLost([one.id, two.id], completedAt);

            expect(affected).toBe(2);
            for (const id of [one.id, two.id]) {
                const row = await stored(id);
                expect(row.status).toBe('failed');
                expect(row.failureClass).toBe('lost');
                expect(row.completedAt?.getTime()).toBe(completedAt.getTime());
            }
        });

        it('leaves a terminal Build exactly as it was — a lost-sweep never overwrites an outcome', async () => {
            const finished = await seedBuild({ workId: WORK_A, number: 1, status: 'succeeded' });

            const affected = await repository.markLost([finished.id], new Date(NOW));

            expect(affected).toBe(0);
            const row = await stored(finished.id);
            expect(row.status).toBe('succeeded');
            expect(row.failureClass).toBeNull();
        });

        it('is a no-op for an empty id list, without touching the table', async () => {
            await seedBuild({ workId: WORK_A, number: 1, status: 'running' });

            expect(await repository.markLost([])).toBe(0);
        });

        it('opens no status outside the two the sweep owns', () => {
            expect([...APP_BUILD_OPEN_STATUSES]).toEqual(['queued', 'running']);
        });
    });

    /**
     * §7.4's never-adopted `lost`, re-checked in the UPDATE. `markLost` re-checks only
     * the status; the never-adopted rule is about what has NOT happened yet, and it can
     * happen between the sweep's read and this write — the watch adopts the run
     * (`providerRunId`), or a prepare pass claims and starts the Build (`dispatchedAt`).
     */
    describe('markNeverAdoptedLost (§7.4, never adopted)', () => {
        beforeEach(async () => {
            await seedWork(WORK_A);
        });

        const rows = () => dataSource.getRepository(WorkBuild);

        it('fails a Build that is still exactly as read — open, no run, dispatchedAt NULL', async () => {
            const build = await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'manual',
                queuedAt: new Date(NOW - 3 * 60 * MINUTE),
            });

            expect(await repository.markNeverAdoptedLost(build.id, null, new Date(NOW))).toBe(true);

            const row = await stored(build.id);
            expect(row.status).toBe('failed');
            expect(row.failureClass).toBe('lost');
            expect(row.completedAt?.getTime()).toBe(NOW);
        });

        it('fails a Build whose dispatch stamp is the one that was read', async () => {
            const dispatchedAt = NOW - 2 * 60 * MINUTE;
            const build = await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'verification',
                status: 'running',
                queuedAt: new Date(NOW - 3 * 60 * MINUTE),
                dispatchedAt: new Date(dispatchedAt),
            });

            expect(
                await repository.markNeverAdoptedLost(build.id, dispatchedAt, new Date(NOW)),
            ).toBe(true);
            expect((await stored(build.id)).failureClass).toBe('lost');
        });

        it('leaves a Build the watch adopted after the read — a run that just started is never orphaned', async () => {
            const build = await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'manual',
                queuedAt: new Date(NOW - 3 * 60 * MINUTE),
            });
            // The adoption, landing between the sweep's read and its write.
            await rows().update(build.id, { providerRunId: 'run-42' });

            expect(await repository.markNeverAdoptedLost(build.id, null, new Date(NOW))).toBe(
                false,
            );

            const row = await stored(build.id);
            expect(row.status).toBe('queued');
            expect(row.failureClass).toBeNull();
            expect(row.providerRunId).toBe('run-42');
        });

        it('leaves a Build a prepare claimed after the read (dispatchedAt NULL → stamped)', async () => {
            const build = await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'manual',
                queuedAt: new Date(NOW - 3 * 60 * MINUTE),
            });
            // The runner's dispatch claim, landing between the read and the write.
            await rows().update(build.id, { dispatchedAt: new Date(NOW - SECOND) });

            expect(await repository.markNeverAdoptedLost(build.id, null, new Date(NOW))).toBe(
                false,
            );
            expect((await stored(build.id)).status).toBe('queued');
        });

        it('leaves a Build whose dispatch stamp changed after the read', async () => {
            const read = NOW - 2 * 60 * MINUTE;
            const build = await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'manual',
                queuedAt: new Date(NOW - 3 * 60 * MINUTE),
                dispatchedAt: new Date(read),
            });
            await rows().update(build.id, { dispatchedAt: new Date(NOW - SECOND) });

            expect(await repository.markNeverAdoptedLost(build.id, read, new Date(NOW))).toBe(
                false,
            );
            expect((await stored(build.id)).status).toBe('queued');
        });

        it('leaves a terminal Build exactly as it was', async () => {
            const finished = await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'manual',
                status: 'succeeded',
                queuedAt: new Date(NOW - 3 * 60 * MINUTE),
            });

            expect(await repository.markNeverAdoptedLost(finished.id, null, new Date(NOW))).toBe(
                false,
            );
            const row = await stored(finished.id);
            expect(row.status).toBe('succeeded');
            expect(row.failureClass).toBeNull();
        });
    });

    /**
     * T21's first slice — the sweep's re-drive read (§9.2 "a requested Build stays
     * queued … the job retries 3 times"). The window is half-open, `[min, max)` by
     * AGE: `queuedAt <= now - min` and `queuedAt > now - max`. The sweep passes
     * 90 s and 90 s + 3 × 120 s = 450 s, so exactly three two-minute ticks fall
     * inside it when the ticks are exactly periodic (three ±1 under schedule
     * jitter, fewer when a hung pass holds the lock; always bounded above by the
     * window — see `app-build-sweep.service.ts`).
     */
    describe('findUndispatchedRequested (§9.2, the sweep re-drive)', () => {
        const MIN_AGE = APP_BUILD_POLL_AFTER_SILENCE_MS;
        const MAX_AGE = 450 * SECOND;

        beforeEach(async () => {
            await seedWork(WORK_A);
        });

        const queuedAgo = (ms: number) => new Date(NOW - ms);

        it('selects a queued manual or verification Build 91 s and 449 s old, oldest first', async () => {
            const young = await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'manual',
                queuedAt: queuedAgo(91 * SECOND),
            });
            const old = await seedBuild({
                workId: WORK_A,
                number: 2,
                trigger: 'verification',
                queuedAt: queuedAgo(449 * SECOND),
            });

            const rows = await repository.findUndispatchedRequested(
                NOW,
                MIN_AGE,
                MAX_AGE,
                APP_BUILD_SWEEP_BATCH,
            );

            expect(rows.map((row) => row.id)).toEqual([old.id, young.id]);
        });

        it('includes exactly 90 s, excludes 89 s, and excludes exactly 450 s — the old end is open', async () => {
            const atMin = await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'manual',
                queuedAt: queuedAgo(MIN_AGE),
            });
            const tooYoung = await seedBuild({
                workId: WORK_A,
                number: 2,
                trigger: 'manual',
                queuedAt: queuedAgo(89 * SECOND),
            });
            const atMax = await seedBuild({
                workId: WORK_A,
                number: 3,
                trigger: 'manual',
                queuedAt: queuedAgo(MAX_AGE),
            });

            const ids = (
                await repository.findUndispatchedRequested(NOW, MIN_AGE, MAX_AGE, 200)
            ).map((row) => row.id);

            expect(ids).toEqual([atMin.id]);
            expect(ids).not.toContain(tooYoung.id);
            expect(ids).not.toContain(atMax.id);
        });

        it('never selects a dispatched Build, a push or pull-request Build, or any status but queued', async () => {
            const age = queuedAgo(120 * SECOND);
            await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'manual',
                queuedAt: age,
                // The dispatch claim (or a real dispatch) stamped it: the runner
                // already owns this Build, and a re-drive would start it twice.
                dispatchedAt: new Date(NOW - 100 * SECOND),
            });
            await seedBuild({ workId: WORK_A, number: 2, trigger: 'push', queuedAt: age });
            await seedBuild({ workId: WORK_A, number: 3, trigger: 'pull_request', queuedAt: age });
            for (const [index, status] of (
                ['running', 'blocked', 'succeeded', 'failed', 'cancelled'] as const
            ).entries()) {
                await seedBuild({
                    workId: WORK_A,
                    number: 10 + index,
                    trigger: 'manual',
                    status,
                    queuedAt: age,
                });
            }

            expect(await repository.findUndispatchedRequested(NOW, MIN_AGE, MAX_AGE, 200)).toEqual(
                [],
            );
        });

        it('never selects a Build with no queuedAt', async () => {
            await seedBuild({ workId: WORK_A, number: 1, trigger: 'manual' });

            expect(await repository.findUndispatchedRequested(NOW, MIN_AGE, MAX_AGE, 200)).toEqual(
                [],
            );
        });

        it('returns the oldest 200 of 205, and clamps a larger ask to the sweep batch', async () => {
            const rows = dataSource.getRepository(WorkBuild);
            await rows.save(
                Array.from({ length: 205 }, (_, index) =>
                    rows.create({
                        workId: WORK_A,
                        number: index + 1,
                        buildPluginId: 'github-actions',
                        status: 'queued' as const,
                        trigger: 'manual' as const,
                        branch: 'main',
                        commitSha: SHA_A,
                        // Build #1 is the oldest (300 s); #205 the youngest (96 s).
                        queuedAt: new Date(NOW - (300 - index) * SECOND),
                    }),
                ),
            );

            const page = await repository.findUndispatchedRequested(NOW, MIN_AGE, MAX_AGE, 1_000);

            expect(page).toHaveLength(APP_BUILD_SWEEP_BATCH);
            expect(page[0].number).toBe(1);
            expect(page[APP_BUILD_SWEEP_BATCH - 1].number).toBe(APP_BUILD_SWEEP_BATCH);
        });

        it('returns nothing for a non-positive limit', async () => {
            await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'manual',
                queuedAt: queuedAgo(120 * SECOND),
            });

            expect(await repository.findUndispatchedRequested(NOW, MIN_AGE, MAX_AGE, 0)).toEqual(
                [],
            );
        });

        it('names the two triggers a platform-requested Build carries', () => {
            expect([...APP_BUILD_REQUESTED_TRIGGERS]).toEqual(['manual', 'verification']);
        });
    });

    /**
     * T21's never-adopted half of §7.4's lost rule (`queuedAt + 5 min +
     * timeoutMinutes + 30`). The repository only pre-filters by one cutoff; the
     * per-Build timeout is the sweep's arithmetic.
     */
    describe('findNeverAdoptedQueuedBefore (§7.4, never adopted)', () => {
        beforeEach(async () => {
            await seedWork(WORK_A);
        });

        const CUTOFF = NOW - 40 * MINUTE;

        it('selects open manual and verification Builds with no run id queued before the cutoff', async () => {
            const queued = await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'manual',
                queuedAt: new Date(CUTOFF - 3 * MINUTE),
            });
            const dispatched = await seedBuild({
                workId: WORK_A,
                number: 2,
                trigger: 'verification',
                queuedAt: new Date(CUTOFF - 2 * MINUTE),
                dispatchedAt: new Date(CUTOFF - 2 * MINUTE),
            });
            const running = await seedBuild({
                workId: WORK_A,
                number: 3,
                trigger: 'manual',
                status: 'running',
                queuedAt: new Date(CUTOFF - 1 * MINUTE),
            });

            const rows = await repository.findNeverAdoptedQueuedBefore(
                CUTOFF,
                APP_BUILD_SWEEP_BATCH,
            );

            expect(rows.map((row) => row.id)).toEqual([queued.id, dispatched.id, running.id]);
        });

        it('excludes an adopted Build, a terminal or blocked one, push and pull-request Builds, and the cutoff itself', async () => {
            const old = new Date(CUTOFF - 60 * MINUTE);
            await seedBuild({
                workId: WORK_A,
                number: 1,
                trigger: 'manual',
                queuedAt: old,
                providerRunId: 'run-1',
            });
            for (const [index, status] of (
                ['blocked', 'succeeded', 'failed', 'cancelled'] as const
            ).entries()) {
                await seedBuild({
                    workId: WORK_A,
                    number: 10 + index,
                    trigger: 'manual',
                    status,
                    queuedAt: old,
                });
            }
            await seedBuild({ workId: WORK_A, number: 20, trigger: 'push', queuedAt: old });
            await seedBuild({ workId: WORK_A, number: 21, trigger: 'pull_request', queuedAt: old });
            await seedBuild({
                workId: WORK_A,
                number: 22,
                trigger: 'manual',
                // Strictly older than the cutoff: `queuedAt < :cutoff`.
                queuedAt: new Date(CUTOFF),
            });
            await seedBuild({ workId: WORK_A, number: 23, trigger: 'manual' });

            expect(await repository.findNeverAdoptedQueuedBefore(CUTOFF, 200)).toEqual([]);
        });

        it('returns the oldest first and honours the limit', async () => {
            for (const [index, minutes] of [90, 80, 70].entries()) {
                await seedBuild({
                    workId: WORK_A,
                    number: index + 1,
                    trigger: 'manual',
                    queuedAt: new Date(CUTOFF - minutes * MINUTE),
                });
            }

            const rows = await repository.findNeverAdoptedQueuedBefore(CUTOFF, 2);

            expect(rows.map((row) => row.number)).toEqual([1, 2]);
            expect(await repository.findNeverAdoptedQueuedBefore(CUTOFF, 0)).toEqual([]);
        });
    });

    describe('findPage (§5)', () => {
        beforeEach(async () => {
            await seedWork(WORK_A);
            await seedWork(WORK_B);
            await seedBuild({
                workId: WORK_A,
                number: 1,
                status: 'succeeded',
                trigger: 'push',
                commitSha: SHA_A,
                branch: 'main',
            });
            await seedBuild({
                workId: WORK_A,
                number: 2,
                status: 'failed',
                trigger: 'push',
                commitSha: SHA_B,
                branch: 'main',
                pullRequestNumber: null,
            });
            await seedBuild({
                workId: WORK_A,
                number: 3,
                status: 'running',
                trigger: 'pull_request',
                commitSha: SHA_B,
                branch: 'feat/x',
                pullRequestNumber: 12,
            });
            await seedBuild({ workId: WORK_B, number: 1 });
        });

        it('returns only this Work’s Builds, newest first, with the total', async () => {
            const page = await repository.findPage(WORK_A);

            expect(page.rows.map((row) => row.number)).toEqual([3, 2, 1]);
            expect(page.total).toBe(3);
            expect(page.page).toBe(1);
            expect(page.pageSize).toBe(APP_BUILD_LIST_PAGE_SIZE);
            expect(page.hasMore).toBe(false);
        });

        it('filters by status, trigger, branch and pull request', async () => {
            expect(
                (await repository.findPage(WORK_A, { status: ['running', 'succeeded'] })).rows.map(
                    (row) => row.number,
                ),
            ).toEqual([3, 1]);
            expect(
                (await repository.findPage(WORK_A, { trigger: ['pull_request'] })).rows.map(
                    (row) => row.number,
                ),
            ).toEqual([3]);
            expect(
                (await repository.findPage(WORK_A, { branch: 'main' })).rows.map(
                    (row) => row.number,
                ),
            ).toEqual([2, 1]);
            expect(
                (await repository.findPage(WORK_A, { pullRequestNumber: 12 })).rows.map(
                    (row) => row.number,
                ),
            ).toEqual([3]);
        });

        it('pages without repeating or skipping a row', async () => {
            const first = await repository.findPage(WORK_A, {}, 1, 2);
            const second = await repository.findPage(WORK_A, {}, 2, 2);

            expect(first.rows.map((row) => row.number)).toEqual([3, 2]);
            expect(first.hasMore).toBe(true);
            expect(second.rows.map((row) => row.number)).toEqual([1]);
            expect(second.hasMore).toBe(false);
        });

        it('clamps pageSize to the plan’s 1–100 and page to 1 or more', async () => {
            expect(APP_BUILD_LIST_MAX_PAGE_SIZE).toBe(100);
            expect((await repository.findPage(WORK_A, {}, 0, 1_000)).pageSize).toBe(
                APP_BUILD_LIST_MAX_PAGE_SIZE,
            );
            expect((await repository.findPage(WORK_A, {}, 0, 1_000)).page).toBe(1);
            expect((await repository.findPage(WORK_A, {}, 1, 0)).pageSize).toBe(1);
        });

        it('returns an empty page for a Work with no Builds', async () => {
            const page = await repository.findPage('99999999-9999-4999-8999-999999999999');

            expect(page.rows).toEqual([]);
            expect(page.total).toBe(0);
            expect(page.hasMore).toBe(false);
        });
    });

    describe('findByIdForWork (§5)', () => {
        beforeEach(async () => {
            await seedWork(WORK_A);
            await seedWork(WORK_B);
        });

        it('finds a Build of the Work it belongs to', async () => {
            const build = await seedBuild({ workId: WORK_A, number: 1 });

            expect((await repository.findByIdForWork(WORK_A, build.id))?.id).toBe(build.id);
        });

        it('answers null for a Build of another Work — the 404 path, as a predicate', async () => {
            const build = await seedBuild({ workId: WORK_A, number: 1 });

            expect(await repository.findByIdForWork(WORK_B, build.id)).toBeNull();
        });

        it('answers null for an id that does not exist', async () => {
            expect(
                await repository.findByIdForWork(WORK_A, '99999999-9999-4999-8999-999999999999'),
            ).toBeNull();
        });
    });

    describe('findRecentForCommit (FR-41, FR-42)', () => {
        beforeEach(async () => {
            await seedWork(WORK_A);
            await seedWork(WORK_B);
        });

        it('finds the newest Build of that commit inside the window', async () => {
            await seedBuild({ workId: WORK_A, number: 1, commitSha: SHA_A });
            const newest = await seedBuild({ workId: WORK_A, number: 2, commitSha: SHA_A });

            const found = await repository.findRecentForCommit(WORK_A, SHA_A, NOW - 10 * MINUTE);

            expect(found?.id).toBe(newest.id);
        });

        it('answers null once the window has passed, so a Rebuild is a new Build', async () => {
            await seedBuild({ workId: WORK_A, number: 1, commitSha: SHA_A });

            expect(await repository.findRecentForCommit(WORK_A, SHA_A, Date.now())).toBeNull();
        });

        it('answers null for another commit, and for another Work', async () => {
            await seedBuild({ workId: WORK_B, number: 1, commitSha: SHA_A });

            expect(
                await repository.findRecentForCommit(WORK_A, SHA_A, NOW - 10 * MINUTE),
            ).toBeNull();
            expect(
                await repository.findRecentForCommit(WORK_B, SHA_B, NOW - 10 * MINUTE),
            ).toBeNull();
        });
    });

    /**
     * What a SQLite-backed spec cannot execute, asserted at the option level.
     *
     * `pessimistic_write` is Postgres/MySQL/MariaDB-only: better-sqlite3 throws
     * `LockNotSupportedOnGivenDriverError`, so the repository skips the lock
     * there and CI never runs the branch. The recording manager below is the only
     * way to observe it — the same limitation, and the same remedy, that
     * `credit-ledger.repository`'s regression test records.
     */
    describe('the Work-row lock (what the sqlite driver cannot reach)', () => {
        function lockHarness(driver: string) {
            const workFindOne = jest.fn(async () => null);
            const buildRepo = {
                create: jest.fn((data: unknown) => data),
                save: jest.fn(async (data: unknown) => ({ id: 'build-1', ...(data as object) })),
                findOne: jest.fn(async () => null),
                createQueryBuilder: jest.fn(() => ({
                    select: jest.fn().mockReturnThis(),
                    where: jest.fn().mockReturnThis(),
                    getRawOne: jest.fn(async () => ({ highest: 0 })),
                })),
            };
            const manager = {
                connection: { options: { type: driver } },
                getRepository: jest.fn((entity: unknown) =>
                    entity === Work ? { findOne: workFindOne } : buildRepo,
                ),
                transaction: jest.fn(async (work: (m: unknown) => Promise<unknown>) =>
                    work(manager),
                ),
            };
            const entityRepository = {
                manager,
                createQueryBuilder: jest.fn(),
                findOne: jest.fn(async () => null),
            } as unknown as Repository<WorkBuild>;

            return { repository: new AppBuildRepository(entityRepository), workFindOne };
        }

        it.each(['postgres', 'mysql', 'mariadb'])(
            'locks the parent Work row on %s, joining nothing',
            async (driver) => {
                const harness = lockHarness(driver);

                await harness.repository.insertWithNextNumber(WORK_A, insert());

                expect(harness.workFindOne).toHaveBeenCalledTimes(1);
                expect(harness.workFindOne).toHaveBeenCalledWith({
                    where: { id: WORK_A },
                    lock: { mode: 'pessimistic_write' },
                    // 🛑 Load-bearing: `Work.user` is eager, and PostgreSQL
                    // refuses `FOR UPDATE` over the nullable side of the outer
                    // join that eager relation adds.
                    loadEagerRelations: false,
                });
            },
        );

        it.each(['better-sqlite3', 'sqlite', 'sqljs'])(
            'skips the lock entirely on %s, where writes serialise at the connection',
            async (driver) => {
                const harness = lockHarness(driver);

                await harness.repository.insertWithNextNumber(WORK_A, insert());

                expect(harness.workFindOne).not.toHaveBeenCalled();
            },
        );

        it('retries up to the plan’s 3 times on a unique violation, then re-throws', async () => {
            const uniqueViolation = Object.assign(
                new Error('UNIQUE constraint failed: work_builds.workId, work_builds.number'),
                { code: 'SQLITE_CONSTRAINT_UNIQUE' },
            );
            const attempts = jest.fn(async () => {
                throw uniqueViolation;
            });
            const entityRepository = {
                manager: {
                    connection: { options: { type: 'better-sqlite3' } },
                    getRepository: jest.fn(),
                    transaction: attempts,
                },
                createQueryBuilder: jest.fn(),
                findOne: jest.fn(async () => null),
            } as unknown as Repository<WorkBuild>;

            await expect(
                new AppBuildRepository(entityRepository).insertWithNextNumber(WORK_A, insert()),
            ).rejects.toThrow('UNIQUE constraint failed');

            // The first attempt plus APP_BUILD_NUMBER_RETRIES retries.
            expect(APP_BUILD_NUMBER_RETRIES).toBe(3);
            expect(attempts).toHaveBeenCalledTimes(APP_BUILD_NUMBER_RETRIES + 1);
        });

        it('does not retry an error that is not a unique violation', async () => {
            const attempts = jest.fn(async () => {
                throw new Error('disk I/O error');
            });
            const entityRepository = {
                manager: {
                    connection: { options: { type: 'better-sqlite3' } },
                    getRepository: jest.fn(),
                    transaction: attempts,
                },
                createQueryBuilder: jest.fn(),
                findOne: jest.fn(async () => null),
            } as unknown as Repository<WorkBuild>;

            await expect(
                new AppBuildRepository(entityRepository).insertWithNextNumber(WORK_A, insert()),
            ).rejects.toThrow('disk I/O error');

            expect(attempts).toHaveBeenCalledTimes(1);
        });

        it('recognises every driver’s unique-violation spelling', async () => {
            const cases: unknown[] = [
                { code: '23505' },
                { driverError: { code: '23505' } },
                { message: 'UNIQUE constraint failed: work_builds.number' },
                { message: 'duplicate key value violates unique constraint' },
                { message: 'Duplicate entry "1" for key "uq_work_builds_work_number"' },
            ];

            for (const error of cases) {
                const attempts = jest.fn(async () => {
                    throw error;
                });
                const entityRepository = {
                    manager: {
                        connection: { options: { type: 'better-sqlite3' } },
                        getRepository: jest.fn(),
                        transaction: attempts,
                    },
                    createQueryBuilder: jest.fn(),
                    findOne: jest.fn(async () => null),
                } as unknown as Repository<WorkBuild>;

                await expect(
                    new AppBuildRepository(entityRepository).insertWithNextNumber(WORK_A, insert()),
                ).rejects.toBeDefined();
                expect(attempts).toHaveBeenCalledTimes(APP_BUILD_NUMBER_RETRIES + 1);
            }
        });
    });
});
