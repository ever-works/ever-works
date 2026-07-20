import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { MissionsService } from '../missions.service';
import { Mission, MissionStatus, MissionType } from '../../entities/mission.entity';
import type { MissionWorkRelation } from '../../entities/mission-work.entity';
import type { Work } from '../../entities/work.entity';
import type {
    MissionWorkRepository,
    MissionWorkWithMission,
    MissionWorkWithWork,
} from '../../database/repositories/mission-work.repository';
import { TitlerService } from '../../titler/titler.service';

/** Hand-rolled in-memory Repository<Mission> mock. Enough surface
 *  for what Phase 3 PR H's MissionsService actually calls. */
function makeRepoMock() {
    const rows: Mission[] = [];
    let idCounter = 0;
    const repo = {
        find: jest.fn(async (opts: { where?: { userId?: string } } = {}) => {
            const userId = opts.where?.userId;
            return userId !== undefined ? rows.filter((r) => r.userId === userId) : [...rows];
        }),
        findOne: jest.fn(
            async (opts: { where: { id: string; userId?: string } }) =>
                rows.find(
                    (r) =>
                        r.id === opts.where.id &&
                        (opts.where.userId === undefined || r.userId === opts.where.userId),
                ) ?? null,
        ),
        create: jest.fn((partial: Partial<Mission>): Mission => {
            return {
                id: `m${++idCounter}`,
                createdAt: new Date('2026-05-24T00:00:00Z'),
                updatedAt: new Date('2026-05-24T00:00:00Z'),
                ...partial,
            } as Mission;
        }),
        save: jest.fn(async (entity: Mission): Promise<Mission> => {
            // upsert by id
            const existingIdx = rows.findIndex((r) => r.id === entity.id);
            if (existingIdx >= 0) {
                rows[existingIdx] = { ...rows[existingIdx], ...entity };
                return rows[existingIdx];
            }
            rows.push(entity);
            return entity;
        }),
        remove: jest.fn(async (entity: Mission): Promise<void> => {
            const idx = rows.findIndex((r) => r.id === entity.id);
            if (idx >= 0) rows.splice(idx, 1);
        }),
        _rows: rows, // expose for assertions
    };
    return repo;
}

/** PR-2 — plain-jest.fn() MissionWorkRepository mock (same idiom as
 *  makeRepoMock: only the surface MissionsService actually calls). */
function makeMissionWorksMock() {
    return {
        attach: jest.fn(async (): Promise<void> => undefined),
        detach: jest.fn(async (): Promise<boolean> => true),
        listForMissionWithWork: jest.fn(async (): Promise<MissionWorkWithWork[]> => []),
        listForWorkWithMission: jest.fn(async (): Promise<MissionWorkWithMission[]> => []),
    };
}

/** PR-2 — Repository<Work> mock. attachWork only calls findOne. */
function makeWorksRepoMock() {
    return {
        findOne: jest.fn(async (): Promise<Work | null> => null),
    };
}

describe('MissionsService', () => {
    let repo: ReturnType<typeof makeRepoMock>;
    let service: MissionsService;

    beforeEach(() => {
        repo = makeRepoMock();
        // Phase 3 PR I — real TitlerService (no DI deps), so tests
        // exercise the actual heuristic. Cheap + deterministic.
        const titler = new TitlerService();
        service = new MissionsService(repo as unknown as Repository<Mission>, titler);
    });

    describe('create', () => {
        it('persists a one-shot mission with status=ACTIVE and schedule=null', async () => {
            const dto = await service.create('u1', {
                title: 'Cats Business',
                description: 'Run the best cats business worldwide.',
                type: MissionType.ONE_SHOT,
            });
            expect(dto.status).toBe(MissionStatus.ACTIVE);
            expect(dto.schedule).toBeNull();
            expect(dto.type).toBe(MissionType.ONE_SHOT);
            expect(repo._rows).toHaveLength(1);
        });

        it('persists a scheduled mission with the cron string', async () => {
            const dto = await service.create('u1', {
                title: 'Weekly Cats Roundup',
                description: 'Auto-curate weekly cat content.',
                type: MissionType.SCHEDULED,
                schedule: '0 9 * * MON',
            });
            expect(dto.type).toBe(MissionType.SCHEDULED);
            expect(dto.schedule).toBe('0 9 * * MON');
        });

        it('rejects type=scheduled without a schedule', async () => {
            await expect(
                service.create('u1', {
                    title: 'x',
                    description: 'x',
                    type: MissionType.SCHEDULED,
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects type=one-shot WITH a schedule set', async () => {
            await expect(
                service.create('u1', {
                    title: 'x',
                    description: 'x',
                    type: MissionType.ONE_SHOT,
                    schedule: '0 9 * * MON',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('clamps title to 200 chars and trims whitespace', async () => {
            const dto = await service.create('u1', {
                title: '   ' + 'a'.repeat(250) + '   ',
                description: 'x',
                type: MissionType.ONE_SHOT,
            });
            expect(dto.title).toHaveLength(200);
            expect(dto.title.startsWith(' ')).toBe(false);
        });
    });

    describe('lifecycle transitions', () => {
        async function seedActive(): Promise<string> {
            const m = await service.create('u1', {
                title: 't',
                description: 'd',
                type: MissionType.ONE_SHOT,
            });
            return m.id;
        }

        it('pause: ACTIVE → PAUSED', async () => {
            const id = await seedActive();
            const dto = await service.pause('u1', id);
            expect(dto.status).toBe(MissionStatus.PAUSED);
        });

        it('pause: rejects when already PAUSED', async () => {
            const id = await seedActive();
            await service.pause('u1', id);
            await expect(service.pause('u1', id)).rejects.toBeInstanceOf(BadRequestException);
        });

        it('resume: PAUSED → ACTIVE', async () => {
            const id = await seedActive();
            await service.pause('u1', id);
            const dto = await service.resume('u1', id);
            expect(dto.status).toBe(MissionStatus.ACTIVE);
        });

        it('resume: rejects when ACTIVE (idempotency error)', async () => {
            const id = await seedActive();
            await expect(service.resume('u1', id)).rejects.toBeInstanceOf(BadRequestException);
        });

        it('complete: ACTIVE → COMPLETED', async () => {
            const id = await seedActive();
            const dto = await service.complete('u1', id);
            expect(dto.status).toBe(MissionStatus.COMPLETED);
        });

        it('complete: PAUSED → COMPLETED', async () => {
            const id = await seedActive();
            await service.pause('u1', id);
            const dto = await service.complete('u1', id);
            expect(dto.status).toBe(MissionStatus.COMPLETED);
        });

        it('complete: rejects when already COMPLETED', async () => {
            const id = await seedActive();
            await service.complete('u1', id);
            await expect(service.complete('u1', id)).rejects.toBeInstanceOf(BadRequestException);
        });

        it('runNow: returns noop placeholder for an ACTIVE mission', async () => {
            const id = await seedActive();
            const res = await service.runNow('u1', id);
            expect(res).toEqual({ status: 'noop-placeholder', missionId: id });
        });

        it('runNow: rejects on COMPLETED', async () => {
            const id = await seedActive();
            await service.complete('u1', id);
            await expect(service.runNow('u1', id)).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('ownership', () => {
        it('getForUser: 404 when the mission belongs to another user', async () => {
            const m = await service.create('alice', {
                title: 't',
                description: 'd',
                type: MissionType.ONE_SHOT,
            });
            await expect(service.getForUser('bob', m.id)).rejects.toBeInstanceOf(NotFoundException);
        });

        it('delete: 404 when the mission does not exist', async () => {
            await expect(
                service.delete('u1', '00000000-0000-0000-0000-000000000000'),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    describe('update', () => {
        it('partial: only writes fields the caller included', async () => {
            const m = await service.create('u1', {
                title: 'original title',
                description: 'original desc',
                type: MissionType.ONE_SHOT,
                autoBuildWorks: false,
            });
            const updated = await service.update('u1', m.id, { title: 'renamed' });
            expect(updated.title).toBe('renamed');
            expect(updated.description).toBe('original desc');
            expect(updated.autoBuildWorks).toBe(false);
        });

        it('flipping ONE_SHOT → SCHEDULED requires a schedule', async () => {
            const m = await service.create('u1', {
                title: 't',
                description: 'd',
                type: MissionType.ONE_SHOT,
            });
            await expect(
                service.update('u1', m.id, { type: MissionType.SCHEDULED }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('flipping SCHEDULED → ONE_SHOT clears the orphan schedule', async () => {
            const m = await service.create('u1', {
                title: 't',
                description: 'd',
                type: MissionType.SCHEDULED,
                schedule: '0 9 * * MON',
            });
            const updated = await service.update('u1', m.id, { type: MissionType.ONE_SHOT });
            expect(updated.type).toBe(MissionType.ONE_SHOT);
            expect(updated.schedule).toBeNull();
        });
    });

    // PR-2 (domain-model evolution) — the explicit Mission↔Work M:N edge.
    // Constructor gained TWO trailing @Optional deps (missionWorks, worksRepo)
    // so the plain `new MissionsService(repo, titler)` construction above
    // still compiles; `wired` passes them explicitly (undefined for the
    // three unrelated optional deps in between). Invariants exercised:
    // I-7 (Missions never own Works — attach validates ownership, never
    // transfers it) and I-6 (detach deletes only the edge row, never the Work).
    describe('Mission ↔ Work relations (PR-2)', () => {
        let missionWorks: ReturnType<typeof makeMissionWorksMock>;
        let worksRepo: ReturnType<typeof makeWorksRepoMock>;
        let wired: MissionsService;

        beforeEach(() => {
            missionWorks = makeMissionWorksMock();
            worksRepo = makeWorksRepoMock();
            // Shares `repo` with the outer unwired `service`, so Missions
            // seeded through either instance are visible to both.
            wired = new MissionsService(
                repo as unknown as Repository<Mission>,
                new TitlerService(),
                undefined, // tickService
                undefined, // missionAttachments
                undefined, // uploadsRepo
                missionWorks as unknown as MissionWorkRepository,
                worksRepo as unknown as Repository<Work>,
            );
        });

        async function seedMission(userId = 'u1'): Promise<string> {
            const m = await wired.create(userId, {
                title: 't',
                description: 'd',
                type: MissionType.ONE_SHOT,
            });
            return m.id;
        }

        describe('listWorks', () => {
            it('404s when the mission belongs to another user (before touching the edge repo)', async () => {
                const id = await seedMission('alice');
                await expect(wired.listWorks('bob', id)).rejects.toBeInstanceOf(NotFoundException);
                expect(missionWorks.listForMissionWithWork).not.toHaveBeenCalled();
            });

            it('returns [] when the MissionWorkRepository is not wired', async () => {
                const id = await seedMission();
                // `service` is the outer unwired construction (repo + titler only).
                await expect(service.listWorks('u1', id)).resolves.toEqual([]);
            });

            it('delegates to listForMissionWithWork(missionId, userId) when wired', async () => {
                const id = await seedMission();
                const rows: MissionWorkWithWork[] = [
                    {
                        id: 'mw1',
                        missionId: id,
                        workId: 'w1',
                        relation: 'created',
                        createdAt: new Date('2026-07-01T00:00:00Z'),
                        workName: 'Cats Directory',
                        workSlug: 'cats-directory',
                    },
                ];
                missionWorks.listForMissionWithWork.mockResolvedValueOnce(rows);
                await expect(wired.listWorks('u1', id)).resolves.toEqual(rows);
                expect(missionWorks.listForMissionWithWork).toHaveBeenCalledWith(id, 'u1');
            });
        });

        describe('attachWork', () => {
            it('400s on an invalid relation (before any Work lookup)', async () => {
                const id = await seedMission();
                await expect(
                    wired.attachWork('u1', id, 'w1', 'owns' as unknown as MissionWorkRelation),
                ).rejects.toBeInstanceOf(BadRequestException);
                expect(worksRepo.findOne).not.toHaveBeenCalled();
                expect(missionWorks.attach).not.toHaveBeenCalled();
            });

            it('404s on an unknown/foreign Work (findOne → null; no attach side-effect)', async () => {
                const id = await seedMission();
                worksRepo.findOne.mockResolvedValueOnce(null);
                await expect(
                    wired.attachWork('u1', id, 'w-foreign', 'improves'),
                ).rejects.toBeInstanceOf(NotFoundException);
                // Owner-scoped lookup — the IDOR contract: foreign ids look
                // identical to unknown ids.
                expect(worksRepo.findOne).toHaveBeenCalledWith({
                    where: { id: 'w-foreign', userId: 'u1' },
                });
                expect(missionWorks.attach).not.toHaveBeenCalled();
            });

            it('400s when the edge repo is not wired', async () => {
                const id = await seedMission();
                await expect(service.attachWork('u1', id, 'w1', 'created')).rejects.toBeInstanceOf(
                    BadRequestException,
                );
            });

            it('attaches with exact args, then returns the refreshed list', async () => {
                const id = await seedMission();
                worksRepo.findOne.mockResolvedValueOnce({ id: 'w1', userId: 'u1' } as Work);
                const refreshed: MissionWorkWithWork[] = [
                    {
                        id: 'mw1',
                        missionId: id,
                        workId: 'w1',
                        relation: 'operates',
                        createdAt: new Date('2026-07-01T00:00:00Z'),
                        workName: 'Cats Directory',
                        workSlug: 'cats-directory',
                    },
                ];
                missionWorks.listForMissionWithWork.mockResolvedValueOnce(refreshed);

                const result = await wired.attachWork('u1', id, 'w1', 'operates');

                expect(missionWorks.attach).toHaveBeenCalledWith({
                    missionId: id,
                    workId: 'w1',
                    userId: 'u1',
                    relation: 'operates',
                });
                expect(result).toEqual(refreshed);
                // attach happens BEFORE the refresh read (returned list
                // reflects the new edge).
                expect(missionWorks.attach.mock.invocationCallOrder[0]).toBeLessThan(
                    missionWorks.listForMissionWithWork.mock.invocationCallOrder[0],
                );
            });
        });

        describe('detachWork', () => {
            it('404s when the edge does not exist (detach → false)', async () => {
                const id = await seedMission();
                missionWorks.detach.mockResolvedValueOnce(false);
                await expect(wired.detachWork('u1', id, 'w1', 'created')).rejects.toBeInstanceOf(
                    NotFoundException,
                );
            });

            it('deletes the edge and returns {deleted: true} — the Work is untouched (I-6)', async () => {
                const id = await seedMission();
                missionWorks.detach.mockResolvedValueOnce(true);
                await expect(wired.detachWork('u1', id, 'w1', 'created')).resolves.toEqual({
                    deleted: true,
                });
                expect(missionWorks.detach).toHaveBeenCalledWith({
                    missionId: id,
                    workId: 'w1',
                    userId: 'u1',
                    relation: 'created',
                });
                // I-6: only the edge row goes — the detach path never even
                // consults the Works repository, let alone deletes from it.
                expect(worksRepo.findOne).not.toHaveBeenCalled();
            });
        });

        describe('listMissionsForWork', () => {
            it('returns [] when the MissionWorkRepository is not wired', async () => {
                await expect(service.listMissionsForWork('u1', 'w1')).resolves.toEqual([]);
            });

            it('delegates to listForWorkWithMission(workId, userId) when wired', async () => {
                const rows: MissionWorkWithMission[] = [
                    {
                        id: 'mw2',
                        missionId: 'm9',
                        workId: 'w1',
                        relation: 'markets',
                        createdAt: new Date('2026-07-02T00:00:00Z'),
                        missionTitle: 'Run the best cats business',
                        missionStatus: 'active',
                    },
                ];
                missionWorks.listForWorkWithMission.mockResolvedValueOnce(rows);
                await expect(wired.listMissionsForWork('u1', 'w1')).resolves.toEqual(rows);
                expect(missionWorks.listForWorkWithMission).toHaveBeenCalledWith('w1', 'u1');
            });
        });
    });
});
