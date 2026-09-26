import { DataSource } from 'typeorm';
import { CreateWorkAppRuntimeStates1792060100000 } from '../1792060100000-CreateWorkAppRuntimeStates';

/**
 * APW-06 T17 — migration test for `work_app_runtime_states`, run against an
 * in-memory better-sqlite3 DataSource (the same harness as the sibling
 * migration specs, e.g. `CreateWorkUpstreamStates.spec.ts`).
 *
 * What matters:
 *  - the table carries the columns of plan §7.2, so the entity and the schema
 *    cannot drift apart unnoticed — and it carries NO `licenseAttestation`
 *    column (R-3, ACC-06-39), which is the one column this table must not have;
 *  - a fresh row starts `none` / `unknown` / not paused with every counter at
 *    zero — the state an App Work is in before anything has happened, and the
 *    values `AppDeployRequestService` reads before the first deploy;
 *  - deleting the Work deletes its runtime state (FK cascade), while a deleted
 *    Deployment does NOT (there is no second foreign key — `plan.md:244`);
 *  - the four indexes §7.2 names exist, and the `workId` one is UNIQUE (it is
 *    what decides the `getOrCreate` insert race);
 *  - `up()` is idempotent and `down()` drops only what `up()` created.
 *
 * The `works` table is a stub created here: this migration owns one table and
 * one foreign key into a table another migration owns, and the FK's behaviour —
 * not the `works` schema — is what is under test.
 *
 * Inserts pass `id` explicitly: `uuid_generate_v4()` is a Postgres function and
 * sqlite is only a DDL harness here.
 */
describe('CreateWorkAppRuntimeStates1792060100000', () => {
    let dataSource: DataSource;
    const migration = new CreateWorkAppRuntimeStates1792060100000();

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`PRAGMA foreign_keys = ON`);
        await dataSource.query(`CREATE TABLE "works" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "works" ("id") VALUES ('w1'), ('w2')`);
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    function insert(id: string, workId = 'w1'): Promise<unknown> {
        // Only `id` and `workId`: every other column must have a schema default
        // or be nullable, and this insert is what proves it.
        return dataSource.query(
            `INSERT INTO "work_app_runtime_states" ("id", "workId") VALUES ('${id}', '${workId}')`,
        );
    }

    async function rows(): Promise<Array<Record<string, unknown>>> {
        return dataSource.query(`SELECT * FROM "work_app_runtime_states" ORDER BY "id"`);
    }

    async function columnNames(): Promise<string[]> {
        const info: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("work_app_runtime_states")`,
        );
        return info.map((column) => column.name);
    }

    async function indexNames(): Promise<string[]> {
        const indexes: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'work_app_runtime_states'`,
        );
        return indexes.map((index) => index.name).sort();
    }

    describe('up()', () => {
        beforeEach(async () => {
            await run('up');
        });

        it('creates the table with the columns the epic reads', async () => {
            const names = await columnNames();

            expect(names).toEqual(
                expect.arrayContaining([
                    'id',
                    'workId',
                    'target',
                    'targetSettings',
                    'namespace',
                    'clusterFingerprint',
                    'clusterCheck',
                    'clusterCheckedAt',
                    'currentDeploymentId',
                    'deployLockId',
                    'deployLockedAt',
                    'cancelRequestedAt',
                    'cancelRequestedByUserId',
                    'queuedDeploymentId',
                    'queuedBuildId',
                    'pendingDomainRebuildBuildId',
                    'upstreamSyncJudgedToSha',
                    'firstPublishedAt',
                    'firstDeployJobsCompletedAt',
                    'paused',
                    'pausedAt',
                    'removedAt',
                    'deletionRequestedAt',
                    'deletionDeleteData',
                    'deletionAttempts',
                    'deletionRequestedByUserId',
                    'ingressAddress',
                    'isolationEnforced',
                    'health',
                    'consecutiveFailures',
                    'consecutivePasses',
                    'unreachableStreak',
                    'lastHealthNotifiedAt',
                    'lastPolledAt',
                    'certInvalidSince',
                    'statusSnapshot',
                    'statusObservedAt',
                    'tenantId',
                    'organizationId',
                    'createdAt',
                    'updatedAt',
                ]),
            );
        });

        it('ACC-06-39 / R-3: has NO `licenseAttestation` column', async () => {
            // Hosting eligibility is read from APW-03's `AppLicenseService` when
            // it is needed. A column here would be a second source of truth for
            // a legal answer, and a stale one.
            expect(await columnNames()).not.toContain('licenseAttestation');
        });

        it('stores every timestamp as `bigint`, never a date type', async () => {
            // `plan.md:1020`: better-sqlite3 cannot boot with `timestamptz`, and
            // the health poller's ordering key has to mean the same thing on
            // both drivers.
            const info: Array<{ name: string; type: string }> = await dataSource.query(
                `PRAGMA table_info("work_app_runtime_states")`,
            );
            const timestamps = [
                'clusterCheckedAt',
                'deployLockedAt',
                'cancelRequestedAt',
                'firstPublishedAt',
                'firstDeployJobsCompletedAt',
                'pausedAt',
                'removedAt',
                'deletionRequestedAt',
                'lastHealthNotifiedAt',
                'lastPolledAt',
                'certInvalidSince',
                'statusObservedAt',
            ];
            for (const name of timestamps) {
                const column = info.find((entry) => entry.name === name);
                expect([name, column?.type.toLowerCase()]).toEqual([name, 'bigint']);
            }
        });

        it('gives a fresh row the state an App Work starts in', async () => {
            await insert('s1');

            const [row] = await rows();
            expect(row.target).toBe('none');
            expect(row.health).toBe('unknown');
            expect(row.deletionAttempts).toBe(0);
            expect(row.consecutiveFailures).toBe(0);
            expect(row.consecutivePasses).toBe(0);
            expect(row.unreachableStreak).toBe(0);
            // sqlite stores booleans as 0/1.
            expect(Number(row.paused)).toBe(0);
            expect(row.deployLockId).toBeNull();
            expect(row.currentDeploymentId).toBeNull();
        });

        it('creates the four indexes §7.2 names, with `workId` UNIQUE', async () => {
            const names = await indexNames();

            expect(names).toEqual(
                expect.arrayContaining([
                    'idx_work_app_runtime_states_deletion',
                    'idx_work_app_runtime_states_lock',
                    'idx_work_app_runtime_states_poll',
                    'uq_work_app_runtime_states_work',
                ]),
            );

            await insert('s1', 'w1');
            // One row per App Work — and the thing that decides the getOrCreate
            // insert race between two concurrent readers.
            await expect(insert('s2', 'w1')).rejects.toThrow();
        });

        it('cascades from `works`, and only from `works`', async () => {
            await insert('s1', 'w1');
            await insert('s2', 'w2');

            await dataSource.query(`DELETE FROM "works" WHERE "id" = 'w1'`);

            const remaining = await rows();
            expect(remaining.map((row) => row.id)).toEqual(['s2']);
        });

        it('lets a Deployment id name a row no table holds (no second FK)', async () => {
            // `plan.md:244`'s rule: a Deployment deleted after it was named here
            // must not cascade away the state row, and `deployLockId` must stay
            // writable to a value nothing holds while a dispatch is in flight.
            await insert('s1');
            await dataSource.query(
                `UPDATE "work_app_runtime_states"
                 SET "deployLockId" = 'not-a-row', "currentDeploymentId" = 'also-not-a-row'
                 WHERE "id" = 's1'`,
            );

            const [row] = await rows();
            expect(row.deployLockId).toBe('not-a-row');
        });

        it('is idempotent — a second `up()` is a no-op', async () => {
            await insert('s1');

            await run('up');

            expect(await rows()).toHaveLength(1);
            expect(await indexNames()).toEqual(
                expect.arrayContaining(['uq_work_app_runtime_states_work']),
            );
        });
    });

    describe('down()', () => {
        it('drops the table and its indexes, and nothing else', async () => {
            await run('up');
            await insert('s1');

            await run('down');

            const tables: Array<{ name: string }> = await dataSource.query(
                `SELECT name FROM sqlite_master WHERE type = 'table'`,
            );
            expect(tables.map((table) => table.name)).not.toContain('work_app_runtime_states');
            // The table this migration does not own is untouched.
            expect(tables.map((table) => table.name)).toContain('works');
            expect(await indexNames()).toEqual([]);
        });

        it('is safe on a database where `up()` never ran', async () => {
            await expect(run('down')).resolves.toBeUndefined();
        });
    });
});
