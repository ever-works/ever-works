import { DataSource, UpdateQueryBuilder } from 'typeorm';
import { WorkAppEnvValue } from '../../../entities/work-app-env-value.entity';
import { ENTITIES } from '../../_entities-inventory';
import {
    WorkAppEnvValueRepository,
    type InsertWorkAppEnvValueInput,
    type UpsertWorkAppEnvValueInput,
} from '../work-app-env-value.repository';

/**
 * APW-07 T8 — the Environment value store, executed against a real
 * (in-memory better-sqlite3) database rather than a mocked repository: the
 * unique `(workId, name)` index, the `version = version + 1` update and the
 * insert-or-ignore-then-re-read of ACC-07-02 are the ones production runs.
 *
 * better-sqlite3 is the default `DATABASE_TYPE` (every local and self-hosted
 * install) and the driver CI and the e2e lane use, so a claim that only holds
 * under a pooled driver is not a claim that holds.
 *
 * The two properties this spec exists for:
 *
 *  - **ACC-07-02** — 20 concurrent `insertIfAbsent` calls for one
 *    `(workId, name)` leave exactly ONE row, and every caller reads back the
 *    same envelope, so the first writer's generated secret is the one the app
 *    is given and no caller can invent a second.
 *  - **FR-5** — the table's per-Work read never carries `valueEncrypted`, so
 *    no response built from it can leak a stored value.
 *
 * Plan §3.1 (`plan.md:176-200`) for the columns and the race-safe generation
 * contract; the method names are T8's. Every uuid below is obviously
 * synthetic.
 */

const WORK_A = '11111111-1111-4111-8111-111111111111';
const WORK_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const ORG = '44444444-4444-4444-8444-444444444444';
const TENANT = '55555555-5555-4555-8555-555555555555';

/** A fixed instant so a stored stamp is exact, never wall-clock flaky. */
const NOW = Date.parse('2026-09-17T09:30:00.000Z');

/** An `enc::v1::` envelope, exactly as `AppEnvCrypto` writes one (T9). */
const envelope = (marker: string) => `enc::v1::${marker}`;

describe('WorkAppEnvValueRepository', () => {
    let dataSource: DataSource;
    let repository: WorkAppEnvValueRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        // The owning Work row is not what is under test; the FK itself is
        // asserted in `apps/api/.../CreateAppEnvAndDependencies.spec.ts`.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        repository = new WorkAppEnvValueRepository(dataSource.getRepository(WorkAppEnvValue));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(WorkAppEnvValue).clear();
    });

    /** A complete insert input, with only the field under test overridden. */
    function input(
        overrides: Partial<InsertWorkAppEnvValueInput> = {},
    ): InsertWorkAppEnvValueInput {
        return {
            workId: WORK_A,
            name: 'JWT_SECRET',
            origin: 'generated',
            valueEncrypted: envelope('first-writer'),
            valueBytes: 32,
            generatorFingerprint: 'base64:24',
            generatedAt: new Date(NOW),
            setByUserId: null,
            ...overrides,
        };
    }

    /** A complete upsert patch (the envelope and its measured size). */
    function patch(
        overrides: Partial<UpsertWorkAppEnvValueInput> = {},
    ): UpsertWorkAppEnvValueInput {
        return {
            origin: 'user',
            valueEncrypted: envelope('set-by-you'),
            valueBytes: 11,
            ...overrides,
        };
    }

    /** Read a row straight from the table, envelope included. */
    function stored(workId: string, name: string): Promise<WorkAppEnvValue | null> {
        return dataSource.getRepository(WorkAppEnvValue).findOne({ where: { workId, name } });
    }

    describe('insertIfAbsent (ACC-07-02)', () => {
        it('writes the row at version 1 with the envelope it was handed', async () => {
            const row = await repository.insertIfAbsent(
                input({ tenantId: TENANT, organizationId: ORG, setByUserId: USER }),
            );

            expect(row.name).toBe('JWT_SECRET');
            expect(row.origin).toBe('generated');
            expect(row.valueEncrypted).toBe(envelope('first-writer'));
            expect(row.valueBytes).toBe(32);
            expect(row.version).toBe(1);
            expect(row.generatorFingerprint).toBe('base64:24');
            expect(row.generatedAt?.getTime()).toBe(NOW);
            expect(row.setByUserId).toBe(USER);
            expect(row.tenantId).toBe(TENANT);
            expect(row.organizationId).toBe(ORG);
            expect(row.createdAt).toBeInstanceOf(Date);
        });

        it('defaults every optional column to NULL rather than inventing a value', async () => {
            await repository.insertIfAbsent(
                input({
                    generatorFingerprint: null,
                    generatedAt: null,
                    derivedFromName: null,
                }),
            );

            const row = await stored(WORK_A, 'JWT_SECRET');

            expect(row?.generatorFingerprint ?? null).toBeNull();
            expect(row?.derivedFromName ?? null).toBeNull();
            expect(row?.generatedAt ?? null).toBeNull();
            expect(row?.setByUserId ?? null).toBeNull();
            expect(row?.tenantId ?? null).toBeNull();
            expect(row?.organizationId ?? null).toBeNull();
        });

        it('stores a derived keypair public half with its source name', async () => {
            await repository.insertIfAbsent(
                input({
                    name: 'SIGNING_KEY_PUBLIC',
                    origin: 'derived',
                    derivedFromName: 'SIGNING_KEY',
                    valueEncrypted: envelope('public-half'),
                    valueBytes: 451,
                }),
            );

            const row = await stored(WORK_A, 'SIGNING_KEY_PUBLIC');

            expect(row?.origin).toBe('derived');
            expect(row?.derivedFromName).toBe('SIGNING_KEY');
        });

        it('never overwrites an existing row — the first writer wins', async () => {
            const first = await repository.insertIfAbsent(input());
            const second = await repository.insertIfAbsent(
                input({ valueEncrypted: envelope('loser'), valueBytes: 999 }),
            );

            expect(second.valueEncrypted).toBe(first.valueEncrypted);
            expect(second.version).toBe(1);
            expect((await stored(WORK_A, 'JWT_SECRET'))?.valueEncrypted).toBe(
                envelope('first-writer'),
            );
        });

        it('holds one row and one envelope for 20 concurrent callers', async () => {
            const results = await Promise.all(
                Array.from({ length: 20 }, (_unused, index) =>
                    repository.insertIfAbsent(
                        input({ valueEncrypted: envelope(`writer-${index}`) }),
                    ),
                ),
            );

            const rows = await dataSource
                .getRepository(WorkAppEnvValue)
                .find({ where: { workId: WORK_A } });

            expect(rows).toHaveLength(1);
            const envelopes = new Set(results.map((row) => row.valueEncrypted));
            expect(envelopes.size).toBe(1);
            expect([...envelopes][0]).toBe(rows[0].valueEncrypted);
        });

        it('keeps one row per name, and one per Work for the same name', async () => {
            await repository.insertIfAbsent(input({ name: 'JWT_SECRET' }));
            await repository.insertIfAbsent(input({ name: 'SESSION_SECRET' }));
            await repository.insertIfAbsent(input({ workId: WORK_B, name: 'JWT_SECRET' }));

            const rows = await dataSource
                .getRepository(WorkAppEnvValue)
                .find({ order: { workId: 'ASC', name: 'ASC' } });

            expect(rows.map((row) => `${row.workId}/${row.name}`)).toEqual([
                `${WORK_A}/JWT_SECRET`,
                `${WORK_A}/SESSION_SECRET`,
                `${WORK_B}/JWT_SECRET`,
            ]);
        });
    });

    describe('findByWork (FR-5 — no value ever leaves this read)', () => {
        it('returns every row of the App Work, ordered by name', async () => {
            await repository.insertIfAbsent(input({ name: 'JWT_SECRET' }));
            await repository.insertIfAbsent(input({ name: 'APP_KEY' }));
            await repository.insertIfAbsent(input({ workId: WORK_B, name: 'OTHER' }));

            const rows = await repository.findByWork(WORK_A);

            expect(rows.map((row) => row.name)).toEqual(['APP_KEY', 'JWT_SECRET']);
        });

        it('never carries valueEncrypted, so a response built from it cannot leak a value', async () => {
            await repository.insertIfAbsent(input());

            const [row] = await repository.findByWork(WORK_A);

            expect('valueEncrypted' in row).toBe(false);
            expect((row as unknown as Record<string, unknown>).valueEncrypted).toBeUndefined();
            // Everything a table row renders is still there.
            expect(row.valueBytes).toBe(32);
            expect(row.version).toBe(1);
            expect(row.origin).toBe('generated');
        });

        it('carries no envelope for a derived keypair public-half row either', async () => {
            await repository.insertIfAbsent(
                input({
                    name: 'SIGNING_KEY_PUBLIC',
                    origin: 'derived',
                    derivedFromName: 'SIGNING_KEY',
                }),
            );

            const [row] = await repository.findByWork(WORK_A);

            expect('valueEncrypted' in row).toBe(false);
            expect(row.derivedFromName).toBe('SIGNING_KEY');
        });

        it('returns nothing for an App Work that has no values', async () => {
            expect(await repository.findByWork(WORK_B)).toEqual([]);
        });
    });

    describe('upsertValue (version + 1 on every change)', () => {
        it('bumps the version and stores the new envelope', async () => {
            await repository.insertIfAbsent(input());

            const updated = await repository.upsertValue(WORK_A, 'JWT_SECRET', patch());

            expect(updated.version).toBe(2);
            expect(updated.valueEncrypted).toBe(envelope('set-by-you'));
            expect(updated.valueBytes).toBe(11);
            expect(updated.origin).toBe('user');
        });

        it('creates the row at version 1 when the name has no row yet', async () => {
            const created = await repository.upsertValue(WORK_A, 'EXTRA_NAME', patch());

            expect(created.version).toBe(1);
            expect(created.valueEncrypted).toBe(envelope('set-by-you'));
            expect(created.name).toBe('EXTRA_NAME');
        });

        it('counts one version per change, never reusing one', async () => {
            await repository.insertIfAbsent(input());

            for (let round = 2; round <= 6; round += 1) {
                const row = await repository.upsertValue(
                    WORK_A,
                    'JWT_SECRET',
                    patch({ valueEncrypted: envelope(`round-${round}`) }),
                );
                expect(row.version).toBe(round);
            }

            expect((await stored(WORK_A, 'JWT_SECRET'))?.version).toBe(6);
        });

        it('bumps in SQL (`"version" + 1`), so two writers cannot both read 1', async () => {
            await repository.insertIfAbsent(input());
            const captured: string[] = [];
            const spy = jest
                .spyOn(UpdateQueryBuilder.prototype, 'execute')
                .mockImplementation(function (this: UpdateQueryBuilder<WorkAppEnvValue>) {
                    captured.push(this.getQuery());
                    return Promise.resolve({ raw: [], affected: 1, generatedMaps: [] });
                });
            try {
                await repository.upsertValue(WORK_A, 'JWT_SECRET', patch());
            } finally {
                spy.mockRestore();
            }

            expect(captured).toHaveLength(1);
            expect(captured[0]).toContain('"version" + 1');
        });

        it('serialises ten concurrent writes into ten distinct versions', async () => {
            await repository.insertIfAbsent(input());

            await Promise.all(
                Array.from({ length: 10 }, (_unused, index) =>
                    repository.upsertValue(
                        WORK_A,
                        'JWT_SECRET',
                        patch({ valueEncrypted: envelope(`concurrent-${index}`) }),
                    ),
                ),
            );

            expect((await stored(WORK_A, 'JWT_SECRET'))?.version).toBe(11);
        });

        it('touches one name of one Work only', async () => {
            await repository.insertIfAbsent(input());
            await repository.insertIfAbsent(input({ name: 'APP_KEY' }));
            await repository.insertIfAbsent(input({ workId: WORK_B, name: 'JWT_SECRET' }));

            await repository.upsertValue(WORK_A, 'JWT_SECRET', patch());

            expect((await stored(WORK_A, 'JWT_SECRET'))?.version).toBe(2);
            expect((await stored(WORK_A, 'APP_KEY'))?.version).toBe(1);
            expect((await stored(WORK_B, 'JWT_SECRET'))?.version).toBe(1);
        });

        it('never stores the envelope it replaced', async () => {
            await repository.insertIfAbsent(input());

            await repository.upsertValue(WORK_A, 'JWT_SECRET', patch());

            const row = await stored(WORK_A, 'JWT_SECRET');
            expect(row?.valueEncrypted).not.toBe(envelope('first-writer'));
        });
    });

    describe('deleteNames', () => {
        it('removes exactly the named rows of one App Work and reports the count', async () => {
            await repository.insertIfAbsent(input({ name: 'JWT_SECRET' }));
            await repository.insertIfAbsent(input({ name: 'APP_KEY' }));
            await repository.insertIfAbsent(input({ name: 'KEEP_ME' }));

            await expect(repository.deleteNames(WORK_A, ['JWT_SECRET', 'APP_KEY'])).resolves.toBe(
                2,
            );

            const remaining = await repository.findByWork(WORK_A);
            expect(remaining.map((row) => row.name)).toEqual(['KEEP_ME']);
        });

        it('leaves another App Work’s same-named row alone', async () => {
            await repository.insertIfAbsent(input());
            await repository.insertIfAbsent(input({ workId: WORK_B }));

            await repository.deleteNames(WORK_A, ['JWT_SECRET']);

            expect(await stored(WORK_B, 'JWT_SECRET')).not.toBeNull();
        });

        it('ignores a name that has no row, a duplicate name and an empty call', async () => {
            await repository.insertIfAbsent(input());

            await expect(repository.deleteNames(WORK_A, ['NOT_SET'])).resolves.toBe(0);
            await expect(
                repository.deleteNames(WORK_A, ['JWT_SECRET', 'JWT_SECRET']),
            ).resolves.toBe(1);
            await expect(repository.deleteNames(WORK_A, [])).resolves.toBe(0);
            expect(await repository.findByWork(WORK_A)).toEqual([]);
        });
    });

    describe('totals (FR-31 — the 1 MiB ceiling and the 300-row ceiling)', () => {
        it('sums the stored bytes and counts the rows of one App Work', async () => {
            await repository.insertIfAbsent(input({ name: 'A', valueBytes: 10 }));
            await repository.insertIfAbsent(input({ name: 'B', valueBytes: 32 }));
            await repository.insertIfAbsent(
                input({ workId: WORK_B, name: 'C', valueBytes: 1_000 }),
            );

            await expect(repository.totals(WORK_A)).resolves.toEqual({ count: 2, bytes: 42 });
        });

        it('reports zero for an App Work with no values', async () => {
            await expect(repository.totals(WORK_B)).resolves.toEqual({ count: 0, bytes: 0 });
        });

        it('counts a row whose value is empty at zero bytes', async () => {
            await repository.insertIfAbsent(input({ valueBytes: 0 }));

            await expect(repository.totals(WORK_A)).resolves.toEqual({ count: 1, bytes: 0 });
        });
    });
});
