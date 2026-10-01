import { DataSource } from 'typeorm';
import { AppLauncherPinLimitError } from '../app-launcher.errors';
import { AppLauncherPreference } from '../../entities/app-launcher-preference.entity';
import { WorkCustomDomain } from '../../entities/work-custom-domain.entity';
import { DeploymentEnvironment, WorkDeployment } from '../../entities/work-deployment.entity';
import { WorkMember } from '../../entities/work-member.entity';
import { Work } from '../../entities/work.entity';
import { ENTITIES } from '../../database/_entities-inventory';
import { AppLauncherPreferenceRepository } from '../../database/repositories/app-launcher-preference.repository';
import { WorkCustomDomainRepository } from '../../database/repositories/work-custom-domain.repository';
import { WorkDeploymentRepository } from '../../database/repositories/work-deployment.repository';
import { WorkMemberRepository } from '../../database/repositories/work-member.repository';
import { WorkRepository } from '../../database/repositories/work.repository';
import { AppLauncherService, type AppLauncherPlatformInput } from '../app-launcher.service';
import { DefaultManagedHostRootResolver } from '../managed-host-root.resolver';

/**
 * APW-11 T6 — the write path of `AppLauncherService` (plan §4.2, §4.5).
 *
 * Covers ACC-11-06, ACC-11-19, ACC-11-21, ACC-11-22 and ACC-11-47, plus the
 * merge-patch, pin-order, whole-save-refusal and 500-row-prune rules of the
 * plan's `app-launcher.save.spec.ts` row (`plan.md:941`).
 *
 * Like the read spec, the service runs on real repositories over a real
 * in-memory better-sqlite3 database, so "nothing was saved" is asserted against
 * the rows that are actually there — not against a mock's call log. The
 * transaction the plan requires is the same object the service is handed, so the
 * refusal path is exercised through a real transaction.
 *
 * Every host is a reserved documentation name (RFC 2606 `.test`).
 */

const USER = '11111111-1111-4111-8111-111111111111';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const APPS_APEX = 'apps.example.test';
const PLATFORM_ROOT = 'works.example.test';
const SELF_KEY = 'platform:ever-works';

const ENV_KEYS = [
    'EVER_WORKS_DOMAIN',
    'EVER_WORKS_APPS_DOMAIN',
    'EVER_WORKS_APP_WORKS_ENABLED',
    'EVER_WORKS_PLATFORM_CATALOG_SELF_ID',
] as const;

/** The preference shape a save is asserted against. */
interface StoredRow {
    scopeKey: string;
    itemKey: string;
    visible: boolean;
    pinned: boolean;
    pinOrder: number | null;
    sortOrder: number | null;
    updatedAt: Date;
}

describe('AppLauncherService.savePreferences (APW-11 T6)', () => {
    const savedEnv = new Map<string, string | undefined>();
    let dataSource: DataSource;
    let sequence = 0;

    beforeAll(async () => {
        for (const key of ENV_KEYS) {
            savedEnv.set(key, process.env[key]);
        }
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
    });

    afterAll(async () => {
        for (const key of ENV_KEYS) {
            const value = savedEnv.get(key);
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        await dataSource.destroy();
    });

    beforeEach(async () => {
        process.env.EVER_WORKS_DOMAIN = PLATFORM_ROOT;
        process.env.EVER_WORKS_APPS_DOMAIN = APPS_APEX;
        delete process.env.EVER_WORKS_APP_WORKS_ENABLED;
        delete process.env.EVER_WORKS_PLATFORM_CATALOG_SELF_ID;

        await dataSource.query('DELETE FROM "app_launcher_preferences"');
        await dataSource.query('DELETE FROM "work_deployments"');
        await dataSource.query('DELETE FROM "work_custom_domains"');
        await dataSource.query('DELETE FROM "works"');
    });

    // ── fixtures and helpers ────────────────────────────────────────────────

    async function makeWork(
        options: { organizationId?: string | null; kind?: string; name?: string } = {},
    ): Promise<string> {
        sequence += 1;
        const works = dataSource.getRepository(Work);
        const saved = await works.save(
            works.create({
                userId: USER,
                name: options.name ?? `Work ${sequence}`,
                slug: `work-${sequence}`,
                description: `Launcher fixture ${sequence}`,
                kind: options.kind ?? 'app',
                status: 'active',
                organizationId: options.organizationId ?? null,
                managedSubdomain: `label-${sequence}`,
                appLauncherExposed: null,
            } as Partial<Work>),
        );
        const deployments = dataSource.getRepository(WorkDeployment);
        await deployments.save(
            deployments.create({
                workId: saved.id,
                environment: DeploymentEnvironment.PRODUCTION,
                provider: 'ever-works',
                state: 'READY',
                website: `https://label-${sequence}.${APPS_APEX}/`,
            } as Partial<WorkDeployment>),
        );
        return saved.id;
    }

    function service(): AppLauncherService {
        return new AppLauncherService(
            new WorkRepository(dataSource.getRepository(Work)),
            new WorkMemberRepository(dataSource.getRepository(WorkMember)),
            new WorkDeploymentRepository(dataSource.getRepository(WorkDeployment)),
            new WorkCustomDomainRepository(dataSource.getRepository(WorkCustomDomain)),
            preferences(),
            dataSource,
            new DefaultManagedHostRootResolver(),
        );
    }

    function preferences(): AppLauncherPreferenceRepository {
        return new AppLauncherPreferenceRepository(dataSource.getRepository(AppLauncherPreference));
    }

    function platforms(): AppLauncherPlatformInput[] {
        return [
            {
                key: SELF_KEY,
                name: 'Ever Works',
                url: 'https://works.example.test/',
                current: true,
                catalogOrder: 10,
            },
            {
                key: 'platform:ever-gauzy',
                name: 'Ever Gauzy',
                url: 'https://gauzy.example.test/',
                catalogOrder: 20,
            },
            {
                key: 'platform:cal-diy',
                name: 'Cal.diy',
                url: 'https://cal.example.test/',
                catalogOrder: 30,
            },
            {
                key: 'platform:ever-teams',
                name: 'Ever Teams',
                url: 'https://teams.example.test/',
                catalogOrder: 40,
            },
            {
                key: 'platform:ever-rec',
                name: 'Ever Rec',
                url: 'https://rec.example.test/',
                catalogOrder: 50,
            },
            {
                key: 'platform:ever-gauzy-2',
                name: 'Ever Gauzy Two',
                url: 'https://gauzy-two.example.test/',
                catalogOrder: 60,
            },
            {
                key: 'platform:ever-gauzy-3',
                name: 'Ever Gauzy Three',
                url: 'https://gauzy-three.example.test/',
                catalogOrder: 70,
            },
        ];
    }

    const personal = { organizationId: null };
    const orgA = { organizationId: ORG_A };
    const orgB = { organizationId: ORG_B };

    const keyOf = (workId: string) => `work:${workId}`;

    async function rows(userId: string = USER): Promise<StoredRow[]> {
        const found = await dataSource.getRepository(AppLauncherPreference).find({
            where: { userId },
            order: { scopeKey: 'ASC', itemKey: 'ASC' },
        });
        return found.map((row) => ({
            scopeKey: row.scopeKey,
            itemKey: row.itemKey,
            visible: row.visible,
            pinned: row.pinned,
            pinOrder: row.pinOrder ?? null,
            sortOrder: row.sortOrder ?? null,
            updatedAt: row.updatedAt,
        }));
    }

    // ── the current platform cannot be hidden (ACC-11-06) ───────────────────

    describe('the current platform (FR-13, ACC-11-06)', () => {
        it('refuses to hide the current platform and writes nothing (ACC-11-06)', async () => {
            const response = await service().savePreferences(
                USER,
                personal,
                [{ key: SELF_KEY, visible: false }],
                platforms(),
            );

            expect(response.rejected).toEqual([{ key: SELF_KEY, reason: 'cannotHideCurrent' }]);
            expect(response.saved).toBe(0);
            // No row was created for it, and the tile is still in the list.
            expect(await rows()).toEqual([]);
            expect(response.items.find((item) => item.key === SELF_KEY)).toMatchObject({
                current: true,
                visible: true,
            });
        });

        it('accepts every other change to the current platform', async () => {
            const response = await service().savePreferences(USER, personal, [
                { key: SELF_KEY, pinned: true, order: 0 },
            ]);

            expect(response.rejected).toEqual([]);
            expect(response.saved).toBe(1);
            expect(await rows()).toEqual([
                expect.objectContaining({
                    scopeKey: 'global',
                    itemKey: SELF_KEY,
                    pinned: true,
                    pinOrder: 0,
                    sortOrder: 0,
                }),
            ]);
        });
    });

    // ── the pin limit refuses the whole save (ACC-11-19, FR-25, FR-62) ──────

    describe('the six-pin limit (FR-25, FR-62, ACC-11-19)', () => {
        const sixPins = [
            'platform:ever-gauzy',
            'platform:cal-diy',
            'platform:ever-teams',
            'platform:ever-rec',
            'platform:ever-gauzy-2',
            'platform:ever-gauzy-3',
        ];

        it('refuses the whole save when a seventh pin would be added (ACC-11-19)', async () => {
            await preferences().upsertMany(
                USER,
                sixPins.map((itemKey, index) => ({
                    scopeKey: 'global',
                    itemKey,
                    pinned: true,
                    pinOrder: index,
                })),
            );
            const before = await rows();

            const workId = await makeWork();
            const outcome = await service()
                .savePreferences(USER, personal, [
                    { key: keyOf(workId), pinned: true },
                    // A second, entirely legal change in the same save: it must be
                    // refused too, because the save is refused as a whole.
                    { key: 'platform:ever-gauzy', visible: false },
                ])
                .catch((error: unknown) => error);

            expect(outcome).toBeInstanceOf(AppLauncherPinLimitError);
            expect((outcome as AppLauncherPinLimitError).code).toBe('pinLimit');
            expect((outcome as AppLauncherPinLimitError).limit).toBe(6);
            expect((outcome as AppLauncherPinLimitError).body).toEqual({
                code: 'pinLimit',
                limit: 6,
            });

            // Nothing at all was saved: not the seventh pin, not the hide.
            expect(await rows()).toEqual(before);
        });

        it('counts the merged view, so six Ever app pins block a Work pin in another Organization (FR-62)', async () => {
            await preferences().upsertMany(
                USER,
                sixPins.map((itemKey, index) => ({
                    scopeKey: 'global',
                    itemKey,
                    pinned: true,
                    pinOrder: index,
                })),
            );
            const workId = await makeWork({ organizationId: ORG_B });

            await expect(
                service().savePreferences(USER, orgB, [{ key: keyOf(workId), pinned: true }]),
            ).rejects.toBeInstanceOf(AppLauncherPinLimitError);

            // Organization B holds no pin of its own, and never will from this save.
            expect((await rows()).filter((row) => row.scopeKey === ORG_B)).toEqual([]);
        });

        it('lets a second Organization pin while the first holds six of its own Works (FR-62)', async () => {
            const workIds: string[] = [];
            for (let index = 0; index < 6; index += 1) {
                workIds.push(await makeWork({ organizationId: ORG_A }));
            }
            await preferences().upsertMany(
                USER,
                workIds.map((workId, index) => ({
                    scopeKey: ORG_A,
                    itemKey: keyOf(workId),
                    pinned: true,
                    pinOrder: index,
                })),
            );
            const beforeA = (await rows()).filter((row) => row.scopeKey === ORG_A);
            expect(beforeA).toHaveLength(6);

            const workB = await makeWork({ organizationId: ORG_B });
            const response = await service().savePreferences(USER, orgB, [
                { key: keyOf(workB), pinned: true },
            ]);

            expect(response.rejected).toEqual([]);
            expect(response.saved).toBe(1);
            // A keeps all six, untouched …
            expect((await rows()).filter((row) => row.scopeKey === ORG_A)).toEqual(beforeA);
            // … and B holds its own single pin.
            expect((await rows()).filter((row) => row.scopeKey === ORG_B)).toEqual([
                expect.objectContaining({ itemKey: keyOf(workB), pinned: true, pinOrder: 0 }),
            ]);
        });

        it('frees the slot again when a pin is released', async () => {
            await preferences().upsertMany(
                USER,
                sixPins.map((itemKey, index) => ({
                    scopeKey: 'global',
                    itemKey,
                    pinned: true,
                    pinOrder: index,
                })),
            );
            const workId = await makeWork();

            await service().savePreferences(
                USER,
                personal,
                [
                    { key: 'platform:ever-gauzy-3', pinned: false },
                    { key: keyOf(workId), pinned: true },
                ],
                platforms(),
            );

            const stored = await rows();
            expect(stored.filter((row) => row.pinned)).toHaveLength(6);
            expect(stored.find((row) => row.itemKey === keyOf(workId))).toMatchObject({
                pinned: true,
                pinOrder: 5,
            });
            expect(stored.find((row) => row.itemKey === 'platform:ever-gauzy-3')).toMatchObject({
                pinned: false,
                pinOrder: null,
            });
        });

        it('appends a new pin after the last one of the merged view (FR-62)', async () => {
            const first = await makeWork();
            const second = await makeWork();

            const firstSave = await service().savePreferences(USER, personal, [
                { key: keyOf(first), pinned: true },
            ]);
            expect(firstSave.items.filter((item) => item.pinned)).toHaveLength(1);

            await service().savePreferences(
                USER,
                personal,
                [
                    { key: 'platform:cal-diy', pinned: true },
                    { key: keyOf(second), pinned: true },
                ],
                platforms(),
            );

            const stored = await rows();
            expect(stored.find((row) => row.itemKey === keyOf(first))?.pinOrder).toBe(0);
            expect(stored.find((row) => row.itemKey === 'platform:cal-diy')?.pinOrder).toBe(1);
            expect(stored.find((row) => row.itemKey === keyOf(second))?.pinOrder).toBe(2);
        });
    });

    // ── eligibility (ACC-11-22, FR-35) ──────────────────────────────────────

    describe('eligible keys (FR-35, ACC-11-22)', () => {
        it("rejects another Organization's Work with the same reason as a Work that does not exist (ACC-11-22)", async () => {
            const foreign = await makeWork({ organizationId: ORG_B, name: 'Foreign Work' });
            const missing = 'work:99999999-9999-4999-8999-999999999999';

            const response = await service().savePreferences(USER, orgA, [
                { key: keyOf(foreign), pinned: true },
                { key: missing, pinned: true },
            ]);

            const foreignRejection = response.rejected.find(
                (entry) => entry.key === keyOf(foreign),
            );
            const missingRejection = response.rejected.find((entry) => entry.key === missing);

            expect(foreignRejection).toEqual({ key: keyOf(foreign), reason: 'unknownItem' });
            expect(missingRejection).toEqual({ key: missing, reason: 'unknownItem' });
            // The reason is one identical value: with the key normalised out, the two
            // rejections are byte-identical.
            expect(JSON.stringify({ ...foreignRejection, key: 'k' })).toBe(
                JSON.stringify({ ...missingRejection, key: 'k' }),
            );

            expect(response.saved).toBe(0);
            // Neither key was written, and the foreign Work is untouched.
            expect(await rows()).toEqual([]);
        });

        it('accepts a Work of the active Organization, a personal Work and a catalog key', async () => {
            const orgWork = await makeWork({ organizationId: ORG_A });
            const personalWork = await makeWork();

            const response = await service().savePreferences(
                USER,
                orgA,
                [
                    { key: keyOf(orgWork), pinned: true, order: 3 },
                    { key: 'platform:ever-gauzy', pinned: true, order: 1 },
                ],
                platforms(),
            );
            expect(response.rejected).toEqual([]);
            expect(response.saved).toBe(2);

            const personalResponse = await service().savePreferences(USER, personal, [
                { key: keyOf(personalWork), pinned: true },
            ]);
            expect(personalResponse.rejected).toEqual([]);

            const stored = await rows();
            // Platform rows always live under `global` (FR-24) …
            expect(stored.find((row) => row.itemKey === 'platform:ever-gauzy')).toMatchObject({
                scopeKey: 'global',
                pinned: true,
                sortOrder: 1,
            });
            // … and Work rows under the active scope.
            expect(stored.find((row) => row.itemKey === keyOf(orgWork))).toMatchObject({
                scopeKey: ORG_A,
                pinned: true,
                sortOrder: 3,
            });
            expect(stored.find((row) => row.itemKey === keyOf(personalWork))).toMatchObject({
                scopeKey: 'personal',
                pinned: true,
            });
        });

        it('rejects a key of an unknown shape with the same reason as an unknown item', async () => {
            const response = await service().savePreferences(USER, personal, [
                { key: 'not-a-key', pinned: true },
                { key: '', pinned: true },
            ]);

            expect(response.rejected).toEqual([
                { key: 'not-a-key', reason: 'unknownItem' },
                { key: '', reason: 'unknownItem' },
            ]);
            expect(await rows()).toEqual([]);
        });

        it('rejects a catalog key the caller did not hand in — the catalog is the source of truth (FR-8)', async () => {
            await preferences().upsertMany(USER, [
                { scopeKey: 'global', itemKey: 'platform:cal-diy', pinned: true, pinOrder: 0 },
            ]);

            // The catalog could not be read this time, so `platform:cal-diy` is not
            // among the keys the caller can name (FR-8: the list is data read at
            // runtime, never a constant in code).
            const response = await service().savePreferences(USER, personal, [
                { key: 'platform:cal-diy', pinned: false },
            ]);

            expect(response.rejected).toEqual([{ key: 'platform:cal-diy', reason: 'unknownItem' }]);
            // The stored row is untouched: a save that cannot name an item cannot
            // change it, and nothing deletes it either.
            expect((await rows())[0]).toMatchObject({
                itemKey: 'platform:cal-diy',
                pinned: true,
                pinOrder: 0,
            });
        });

        it('accepts the current platform even when the catalog did not list it', async () => {
            const response = await service().savePreferences(USER, personal, [
                { key: SELF_KEY, pinned: true },
            ]);

            expect(response.rejected).toEqual([]);
            expect(await rows()).toEqual([
                expect.objectContaining({ itemKey: SELF_KEY, pinned: true }),
            ]);
        });
    });

    // ── scopes do not bleed (ACC-11-47) ─────────────────────────────────────

    describe('a save in one Organization never touches another (ACC-11-47)', () => {
        it("leaves Organization A's pins and orders byte-identical", async () => {
            const workIds: string[] = [];
            for (let index = 0; index < 5; index += 1) {
                workIds.push(await makeWork({ organizationId: ORG_A }));
            }
            await preferences().upsertMany(USER, [
                ...workIds.map((workId, index) => ({
                    scopeKey: ORG_A,
                    itemKey: keyOf(workId),
                    pinned: true,
                    pinOrder: index,
                    sortOrder: index,
                })),
                { scopeKey: 'global', itemKey: SELF_KEY, pinned: true, pinOrder: 5, sortOrder: 0 },
            ]);

            const before = await rows();
            const beforeA = before.filter((row) => row.scopeKey === ORG_A);
            expect(beforeA).toHaveLength(5);

            const workB = await makeWork({ organizationId: ORG_B });
            const response = await service().savePreferences(
                USER,
                orgB,
                [
                    { key: keyOf(workB), pinned: true, order: 0 },
                    { key: 'platform:cal-diy', pinned: true },
                ],
                platforms(),
            );

            expect(response.rejected).toEqual([]);
            const after = await rows();

            // Organization A's five rows — values and `updatedAt` — are untouched.
            expect(after.filter((row) => row.scopeKey === ORG_A)).toEqual(beforeA);
            // Organization B's own row was written under B.
            expect(after.find((row) => row.itemKey === keyOf(workB))).toMatchObject({
                scopeKey: ORG_B,
                pinned: true,
                sortOrder: 0,
            });
        });

        it('shares an Ever app pin across Organizations but never a Work pin (ACC-11-21)', async () => {
            await service().savePreferences(
                USER,
                orgA,
                [{ key: 'platform:ever-gauzy', pinned: true }],
                platforms(),
            );
            const workA = await makeWork({ organizationId: ORG_A });
            await service().savePreferences(USER, orgA, [{ key: keyOf(workA), pinned: true }]);

            const inA = await service().listForUser({ id: USER }, orgA, platforms(), {});
            const inB = await service().listForUser({ id: USER }, orgB, platforms(), {});

            const find = (
                response: { items: Array<{ key: string; pinned: boolean }> },
                key: string,
            ) => response.items.find((item) => item.key === key);

            expect(find(inA, 'platform:ever-gauzy')?.pinned).toBe(true);
            expect(find(inB, 'platform:ever-gauzy')?.pinned).toBe(true);
            expect(find(inA, keyOf(workA))?.pinned).toBe(true);
            expect(find(inB, keyOf(workA))).toBeUndefined();
        });
    });

    // ── merge-patch, idempotency and ordering (FR-29, FR-62) ────────────────

    describe('merge patch and idempotency (FR-29)', () => {
        it('keeps fields the change does not mention', async () => {
            const workId = await makeWork();
            await service().savePreferences(USER, personal, [
                { key: keyOf(workId), pinned: true, order: 4 },
            ]);

            await service().savePreferences(USER, personal, [
                { key: keyOf(workId), visible: false },
            ]);

            expect((await rows())[0]).toMatchObject({
                itemKey: keyOf(workId),
                visible: false,
                pinned: true,
                sortOrder: 4,
            });
        });

        it('changes nothing when the same values are sent again (FR-29)', async () => {
            const workId = await makeWork();
            const change = { key: keyOf(workId), pinned: true, visible: false, order: 2 };

            const first = await service().savePreferences(USER, personal, [change]);
            const afterFirst = await rows();

            const second = await service().savePreferences(USER, personal, [change]);
            const afterSecond = await rows();

            expect(first.saved).toBe(1);
            expect(second.saved).toBe(1);
            expect(second.rejected).toEqual([]);
            // No row was rewritten — including its `updatedAt`, which is FR-62's pin
            // tie-break.
            expect(afterSecond).toEqual(afterFirst);
        });

        it('writes an explicit order for every item of a reordered section (FR-62)', async () => {
            const first = await makeWork();
            const second = await makeWork();
            const third = await makeWork();

            const response = await service().savePreferences(USER, personal, [
                { key: keyOf(third), order: 0 },
                { key: keyOf(first), order: 1 },
                { key: keyOf(second), order: 2 },
            ]);

            expect(response.saved).toBe(3);
            const orderByKey = new Map((await rows()).map((row) => [row.itemKey, row.sortOrder]));
            expect(orderByKey.get(keyOf(third))).toBe(0);
            expect(orderByKey.get(keyOf(first))).toBe(1);
            expect(orderByKey.get(keyOf(second))).toBe(2);

            // … so the next read renders that arrangement, on any device.
            const ordered = await service().listForUser({ id: USER }, personal, platforms(), {});
            expect(
                ordered.items.filter((item) => item.kind === 'work').map((item) => item.key),
            ).toEqual([keyOf(third), keyOf(first), keyOf(second)]);
        });

        it('hides an item from the panel while keeping it in Manage apps (FR-27)', async () => {
            const workId = await makeWork();

            await service().savePreferences(USER, personal, [
                { key: keyOf(workId), visible: false },
            ]);

            const panel = await service().listForUser({ id: USER }, personal, platforms(), {});
            expect(panel.items.map((item) => item.key)).not.toContain(keyOf(workId));

            const manage = await service().listForUser({ id: USER }, personal, platforms(), {
                includeHidden: true,
            });
            expect(manage.items.find((item) => item.key === keyOf(workId))).toMatchObject({
                visible: false,
                manageState: 'listed',
            });
        });

        it('ignores a field value of the wrong type instead of writing it', async () => {
            const workId = await makeWork();

            const response = await service().savePreferences(USER, personal, [
                {
                    key: keyOf(workId),
                    visible: 'yes' as unknown as boolean,
                    order: 12_000,
                },
            ]);

            expect(response.rejected).toEqual([]);
            expect(await rows()).toEqual([]);
        });

        it('returns the includeHidden list so Manage apps re-renders without a second call', async () => {
            const hidden = await makeWork();
            const live = await makeWork();
            await preferences().upsertMany(USER, [
                { scopeKey: 'personal', itemKey: keyOf(hidden), visible: false },
            ]);

            const response = await service().savePreferences(
                USER,
                personal,
                [{ key: keyOf(live), pinned: true }],
                platforms(),
            );

            expect(response.items.map((item) => item.key)).toEqual(
                expect.arrayContaining([keyOf(hidden), keyOf(live), SELF_KEY]),
            );
            expect(response.items.find((item) => item.key === keyOf(hidden))?.visible).toBe(false);
        });
    });

    // ── the 500-row ceiling (FR-28) ─────────────────────────────────────────

    describe('the 500 stored rows ceiling (FR-28)', () => {
        it('prunes only ineligible rows once the ceiling is passed', async () => {
            const eligible = await makeWork();
            // One ineligible row per index, oldest first: `pruneIneligible` deletes the
            // oldest ineligible rows until the person is back at the ceiling.
            const stale = Array.from({ length: 505 }, (_value, index) => ({
                scopeKey: 'personal',
                itemKey: `work:${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
                visible: true,
                pinned: false,
            }));
            await preferences().upsertMany(USER, [
                // The eligible row is the OLDEST of all — an eligible item is never
                // pruned, so it must survive (FR-28).
                { scopeKey: 'personal', itemKey: keyOf(eligible), visible: true, pinned: false },
                ...stale,
            ]);
            await dataSource.query(
                `UPDATE "app_launcher_preferences" SET "updatedAt" = ? WHERE "itemKey" = ?`,
                ['2020-01-01T00:00:00.000Z', keyOf(eligible)],
            );
            expect(await rows()).toHaveLength(506);

            const response = await service().savePreferences(USER, personal, [
                { key: keyOf(eligible), pinned: true },
            ]);

            expect(response.rejected).toEqual([]);
            const stored = await rows();
            expect(stored).toHaveLength(500);
            expect(stored.find((row) => row.itemKey === keyOf(eligible))).toMatchObject({
                pinned: true,
                pinOrder: 0,
            });
        });

        it('does not prune anything while the person is under the ceiling', async () => {
            const workId = await makeWork();
            await preferences().upsertMany(USER, [
                { scopeKey: 'personal', itemKey: 'work:11111111-0000-4000-8000-000000000000' },
            ]);
            const before = await rows();

            await service().savePreferences(USER, personal, [{ key: keyOf(workId), pinned: true }]);
            const after = await rows();

            expect(after).toHaveLength(before.length + 1);
            expect(after.find((row) => row.itemKey === before[0].itemKey)).toEqual(before[0]);
        });
    });
});
