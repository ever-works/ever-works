import { DataSource, UpdateQueryBuilder } from 'typeorm';
import { APP_DEPENDENCY_INACTIVE_STATUSES } from '@ever-works/contracts';
import { WorkAppDependency } from '../../../entities/work-app-dependency.entity';
import { ENTITIES } from '../../_entities-inventory';
import { WorkAppDependencyRepository } from '../work-app-dependency.repository';

/**
 * APW-07 T8 — the dependency store, executed against a real (in-memory
 * better-sqlite3) database, including the REAL partial-active unique index:
 * `synchronize` builds the tables from the entities, and the index is then
 * created with the very statement the migration's SQLite branch emits
 * (`apps/api/src/migrations/1792070000000-CreateAppEnvAndDependencies.ts`).
 * Without it "a second active row for the same kind is refused" would be
 * asserted against a schema production does not have.
 *
 * What this spec pins, in T8's order:
 *
 *  - **lease exclusivity** — `claimLease` stamps `provisionLeaseUntil` only
 *    when the row is free, so two workers cannot provision one dependency at
 *    once, and the stamp is a parameterised compare-and-set with no
 *    `now() + interval` in it (APW07-G12 / plan §4.8:563-566);
 *  - **the active unique index** — a second `ready` row for one `(workId,
 *    kind)` is refused while a `kept` row and a new active one coexist;
 *  - **`outputsVersion + 1`** — the version is bumped in SQL, never from a
 *    value a caller read.
 *
 * Plan §3.2 (`plan.md:202-232`) is the column contract; the method names are
 * T8's. Every uuid below is obviously synthetic.
 */

const WORK_A = '11111111-1111-4111-8111-111111111111';
const WORK_B = '22222222-2222-4222-8222-222222222222';

/** A fixed instant so a stored lease is exact, never wall-clock flaky. */
const NOW = Date.parse('2026-09-17T09:30:00.000Z');
const MINUTE = 60_000;

/** The migration's SQLite branch, verbatim (APW07-G12). */
const ACTIVE_UNIQUE_INDEX_SQL =
    `CREATE UNIQUE INDEX IF NOT EXISTS "uq_work_app_dependencies_active" ` +
    `ON "work_app_dependencies" ("workId", "kind", ` +
    `CASE WHEN "status" NOT IN (${APP_DEPENDENCY_INACTIVE_STATUSES.map((status) => `'${status}'`).join(', ')}) THEN 1 ELSE NULL END)`;

describe('WorkAppDependencyRepository', () => {
    let dataSource: DataSource;
    let repository: WorkAppDependencyRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        await dataSource.query(ACTIVE_UNIQUE_INDEX_SQL);
        repository = new WorkAppDependencyRepository(dataSource.getRepository(WorkAppDependency));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(WorkAppDependency).clear();
    });

    /** A complete row, with only the field under test overridden. */
    function seed(
        workId: string,
        kind: WorkAppDependency['kind'],
        overrides: Partial<WorkAppDependency> = {},
    ): Promise<WorkAppDependency> {
        const rows = dataSource.getRepository(WorkAppDependency);
        return rows.save(
            rows.create({
                workId,
                kind,
                deployTarget: 'your-cluster',
                providerPluginId: 'k8s',
                providerId: `k8s-inline-${kind}`,
                status: 'pending',
                declared: { kind },
                backupPolicy: kind === 'objectStorage' ? 'provider' : 'none',
                ...overrides,
            }),
        );
    }

    /** Read a row straight from the table, envelopes included. */
    function stored(id: string): Promise<WorkAppDependency | null> {
        return dataSource.getRepository(WorkAppDependency).findOne({ where: { id } });
    }

    describe('findActiveByWork (the Dependencies card and the deploy preflight)', () => {
        it('returns every active kind of one App Work, ordered by kind', async () => {
            await seed(WORK_A, 'redis');
            await seed(WORK_A, 'postgres');
            await seed(WORK_B, 'postgres');

            const rows = await repository.findActiveByWork(WORK_A);

            expect(rows.map((row) => row.kind)).toEqual(['postgres', 'redis']);
        });

        it('keeps a row that is still being configured or provisioned — it is active', async () => {
            await seed(WORK_A, 'postgres', { status: 'awaiting_config' });
            await seed(WORK_A, 'redis', { status: 'provisioning' });
            await seed(WORK_A, 'smtp', { status: 'failed' });
            await seed(WORK_A, 'objectStorage', { status: 'degraded' });

            const rows = await repository.findActiveByWork(WORK_A);

            expect(rows.map((row) => row.status).sort()).toEqual([
                'awaiting_config',
                'degraded',
                'failed',
                'provisioning',
            ]);
        });

        it('leaves the released and deleted rows out — they are history, not a dependency', async () => {
            await seed(WORK_A, 'postgres', { status: 'kept' });
            await seed(WORK_A, 'redis', { status: 'deleted' });
            await seed(WORK_A, 'smtp', { status: 'ready' });

            const rows = await repository.findActiveByWork(WORK_A);

            expect(rows.map((row) => row.kind)).toEqual(['smtp']);
        });

        it('never carries a config or output envelope (FR-5)', async () => {
            await seed(WORK_A, 'smtp', {
                status: 'ready',
                configEncrypted: 'enc::v1::config',
                outputsEncrypted: 'enc::v1::outputs',
                outputsVersion: 3,
            });

            const [row] = await repository.findActiveByWork(WORK_A);

            expect('configEncrypted' in row).toBe(false);
            expect('outputsEncrypted' in row).toBe(false);
            expect((row as unknown as Record<string, unknown>).outputsEncrypted).toBeUndefined();
            // Everything the card renders is still there.
            expect(row.status).toBe('ready');
            expect(row.outputsVersion).toBe(3);
            expect(row.providerId).toBe('k8s-inline-smtp');
        });

        it('returns nothing for an App Work with no dependency', async () => {
            expect(await repository.findActiveByWork(WORK_B)).toEqual([]);
        });
    });

    describe('findByWorkAndKind', () => {
        it('returns the active row of that kind, envelope-free', async () => {
            await seed(WORK_A, 'postgres', { status: 'ready', sizeGiB: 10 });
            await seed(WORK_A, 'redis', { status: 'ready' });

            const row = await repository.findByWorkAndKind(WORK_A, 'postgres');

            expect(row?.kind).toBe('postgres');
            expect(row?.sizeGiB).toBe(10);
            expect('outputsEncrypted' in (row as object)).toBe(false);
        });

        it('falls back to the newest kept row of that kind when nothing is active', async () => {
            // The delete-data dialog lists what a release kept, so a kept row
            // has to be reachable by kind.
            await seed(WORK_A, 'postgres', {
                status: 'kept',
                updatedAt: new Date(NOW - 2 * MINUTE),
                actualVersion: '14',
            });
            await seed(WORK_A, 'postgres', {
                status: 'kept',
                updatedAt: new Date(NOW - MINUTE),
                actualVersion: '16',
            });

            const row = await repository.findByWorkAndKind(WORK_A, 'postgres');

            expect(row?.status).toBe('kept');
            expect(row?.actualVersion).toBe('16');
        });

        it('prefers the active row over a kept one of the same kind', async () => {
            await seed(WORK_A, 'postgres', {
                status: 'kept',
                updatedAt: new Date(NOW),
                actualVersion: '14',
            });
            await seed(WORK_A, 'postgres', {
                status: 'ready',
                updatedAt: new Date(NOW - MINUTE),
                actualVersion: '16',
            });

            const row = await repository.findByWorkAndKind(WORK_A, 'postgres');

            expect(row?.status).toBe('ready');
            expect(row?.actualVersion).toBe('16');
        });

        it('never returns a deleted row', async () => {
            await seed(WORK_A, 'postgres', { status: 'deleted' });

            expect(await repository.findByWorkAndKind(WORK_A, 'postgres')).toBeNull();
        });

        it('returns null for a kind the App Work does not have, and for another Work', async () => {
            await seed(WORK_A, 'postgres');

            expect(await repository.findByWorkAndKind(WORK_A, 'smtp')).toBeNull();
            expect(await repository.findByWorkAndKind(WORK_B, 'postgres')).toBeNull();
        });
    });

    describe('claimLease (plan §4.8:563-566, APW07-G12)', () => {
        it('claims a free row and stamps the lease', async () => {
            const row = await seed(WORK_A, 'postgres');

            const claimed = await repository.claimLease(row.id, 15 * MINUTE);

            expect(claimed?.id).toBe(row.id);
            const until = claimed?.provisionLeaseUntil?.getTime() ?? 0;
            expect(until).toBeGreaterThan(Date.now() + 14 * MINUTE);
            expect(until).toBeLessThanOrEqual(Date.now() + 15 * MINUTE);
            expect((await stored(row.id))?.provisionLeaseUntil).toBeInstanceOf(Date);
        });

        it('hands the row to one worker only — a second claim while it is held gets nothing', async () => {
            const row = await seed(WORK_A, 'postgres');

            expect(await repository.claimLease(row.id, 15 * MINUTE)).not.toBeNull();
            expect(await repository.claimLease(row.id, 15 * MINUTE)).toBeNull();
        });

        it('refuses a claim from a worker whose clock still sees the old stamp', async () => {
            // The row is already held: the CAS predicate, not the caller, decides.
            const row = await seed(WORK_A, 'postgres', {
                provisionLeaseUntil: new Date(Date.now() + MINUTE),
            });

            expect(await repository.claimLease(row.id, 15 * MINUTE)).toBeNull();
            const still = (await stored(row.id))?.provisionLeaseUntil?.getTime() ?? 0;
            expect(still).toBeGreaterThan(Date.now() + 30_000);
        });

        it('lets the next worker claim an expired lease', async () => {
            const row = await seed(WORK_A, 'postgres', {
                provisionLeaseUntil: new Date(Date.now() - MINUTE),
            });

            const claimed = await repository.claimLease(row.id, 15 * MINUTE);

            expect(claimed?.id).toBe(row.id);
            expect(claimed?.provisionLeaseUntil?.getTime() ?? 0).toBeGreaterThan(Date.now());
        });

        it('returns null for a row that does not exist', async () => {
            expect(
                await repository.claimLease('00000000-0000-4000-8000-000000000000', MINUTE),
            ).toBeNull();
        });

        it('never claims twice across twenty concurrent callers', async () => {
            const row = await seed(WORK_A, 'postgres');

            const claims = await Promise.all(
                Array.from({ length: 20 }, () => repository.claimLease(row.id, 15 * MINUTE)),
            );

            expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
        });

        it('is a parameterised compare-and-set — no `now()`, no `interval` (APW07-G12)', async () => {
            const row = await seed(WORK_A, 'postgres');
            const captured: Array<{ sql: string; parameters: Record<string, unknown> }> = [];
            const spy = jest
                .spyOn(UpdateQueryBuilder.prototype, 'execute')
                .mockImplementation(function (this: UpdateQueryBuilder<WorkAppDependency>) {
                    captured.push({ sql: this.getQuery(), parameters: this.getParameters() });
                    return Promise.resolve({ raw: [], affected: 1, generatedMaps: [] });
                });
            try {
                await repository.claimLease(row.id, 15 * MINUTE);
            } finally {
                spy.mockRestore();
            }

            expect(captured).toHaveLength(1);
            const { sql, parameters } = captured[0];
            expect(sql).toContain('"provisionLeaseUntil"');
            expect(sql).toContain('"provisionLeaseUntil" IS NULL');
            expect(sql).toMatch(/"provisionLeaseUntil" < /);
            expect(sql.toLowerCase()).not.toContain('now()');
            expect(sql.toLowerCase()).not.toContain('interval');
            // Both sides of the comparison are BOUND, so the same statement is
            // correct on Postgres, SQLite and MySQL/MariaDB.
            expect(Object.values(parameters).some((value) => typeof value === 'number')).toBe(true);
        });
    });

    describe('the active unique index (plan §3.2:225)', () => {
        it('refuses a second active row for the same (workId, kind)', async () => {
            await seed(WORK_A, 'postgres', { status: 'ready' });

            await expect(seed(WORK_A, 'postgres', { status: 'pending' })).rejects.toThrow();
        });

        it('refuses it for a deleted-free pair of provisioning states too', async () => {
            await seed(WORK_A, 'postgres', { status: 'provisioning' });

            await expect(seed(WORK_A, 'postgres', { status: 'awaiting_config' })).rejects.toThrow();
        });

        it('allows a kept row and a new active row for the same kind', async () => {
            await seed(WORK_A, 'postgres', { status: 'kept' });

            await expect(seed(WORK_A, 'postgres', { status: 'pending' })).resolves.toBeDefined();

            const rows = await dataSource
                .getRepository(WorkAppDependency)
                .find({ where: { workId: WORK_A, kind: 'postgres' } });
            expect(rows.map((row) => row.status).sort()).toEqual(['kept', 'pending']);
        });

        it('allows any number of kept and deleted rows for one kind', async () => {
            for (const status of APP_DEPENDENCY_INACTIVE_STATUSES) {
                await expect(seed(WORK_A, 'postgres', { status })).resolves.toBeDefined();
                await expect(seed(WORK_A, 'postgres', { status })).resolves.toBeDefined();
            }

            const rows = await dataSource
                .getRepository(WorkAppDependency)
                .find({ where: { workId: WORK_A, kind: 'postgres' } });
            expect(rows).toHaveLength(4);
        });

        it('keeps two App Works independent, and two kinds of one App Work', async () => {
            await seed(WORK_A, 'postgres', { status: 'ready' });
            await seed(WORK_A, 'redis', { status: 'ready' });
            await seed(WORK_B, 'postgres', { status: 'ready' });

            expect((await repository.findActiveByWork(WORK_A)).map((row) => row.kind)).toEqual([
                'postgres',
                'redis',
            ]);
        });
    });

    describe('markKept / markDeleted (FR-45, FR-46, plan §4.12)', () => {
        it('moves a released dependency to kept, and reports a missing row instead of succeeding', async () => {
            const row = await seed(WORK_A, 'postgres', { status: 'deleting' });

            await expect(repository.markKept(row.id)).resolves.toBe(true);
            await expect(repository.markKept('00000000-0000-4000-8000-000000000000')).resolves.toBe(
                false,
            );

            expect((await stored(row.id))?.status).toBe('kept');
        });

        it('moves a deleted dependency to deleted', async () => {
            const row = await seed(WORK_A, 'postgres', { status: 'deleting' });

            await expect(repository.markDeleted(row.id)).resolves.toBe(true);
            await expect(
                repository.markDeleted('00000000-0000-4000-8000-000000000000'),
            ).resolves.toBe(false);

            expect((await stored(row.id))?.status).toBe('deleted');
        });

        it('makes the row inactive, so the card stops calling it a dependency', async () => {
            const row = await seed(WORK_A, 'postgres', { status: 'ready' });

            await repository.markKept(row.id);

            expect(await repository.findActiveByWork(WORK_A)).toEqual([]);
            expect((await repository.findByWorkAndKind(WORK_A, 'postgres'))?.status).toBe('kept');
        });

        it('leaves the other kinds of the same App Work alone', async () => {
            const postgres = await seed(WORK_A, 'postgres', { status: 'ready' });
            await seed(WORK_A, 'redis', { status: 'ready' });

            await repository.markDeleted(postgres.id);

            expect((await repository.findActiveByWork(WORK_A)).map((row) => row.kind)).toEqual([
                'redis',
            ]);
        });
    });

    describe('updateOutputs (outputsVersion + 1)', () => {
        it('stores the envelope and bumps the version', async () => {
            const row = await seed(WORK_A, 'postgres', { status: 'ready' });

            const updated = await repository.updateOutputs(row.id, 'enc::v1::first');

            expect(updated?.outputsEncrypted).toBe('enc::v1::first');
            expect(updated?.outputsVersion).toBe(1);
        });

        it('counts one version per write, never reusing one', async () => {
            const row = await seed(WORK_A, 'postgres', { status: 'ready' });

            await repository.updateOutputs(row.id, 'enc::v1::first');
            await repository.updateOutputs(row.id, 'enc::v1::second');

            expect((await stored(row.id))?.outputsVersion).toBe(2);
            expect((await stored(row.id))?.outputsEncrypted).toBe('enc::v1::second');
        });

        it('accepts NULL, which is what a managed-tier row always carries', async () => {
            const row = await seed(WORK_A, 'postgres', {
                status: 'ready',
                outputsEncrypted: 'enc::v1::gone',
            });

            const updated = await repository.updateOutputs(row.id, null);

            expect(updated?.outputsEncrypted ?? null).toBeNull();
            expect(updated?.outputsVersion).toBe(1);
        });

        it('returns null for a row that does not exist', async () => {
            expect(
                await repository.updateOutputs(
                    '00000000-0000-4000-8000-000000000000',
                    'enc::v1::x',
                ),
            ).toBeNull();
        });

        it('bumps in SQL (`"outputsVersion" + 1`), so two refreshes cannot both write 1', async () => {
            const row = await seed(WORK_A, 'postgres', { status: 'ready' });
            const captured: string[] = [];
            const spy = jest
                .spyOn(UpdateQueryBuilder.prototype, 'execute')
                .mockImplementation(function (this: UpdateQueryBuilder<WorkAppDependency>) {
                    captured.push(this.getQuery());
                    return Promise.resolve({ raw: [], affected: 1, generatedMaps: [] });
                });
            try {
                await repository.updateOutputs(row.id, 'enc::v1::x');
            } finally {
                spy.mockRestore();
            }

            expect(captured).toHaveLength(1);
            expect(captured[0]).toContain('"outputsVersion" + 1');
        });

        it('leaves the config envelope untouched', async () => {
            const row = await seed(WORK_A, 'smtp', {
                status: 'ready',
                configEncrypted: 'enc::v1::config',
            });

            await repository.updateOutputs(row.id, 'enc::v1::outputs');

            const after = await stored(row.id);
            expect(after?.configEncrypted).toBe('enc::v1::config');
            expect(after?.outputsEncrypted).toBe('enc::v1::outputs');
        });
    });
});
