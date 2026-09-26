import { DataSource } from 'typeorm';
import { APP_LAUNCHER_MAX_PREFERENCE_ROWS } from '@ever-works/contracts';
import { AppLauncherPreference } from '../../../entities/app-launcher-preference.entity';
import { ENTITIES } from '../../_entities-inventory';
import { AppLauncherPreferenceRepository } from '../app-launcher-preference.repository';

/**
 * APW-11 T5 — the preference repository, executed against a real (in-memory
 * better-sqlite3) database so the upsert's `ON CONFLICT … DO UPDATE`, the
 * unique constraint and the prune are the ones production runs, not a mock of
 * them. The pattern is the package's own
 * (`model-account.repository.integration.spec.ts`).
 *
 * Spec FR-28 (`spec.md:294-295`) and FR-29 (`spec.md:296-297`); ACC-11-20
 * ("two tabs changing different tiles both persist; the same tile resolves to
 * the last write"); plan §4.2 steps 3-5.
 *
 * Every uuid below is obviously synthetic and every host is a reserved
 * documentation name.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const PLATFORM_KEY = 'platform:ever-gauzy';
const WORK_A = 'work:cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const WORK_B = 'work:dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('AppLauncherPreferenceRepository', () => {
    let dataSource: DataSource;
    let preferences: AppLauncherPreferenceRepository;

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
        preferences = new AppLauncherPreferenceRepository(
            dataSource.getRepository(AppLauncherPreference),
        );
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(AppLauncherPreference).clear();
    });

    const rows = () =>
        dataSource.getRepository(AppLauncherPreference).find({ order: { itemKey: 'ASC' } });

    /** Pin one row's `updatedAt`, which is FR-62's pin-time tie-break. */
    const stamp = (itemKey: string, iso: string) =>
        dataSource.query(
            `UPDATE "app_launcher_preferences" SET "updatedAt" = ? WHERE "itemKey" = ?`,
            [iso, itemKey],
        );

    /** better-sqlite3 stores a boolean as 0/1; read it either way. */
    const isTrue = (value: unknown): boolean => value === true || Number(value) === 1;
    const isFalse = (value: unknown): boolean => value === false || Number(value) === 0;

    describe('the stored shape', () => {
        it('refuses a second row for the same (userId, scopeKey, itemKey) — plan §3.2:220', async () => {
            await preferences.upsertMany(USER, [
                { scopeKey: ORG_A, itemKey: WORK_A, pinned: true, pinOrder: 0 },
            ]);

            await expect(
                dataSource.getRepository(AppLauncherPreference).save(
                    dataSource.getRepository(AppLauncherPreference).create({
                        userId: USER,
                        scopeKey: ORG_A,
                        itemKey: WORK_A,
                        visible: true,
                        pinned: false,
                    }),
                ),
            ).rejects.toThrow();

            expect(await rows()).toHaveLength(1);
        });

        it('allows the same item key in two different scopes — FR-24', async () => {
            await preferences.upsertMany(USER, [
                { scopeKey: ORG_A, itemKey: WORK_A, pinned: true, pinOrder: 0 },
                { scopeKey: ORG_B, itemKey: WORK_A, pinned: false },
                { scopeKey: 'global', itemKey: PLATFORM_KEY, pinned: true, pinOrder: 1 },
            ]);

            expect(await rows()).toHaveLength(3);
        });

        it('starts a row shown and not pinned when the caller omits both', async () => {
            await preferences.upsertMany(USER, [{ scopeKey: ORG_A, itemKey: WORK_A }]);

            const [row] = await rows();
            expect(isTrue(row.visible)).toBe(true);
            expect(isFalse(row.pinned)).toBe(true);
            expect(row.pinOrder ?? null).toBeNull();
            expect(row.sortOrder ?? null).toBeNull();
        });
    });

    describe('upsertMany', () => {
        it('persists two writers changing different items (ACC-11-20)', async () => {
            // Two tabs, two different tiles. Both saves must land.
            await preferences.upsertMany(USER, [
                { scopeKey: ORG_A, itemKey: WORK_A, pinned: true, pinOrder: 0 },
            ]);
            await preferences.upsertMany(USER, [
                { scopeKey: ORG_A, itemKey: WORK_B, visible: false },
            ]);

            const stored = await rows();
            expect(stored.map((row) => [row.itemKey, row.pinned, row.visible])).toEqual([
                [WORK_A, true, true],
                [WORK_B, false, false],
            ]);
        });

        it('gives the same item to the last write (ACC-11-20)', async () => {
            await preferences.upsertMany(USER, [
                { scopeKey: ORG_A, itemKey: WORK_A, pinned: true, pinOrder: 0 },
            ]);
            await preferences.upsertMany(USER, [
                { scopeKey: ORG_A, itemKey: WORK_A, pinned: false, sortOrder: 4 },
            ]);

            const stored = await rows();
            expect(stored).toHaveLength(1);
            expect(isFalse(stored[0].pinned)).toBe(true);
            expect(Number(stored[0].sortOrder)).toBe(4);
        });

        it('changes nothing when the same values are re-sent (FR-29)', async () => {
            await preferences.upsertMany(USER, [
                { scopeKey: ORG_A, itemKey: WORK_A, visible: false, pinned: true, pinOrder: 2 },
            ]);
            const [before] = await rows();

            await preferences.upsertMany(USER, [
                { scopeKey: ORG_A, itemKey: WORK_A, visible: false, pinned: true, pinOrder: 2 },
            ]);
            const [after] = await rows();

            expect(after.id).toBe(before.id);
            expect(after).toMatchObject({
                visible: before.visible,
                pinned: before.pinned,
                pinOrder: before.pinOrder,
                sortOrder: before.sortOrder,
            });
        });

        it('refreshes the pin time, which FR-62 reads as the pin-time tie-break', async () => {
            await preferences.upsertMany(USER, [
                { scopeKey: ORG_A, itemKey: WORK_A, pinned: true, pinOrder: 0 },
            ]);
            await stamp(WORK_A, '2020-01-01T00:00:00.000Z');

            await preferences.upsertMany(USER, [
                { scopeKey: ORG_A, itemKey: WORK_A, pinned: true, pinOrder: 0 },
            ]);

            const [row] = await rows();
            expect(new Date(row.updatedAt as unknown as string).getUTCFullYear()).toBeGreaterThan(
                2020,
            );
        });

        it('writes the last of two changes for one item inside a single call', async () => {
            // A batch built from a UI can legitimately name one item twice; a
            // single INSERT cannot touch the same conflict target twice.
            await preferences.upsertMany(USER, [
                { scopeKey: ORG_A, itemKey: WORK_A, pinned: true, pinOrder: 0 },
                { scopeKey: ORG_A, itemKey: WORK_A, pinned: false, sortOrder: 7 },
            ]);

            const stored = await rows();
            expect(stored).toHaveLength(1);
            expect(isFalse(stored[0].pinned)).toBe(true);
        });

        it('is a no-op for an empty batch or a missing user', async () => {
            await expect(preferences.upsertMany(USER, [])).resolves.toBe(0);
            await expect(
                preferences.upsertMany('', [{ scopeKey: ORG_A, itemKey: WORK_A }]),
            ).resolves.toBe(0);
            expect(await rows()).toHaveLength(0);
        });

        it("writes only the caller's own rows", async () => {
            await preferences.upsertMany(USER, [
                { scopeKey: ORG_A, itemKey: WORK_A, pinned: true, pinOrder: 0 },
            ]);
            await preferences.upsertMany(OTHER_USER, [
                { scopeKey: ORG_A, itemKey: WORK_B, pinned: true, pinOrder: 0 },
            ]);

            expect((await rows()).map((row) => row.userId)).toEqual([USER, OTHER_USER]);
        });
    });

    describe('findForUser', () => {
        it("returns only the requested scopes, so B never appears in A's read (FR-62)", async () => {
            await preferences.upsertMany(USER, [
                { scopeKey: 'global', itemKey: PLATFORM_KEY, pinned: true, pinOrder: 0 },
                { scopeKey: ORG_A, itemKey: WORK_A, pinned: true, pinOrder: 1 },
                { scopeKey: ORG_B, itemKey: WORK_B, pinned: true, pinOrder: 0 },
            ]);

            const forA = await preferences.findForUser(USER, ['global', ORG_A]);
            expect(forA.map((row) => row.itemKey).sort()).toEqual([PLATFORM_KEY, WORK_A].sort());

            const forB = await preferences.findForUser(USER, ['global', ORG_B]);
            expect(forB.map((row) => row.itemKey).sort()).toEqual([PLATFORM_KEY, WORK_B].sort());
        });

        it("never returns another person's rows (FR-53)", async () => {
            await preferences.upsertMany(OTHER_USER, [
                { scopeKey: ORG_A, itemKey: WORK_A, pinned: true, pinOrder: 0 },
            ]);

            expect(await preferences.findForUser(USER, ['global', ORG_A])).toEqual([]);
        });

        it('orders by updatedAt ascending, then itemKey — the pin-time order', async () => {
            await preferences.upsertMany(USER, [
                { scopeKey: ORG_A, itemKey: WORK_A, pinned: true, pinOrder: 0 },
                { scopeKey: ORG_A, itemKey: WORK_B, pinned: true, pinOrder: 1 },
                { scopeKey: 'global', itemKey: PLATFORM_KEY, pinned: true, pinOrder: 2 },
            ]);
            await stamp(WORK_B, '2026-01-01T00:00:00.000Z');
            await stamp(PLATFORM_KEY, '2026-02-01T00:00:00.000Z');
            await stamp(WORK_A, '2026-03-01T00:00:00.000Z');

            const stored = await preferences.findForUser(USER, ['global', ORG_A]);
            expect(stored.map((row) => row.itemKey)).toEqual([WORK_B, PLATFORM_KEY, WORK_A]);
        });

        it('breaks a same-timestamp tie by itemKey, so two reads agree', async () => {
            await preferences.upsertMany(USER, [
                { scopeKey: ORG_A, itemKey: WORK_B },
                { scopeKey: ORG_A, itemKey: WORK_A },
            ]);
            await stamp(WORK_B, '2026-01-01T00:00:00.000Z');
            await stamp(WORK_A, '2026-01-01T00:00:00.000Z');

            const first = await preferences.findForUser(USER, ['global', ORG_A]);
            const second = await preferences.findForUser(USER, ['global', ORG_A]);
            expect(first.map((row) => row.itemKey)).toEqual([WORK_A, WORK_B]);
            expect(second.map((row) => row.itemKey)).toEqual(first.map((row) => row.itemKey));
        });

        it('returns nothing for an empty scope list or a missing user', async () => {
            await preferences.upsertMany(USER, [{ scopeKey: ORG_A, itemKey: WORK_A }]);

            expect(await preferences.findForUser(USER, [])).toEqual([]);
            expect(await preferences.findForUser('', ['global', ORG_A])).toEqual([]);
        });
    });

    describe('countPinned', () => {
        it('counts only the pinned rows of the merged view (FR-25, FR-62)', async () => {
            await preferences.upsertMany(USER, [
                { scopeKey: 'global', itemKey: PLATFORM_KEY, pinned: true, pinOrder: 0 },
                { scopeKey: ORG_A, itemKey: WORK_A, pinned: true, pinOrder: 1 },
                { scopeKey: ORG_A, itemKey: WORK_B, pinned: false },
                { scopeKey: ORG_B, itemKey: WORK_B, pinned: true, pinOrder: 0 },
            ]);

            expect(await preferences.countPinned(USER, ['global', ORG_A])).toBe(2);
            expect(await preferences.countPinned(USER, ['global', ORG_B])).toBe(2);
            expect(await preferences.countPinned(USER, ['global'])).toBe(1);
        });

        it('is zero for a person with no rows and for an empty scope list', async () => {
            expect(await preferences.countPinned(USER, ['global', ORG_A])).toBe(0);
            expect(await preferences.countPinned(USER, [])).toBe(0);
        });

        it('counts inside a transaction when a manager is supplied', async () => {
            await preferences.upsertMany(USER, [
                { scopeKey: ORG_A, itemKey: WORK_A, pinned: true, pinOrder: 0 },
            ]);

            const inTransaction = await dataSource.manager.transaction((manager) =>
                preferences.countPinned(USER, ['global', ORG_A], manager),
            );
            expect(inTransaction).toBe(1);
        });
    });

    describe("pruneIneligible — FR-28's 500-row ceiling", () => {
        /** Fill a person up to the ceiling, half of it ineligible. */
        async function fillToCeiling(): Promise<void> {
            const batch = Array.from({ length: APP_LAUNCHER_MAX_PREFERENCE_ROWS }, (_, index) => ({
                scopeKey: ORG_A,
                itemKey: `work:${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
            }));
            // Chunked: one 500-row INSERT would bind far more parameters than a
            // conservative SQLite build allows in a single statement.
            for (let index = 0; index < batch.length; index += 100) {
                await preferences.upsertMany(USER, batch.slice(index, index + 100));
            }
        }

        it('does nothing while the person is at or below the ceiling', async () => {
            await preferences.upsertMany(USER, [{ scopeKey: ORG_A, itemKey: WORK_A }]);

            await expect(preferences.pruneIneligible(USER, [WORK_A])).resolves.toBe(0);
            expect(await rows()).toHaveLength(1);
        });

        it('removes the oldest ineligible rows once the person passes the ceiling', async () => {
            await fillToCeiling();
            // One more row, so there is exactly one row to remove.
            await preferences.upsertMany(USER, [{ scopeKey: ORG_A, itemKey: WORK_B }]);
            await stamp(WORK_B, '2019-01-01T00:00:00.000Z');

            const eligible = Array.from(
                { length: APP_LAUNCHER_MAX_PREFERENCE_ROWS },
                (_, index) => `work:${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
            );

            const removed = await preferences.pruneIneligible(USER, eligible);

            expect(removed).toBe(1);
            expect(await rows()).toHaveLength(APP_LAUNCHER_MAX_PREFERENCE_ROWS);
            // The oldest ineligible row went, and every eligible row stayed.
            expect((await rows()).map((row) => row.itemKey)).not.toContain(WORK_B);
        });

        it('never prunes an eligible row, even one that is older than the ceiling', async () => {
            await fillToCeiling();
            await preferences.upsertMany(USER, [{ scopeKey: ORG_A, itemKey: WORK_B }]);
            await stamp(WORK_B, '2019-01-01T00:00:00.000Z');

            const eligible = [WORK_B];
            const removed = await preferences.pruneIneligible(USER, eligible);

            // 501 rows, 500 of them ineligible, one over the ceiling: exactly one
            // goes, and it is not the eligible one.
            expect(removed).toBe(1);
            expect((await rows()).map((row) => row.itemKey)).toContain(WORK_B);
        });

        it('refuses to prune at all when the eligible set could not be resolved', async () => {
            await fillToCeiling();
            await preferences.upsertMany(USER, [{ scopeKey: ORG_A, itemKey: WORK_B }]);

            // An empty eligible set means "nothing could be resolved", not
            // "nothing is eligible" — deleting on that answer would destroy an
            // arrangement during a catalog outage.
            await expect(preferences.pruneIneligible(USER, [])).resolves.toBe(0);
            expect(await rows()).toHaveLength(APP_LAUNCHER_MAX_PREFERENCE_ROWS + 1);
        });

        it("leaves another person's rows alone", async () => {
            await fillToCeiling();
            await preferences.upsertMany(OTHER_USER, [
                { scopeKey: ORG_A, itemKey: WORK_B },
                { scopeKey: ORG_A, itemKey: WORK_A },
            ]);

            await preferences.pruneIneligible(USER, []);

            expect(
                (await rows()).filter((row) => row.userId === OTHER_USER).map((row) => row.itemKey),
            ).toEqual([WORK_A, WORK_B]);
        });
    });
});
