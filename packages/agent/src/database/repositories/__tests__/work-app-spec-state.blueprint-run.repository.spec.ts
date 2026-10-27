import { DataSource } from 'typeorm';
import { WorkAppSpecState } from '../../../entities/work-app-spec-state.entity';
import { ENTITIES } from '../../_entities-inventory';
import { WorkAppSpecStateRepository } from '../work-app-spec-state.repository';

/**
 * APW-03 T28–T30 (lane aw-blueprints) — the repository writes the Blueprint run and the
 * upgrade notice rely on, against a real (better-sqlite3) database, because each guard is
 * a `WHERE` clause and only SQL can prove it:
 *
 *  - `claimBlueprintRun` — one run in flight per Work; a stale claim is retaken;
 *  - `patchBlueprintRun` — sets, clears with `null`, leaves absent fields alone;
 *  - `listFollowedBlueprintIds` — the distinct Blueprints Works follow;
 *  - `markUpgradeAvailable` — once per (Work, version);
 *  - `findUpgradeCandidates(…, { excludeNotified })` — a capped notice run moves on.
 */

const WORK_A = '11111111-1111-4111-8111-1111111111a1';
const WORK_B = '22222222-2222-4222-8222-2222222222b2';
const WORK_C = '33333333-3333-4333-8333-3333333333c3';

const NOW = new Date('2026-10-27T03:00:00.000Z');
const STALE_BEFORE = new Date(NOW.getTime() - 30 * 60_000);

describe('WorkAppSpecStateRepository — the Blueprint run', () => {
    let dataSource: DataSource;
    let repository: WorkAppSpecStateRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        repository = new WorkAppSpecStateRepository(dataSource.getRepository(WorkAppSpecState));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.query('PRAGMA foreign_keys = OFF');
        await dataSource.getRepository(WorkAppSpecState).clear();
        for (const work of [WORK_A, WORK_B, WORK_C]) {
            await repository.initialize(work, 'main');
        }
    });

    const read = async (workId: string) => (await repository.findByWorkId(workId))!;

    describe('claimBlueprintRun', () => {
        it('claims once, refuses while the run is in flight, and retakes a stale claim', async () => {
            await expect(repository.claimBlueprintRun(WORK_A, NOW, STALE_BEFORE)).resolves.toBe(
                true,
            );
            expect(await read(WORK_A)).toMatchObject({
                blueprintUpgradeStatus: 'queued',
                blueprintUpgradeError: null,
            });
            expect(new Date((await read(WORK_A)).blueprintUpgradeRequestedAt!).toISOString()).toBe(
                NOW.toISOString(),
            );

            await expect(repository.claimBlueprintRun(WORK_A, NOW, STALE_BEFORE)).resolves.toBe(
                false,
            );

            await repository.patchBlueprintRun(WORK_A, { blueprintUpgradeStatus: 'running' });
            await expect(repository.claimBlueprintRun(WORK_A, NOW, STALE_BEFORE)).resolves.toBe(
                false,
            );

            // Thirty minutes later the claim is stale: a lost dispatch never blocks forever.
            const later = new Date(NOW.getTime() + 31 * 60_000);
            await expect(
                repository.claimBlueprintRun(
                    WORK_A,
                    later,
                    new Date(later.getTime() - 30 * 60_000),
                ),
            ).resolves.toBe(true);
        });

        it('claims again once the run ended (proposed, unchanged or failed)', async () => {
            for (const status of ['proposed', 'unchanged', 'failed'] as const) {
                await repository.patchBlueprintRun(WORK_B, { blueprintUpgradeStatus: status });
                await expect(repository.claimBlueprintRun(WORK_B, NOW, STALE_BEFORE)).resolves.toBe(
                    true,
                );
            }
        });

        it('touches only the one Work, and answers false for a Work with no row', async () => {
            await repository.claimBlueprintRun(WORK_A, NOW, STALE_BEFORE);
            expect((await read(WORK_B)).blueprintUpgradeStatus ?? null).toBeNull();
            await expect(
                repository.claimBlueprintRun(
                    '44444444-4444-4444-8444-444444444444',
                    NOW,
                    STALE_BEFORE,
                ),
            ).resolves.toBe(false);
        });
    });

    describe('patchBlueprintRun', () => {
        it('sets, clears with null, and leaves absent fields alone; the proposal round-trips', async () => {
            const proposal = {
                number: 41,
                url: 'https://github.com/member/umami/pull/41',
                version: '0.2.0',
                breaking: false,
                mode: 'upgrade' as const,
                conflictCount: 1,
                conflicts: [
                    {
                        path: 'spec.env[name=A].value',
                        kind: 'both_changed' as const,
                        proposed: '"x"',
                    },
                ],
            };
            await repository.patchBlueprintRun(WORK_A, {
                blueprintUpgradeStatus: 'proposed',
                blueprintUpgradeError: 'old',
                blueprintUpgradePr: proposal,
                blueprintVersion: '0.1.0',
            });
            await repository.patchBlueprintRun(WORK_A, { blueprintUpgradeError: null });
            expect(await read(WORK_A)).toMatchObject({
                blueprintUpgradeStatus: 'proposed',
                blueprintUpgradeError: null,
                blueprintUpgradePr: proposal,
                blueprintVersion: '0.1.0',
            });
            await expect(repository.patchBlueprintRun(WORK_A, {})).resolves.toBe(false);
        });
    });

    describe('the notice queries', () => {
        beforeEach(async () => {
            await repository.markBlueprintMatched(WORK_A, 'umami', '0.1.0', 'explicit');
            await repository.markBlueprintMatched(WORK_B, 'umami', '0.1.0', 'explicit');
            await repository.markBlueprintMatched(WORK_C, 'cal', '1.0.0', 'probe');
        });

        it('lists the distinct Blueprint ids Works follow', async () => {
            await repository.initialize('44444444-4444-4444-8444-444444444444', 'main');
            await expect(repository.listFollowedBlueprintIds()).resolves.toEqual(['cal', 'umami']);
        });

        it('marks the latest version once per Work and version', async () => {
            await expect(repository.markUpgradeAvailable(WORK_A, '0.2.0')).resolves.toBe(true);
            await expect(repository.markUpgradeAvailable(WORK_A, '0.2.0')).resolves.toBe(false);
            await expect(repository.markUpgradeAvailable(WORK_A, '0.3.0')).resolves.toBe(true);
            expect((await read(WORK_A)).blueprintLatestVersion).toBe('0.3.0');
        });

        it('skips the rows already told about this version only when asked', async () => {
            await repository.markUpgradeAvailable(WORK_A, '0.2.0');
            const all = await repository.findUpgradeCandidates('umami', '0.2.0', 50);
            expect(all.map((row) => row.workId).sort()).toEqual([WORK_A, WORK_B].sort());
            const pending = await repository.findUpgradeCandidates('umami', '0.2.0', 50, {
                excludeNotified: true,
            });
            expect(pending.map((row) => row.workId)).toEqual([WORK_B]);
        });
    });
});
