import { DataSource } from 'typeorm';
import { WorkBuildPreparation } from '../../../entities/work-build-preparation.entity';
import { ENTITIES } from '../../_entities-inventory';
import { AppBuildPreparationRepository } from '../app-build-preparation.repository';

/**
 * APW-05 T6 — the `work_build_preparations` repository, executed against a real
 * (in-memory better-sqlite3) database: the unique index on `workId`, the create
 * path's defaults and the merge path are the ones production runs.
 *
 * `APW05-G03` is the property the spec is built around: ONE row per App Work,
 * MERGED into by every prepare, and never bumped by this repository —
 * `prepareSeq` belongs to `requestPrepare`, and a result path that advanced it
 * would make the coalescing of §7.2 observe its own write.
 *
 * The PostgreSQL leg is NOT run here: no container is available in this
 * environment (see the report's cross-driver section). The unique-violation
 * detection is asserted per driver spelling in `app-build.repository.spec.ts`.
 */

const WORK_A = '11111111-1111-4111-8111-111111111111';
const WORK_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const NOW = Date.parse('2026-03-01T06:00:00.000Z');

describe('AppBuildPreparationRepository', () => {
    let dataSource: DataSource;
    let repository: AppBuildPreparationRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        repository = new AppBuildPreparationRepository(
            dataSource.getRepository(WorkBuildPreparation),
        );
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.query('PRAGMA foreign_keys = OFF');
        await dataSource.getRepository(WorkBuildPreparation).clear();
        await dataSource.query('DELETE FROM "works"');
        await dataSource.query(
            `INSERT INTO "works" ("id", "name", "slug", "userId", "description", "kind")
             VALUES ('${WORK_A}', 'App A', 'app-a', '${USER_A}', '', 'app'),
                    ('${WORK_B}', 'App B', 'app-b', '${USER_A}', '', 'app')`,
        );
    });

    /** Re-read a row from the database, never from the object a method returned. */
    async function stored(workId: string): Promise<WorkBuildPreparation> {
        return dataSource.getRepository(WorkBuildPreparation).findOneOrFail({ where: { workId } });
    }

    async function count(): Promise<number> {
        return dataSource.getRepository(WorkBuildPreparation).count();
    }

    describe('findByWork', () => {
        it('returns null for an App Work no prepare has touched', async () => {
            expect(await repository.findByWork(WORK_A)).toBeNull();
        });

        it('returns the row once one exists', async () => {
            await repository.upsertAfterPrepare(WORK_A, { buildPluginId: 'github-actions' });

            const row = await repository.findByWork(WORK_A);

            expect(row?.workId).toBe(WORK_A);
            expect(row?.buildPluginId).toBe('github-actions');
        });
    });

    describe('upsertAfterPrepare — the create path', () => {
        it('creates the row on the first prepare, on the plan’s defaults', async () => {
            const created = await repository.upsertAfterPrepare(WORK_A, {
                buildPluginId: 'github-actions',
                workflowState: 'committed',
            });

            const row = await stored(WORK_A);
            expect(row.id).toBe(created.id);
            expect(row.workflowState).toBe('committed');
            // plan §3.1b:411-418 — the values a Work with no webhook and no
            // coalescing history starts with.
            expect(row.webhookState).toBe('none');
            expect(row.prepareSeq).toBe(0);
            expect(row.buildInputsHash).toBeNull();
            expect(row.secretsSyncedAt).toBeNull();
            expect(row.buildSecretNames).toBeNull();
            expect(row.workflowSha256).toBeNull();
            expect(row.runsEtag).toBeNull();
            expect(await count()).toBe(1);
        });

        it('refuses to create a row without a buildPluginId, loudly', async () => {
            await expect(repository.upsertAfterPrepare(WORK_A, {})).rejects.toThrow(
                'buildPluginId is required to create a preparation row',
            );
            expect(await count()).toBe(0);
        });

        it('stores the secret names and the sync clock the consumer stamps a Build from', async () => {
            const syncedAt = new Date(NOW);

            await repository.upsertAfterPrepare(WORK_A, {
                buildPluginId: 'github-actions',
                buildInputsHash: 'e'.repeat(64),
                buildSecretNames: ['EW_DATABASE_URL'],
                secretsSyncedAt: syncedAt,
            });

            const row = await stored(WORK_A);
            expect(row.buildInputsHash).toBe('e'.repeat(64));
            expect(row.buildSecretNames).toEqual(['EW_DATABASE_URL']);
            expect(row.secretsSyncedAt?.getTime()).toBe(syncedAt.getTime());
        });

        it('stores a sync that wrote zero values — the hash of the empty list, not NULL', async () => {
            // plan §3.1b:407-409: the stamp is written even with 0 values, and
            // NULL would mean "no sync has ever completed", which is a different
            // fact the deployable verdict depends on.
            const emptyHash = 'f'.repeat(64);

            await repository.upsertAfterPrepare(WORK_A, {
                buildPluginId: 'github-actions',
                buildInputsHash: emptyHash,
                buildSecretNames: [],
                secretsSyncedAt: new Date(NOW),
            });

            const row = await stored(WORK_A);
            expect(row.buildInputsHash).toBe(emptyHash);
            expect(row.buildSecretNames).toEqual([]);
            expect(row.secretsSyncedAt).not.toBeNull();
        });

        it('keeps one row per App Work, and unrelated Works separate', async () => {
            await repository.upsertAfterPrepare(WORK_A, { buildPluginId: 'github-actions' });
            await repository.upsertAfterPrepare(WORK_B, { buildPluginId: 'apps-builder' });

            expect(await count()).toBe(2);
            expect((await stored(WORK_A)).buildPluginId).toBe('github-actions');
            expect((await stored(WORK_B)).buildPluginId).toBe('apps-builder');
        });
    });

    describe('upsertAfterPrepare — the merge path', () => {
        beforeEach(async () => {
            await repository.upsertAfterPrepare(WORK_A, {
                buildPluginId: 'github-actions',
                buildInputsHash: 'a'.repeat(64),
                buildSecretNames: ['EW_ONE'],
                secretsSyncedAt: new Date(NOW),
                workflowState: 'pullRequestOpen',
                workflowPullRequestNumber: 5,
                workflowPullRequestUrl: 'https://github.com/ever-works/demo/pull/5',
                workflowSha256: 'b'.repeat(64),
            });
        });

        it('merges into the existing row rather than creating a second one', async () => {
            const merged = await repository.upsertAfterPrepare(WORK_A, {
                buildPluginId: 'github-actions',
                workflowState: 'committed',
            });

            expect(await count()).toBe(1);
            expect(merged.workflowState).toBe('committed');
            // The columns the patch did not name are untouched.
            const row = await stored(WORK_A);
            expect(row.workflowPullRequestNumber).toBe(5);
            expect(row.buildInputsHash).toBe('a'.repeat(64));
            expect(row.workflowSha256).toBe('b'.repeat(64));
        });

        it('accepts a patch with no buildPluginId when the row already exists', async () => {
            await expect(
                repository.upsertAfterPrepare(WORK_A, { webhookState: 'installed' }),
            ).resolves.toBeDefined();

            expect(await count()).toBe(1);
            expect((await stored(WORK_A)).webhookState).toBe('installed');
        });

        it('moves the run-discovery cursor without disturbing the workflow state', async () => {
            const checkedAt = new Date(NOW + 60_000);

            await repository.upsertAfterPrepare(WORK_A, {
                runsEtag: 'W/"abc123"',
                runsCheckedAt: checkedAt,
            });

            const row = await stored(WORK_A);
            expect(row.runsEtag).toBe('W/"abc123"');
            expect(row.runsCheckedAt?.getTime()).toBe(checkedAt.getTime());
            expect(row.workflowState).toBe('pullRequestOpen');
        });

        it('stores a repository-level block such as actionsDisabled', async () => {
            const block = { reason: 'actionsDisabled', detail: 'fork', at: NOW };

            await repository.upsertAfterPrepare(WORK_A, { repositoryBlock: block });

            const row = await stored(WORK_A);
            expect(row.repositoryBlock).toEqual(block);
        });

        it('NEVER bumps prepareSeq — that column belongs to requestPrepare', async () => {
            await dataSource
                .getRepository(WorkBuildPreparation)
                .update({ workId: WORK_A }, { prepareSeq: 4 });

            await repository.upsertAfterPrepare(WORK_A, {
                workflowState: 'committed',
                lastPreparedAt: new Date(NOW),
            });
            await repository.upsertAfterPrepare(WORK_A, { webhookState: 'installed' });

            // A result path that advanced the marker would make §7.2's
            // before/after comparison observe its own write and never converge.
            expect((await stored(WORK_A)).prepareSeq).toBe(4);
        });

        it('a prepare row write never reverts a prepareSeq bump that lands between its read and its write', async () => {
            // The race of §7.2: `requestPrepare` bumps the marker while the
            // holder's `upsertAfterPrepare` is between its read and its write.
            // A whole-entity save writes the STALE marker it read back, and the
            // holder's after-release re-read then sees no movement: the request
            // is lost.
            const preparations = dataSource.getRepository(WorkBuildPreparation);
            const findSpy = jest
                .spyOn(repository, 'findByWork')
                .mockImplementationOnce(async (workId: string) => {
                    const read = await preparations.findOne({ where: { workId } });
                    await preparations.update({ workId }, { prepareSeq: 7 });
                    return read;
                });

            await repository.upsertAfterPrepare(WORK_A, { workflowState: 'committed' });
            findSpy.mockRestore();

            const row = await stored(WORK_A);
            expect(row.prepareSeq).toBe(7);
            expect(row.workflowState).toBe('committed');
        });

        it('a prepareSeq bump never reverts a workflow state written between its read and its write', async () => {
            // The mirror: the requester's bump is a patch of its own, and must not
            // put back the `workflowState` a prepare stored in the meantime.
            const preparations = dataSource.getRepository(WorkBuildPreparation);
            const findSpy = jest
                .spyOn(repository, 'findByWork')
                .mockImplementationOnce(async (workId: string) => {
                    const read = await preparations.findOne({ where: { workId } });
                    await preparations.update({ workId }, { workflowState: 'committed' });
                    return read;
                });

            await repository.upsertAfterPrepare(WORK_A, {
                buildPluginId: 'github-actions',
                prepareSeq: 5,
            });
            findSpy.mockRestore();

            const row = await stored(WORK_A);
            expect(row.prepareSeq).toBe(5);
            expect(row.workflowState).toBe('committed');
            // The columns neither writer named are untouched.
            expect(row.workflowPullRequestNumber).toBe(5);
            expect(row.buildSecretNames).toEqual(['EW_ONE']);
        });

        it('a patch whose every value is undefined writes nothing', async () => {
            const before = await stored(WORK_A);

            const answered = await repository.upsertAfterPrepare(WORK_A, {
                workflowState: undefined,
            });

            const after = await stored(WORK_A);
            expect(answered.id).toBe(before.id);
            expect(after.workflowState).toBe('pullRequestOpen');
            expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
        });

        it('clears a nullable column when the prepare says the value is gone', async () => {
            await repository.upsertAfterPrepare(WORK_A, {
                workflowSha256: null,
                secretsSyncedAt: null,
                buildSecretNames: null,
            });

            const row = await stored(WORK_A);
            expect(row.workflowSha256).toBeNull();
            expect(row.secretsSyncedAt).toBeNull();
            expect(row.buildSecretNames).toBeNull();
        });
    });

    describe('concurrency and the unique violation', () => {
        it('converges on one row when several prepares race', async () => {
            const results = await Promise.all(
                Array.from({ length: 5 }, (_, index) =>
                    repository.upsertAfterPrepare(WORK_A, {
                        buildPluginId: 'github-actions',
                        runsEtag: `etag-${index}`,
                    }),
                ),
            );

            expect(await count()).toBe(1);
            expect(new Set(results.map((row) => row.id)).size).toBe(1);
        });

        it('merges into the winner when the insert loses the race for the unique index', async () => {
            // Force the exact race the catch block exists for: the READ finds
            // nothing (the row is created by another prepare right after it), and
            // the insert then loses to the unique index. Without the catch this
            // is a hard failure for a prepare that did nothing wrong.
            const winner = await repository.upsertAfterPrepare(WORK_A, {
                buildPluginId: 'github-actions',
            });
            const findSpy = jest.spyOn(repository, 'findByWork').mockResolvedValueOnce(null);
            const saveSpy = jest
                .spyOn(dataSource.getRepository(WorkBuildPreparation), 'save')
                .mockRejectedValueOnce(
                    Object.assign(
                        new Error('UNIQUE constraint failed: work_build_preparations.workId'),
                        { code: 'SQLITE_CONSTRAINT_UNIQUE' },
                    ),
                );

            const merged = await repository.upsertAfterPrepare(WORK_A, {
                buildPluginId: 'github-actions',
                webhookState: 'installed',
            });

            findSpy.mockRestore();
            saveSpy.mockRestore();
            expect(merged.id).toBe(winner.id);
            expect(await count()).toBe(1);
            expect((await stored(WORK_A)).webhookState).toBe('installed');
        });
    });
});
