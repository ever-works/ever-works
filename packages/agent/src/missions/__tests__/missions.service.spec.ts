import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception';
import type { Repository } from 'typeorm';
import { MissionsService } from '../missions.service';
import { Mission, MissionOutcome, MissionStatus, MissionType } from '../../entities/mission.entity';
import type { MissionWorkRelation } from '../../entities/mission-work.entity';
import type { Work } from '../../entities/work.entity';
import type {
    MissionWorkRepository,
    MissionWorkWithMission,
    MissionWorkWithWork,
} from '../../database/repositories/mission-work.repository';
import { TitlerService } from '../../titler/titler.service';
import type { ActivityLogService } from '../../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../../entities/activity-log.types';
import { GoalsService } from '../../goals/goals.service';
import type { GitFacadeService } from '../../facades/git.facade';
import { MissionTemplateManifestService } from '../mission-template-manifest.service';
import { MissionTemplateManifestReader } from '../mission-template-manifest.reader';

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

/** PR-2 â€” plain-jest.fn() MissionWorkRepository mock (same idiom as
 *  makeRepoMock: only the surface MissionsService actually calls). */
function makeMissionWorksMock() {
    return {
        attach: jest.fn(async (): Promise<void> => undefined),
        detach: jest.fn(async (): Promise<boolean> => true),
        listForMissionWithWork: jest.fn(async (): Promise<MissionWorkWithWork[]> => []),
        listForWorkWithMission: jest.fn(async (): Promise<MissionWorkWithMission[]> => []),
    };
}

/** PR-2 â€” Repository<Work> mock. attachWork only calls findOne. */
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
        // Phase 3 PR I â€” real TitlerService (no DI deps), so tests
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

        it('pause: ACTIVE â†’ PAUSED', async () => {
            const id = await seedActive();
            const dto = await service.pause('u1', id);
            expect(dto.status).toBe(MissionStatus.PAUSED);
        });

        it('pause: rejects when already PAUSED', async () => {
            const id = await seedActive();
            await service.pause('u1', id);
            await expect(service.pause('u1', id)).rejects.toBeInstanceOf(BadRequestException);
        });

        it('resume: PAUSED â†’ ACTIVE', async () => {
            const id = await seedActive();
            await service.pause('u1', id);
            const dto = await service.resume('u1', id);
            expect(dto.status).toBe(MissionStatus.ACTIVE);
        });

        it('resume: rejects when ACTIVE (idempotency error)', async () => {
            const id = await seedActive();
            await expect(service.resume('u1', id)).rejects.toBeInstanceOf(BadRequestException);
        });

        it('complete: ACTIVE â†’ COMPLETED', async () => {
            const id = await seedActive();
            const dto = await service.complete('u1', id);
            expect(dto.status).toBe(MissionStatus.COMPLETED);
        });

        it('complete: PAUSED â†’ COMPLETED', async () => {
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

        it('flipping ONE_SHOT â†’ SCHEDULED requires a schedule', async () => {
            const m = await service.create('u1', {
                title: 't',
                description: 'd',
                type: MissionType.ONE_SHOT,
            });
            await expect(
                service.update('u1', m.id, { type: MissionType.SCHEDULED }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('flipping SCHEDULED â†’ ONE_SHOT clears the orphan schedule', async () => {
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

    describe('complete outcome (PR-3)', () => {
        async function seedActive(): Promise<string> {
            const m = await service.create('u1', {
                title: 't',
                description: 'd',
                type: MissionType.ONE_SHOT,
            });
            return m.id;
        }

        it.each(Object.values(MissionOutcome))(
            'stores outcome=%s + completedAt on the saved entity',
            async (outcome) => {
                const id = await seedActive();
                const dto = await service.complete('u1', id, outcome);
                expect(dto.status).toBe(MissionStatus.COMPLETED);
                expect(dto.outcome).toBe(outcome);
                expect(dto.completedAt).toBeInstanceOf(Date);
                // The entity handed to repo.save carries the verdict fields.
                const saved = repo.save.mock.calls[repo.save.mock.calls.length - 1][0];
                expect(saved.status).toBe(MissionStatus.COMPLETED);
                expect(saved.outcome).toBe(outcome);
                expect(saved.completedAt).toBeInstanceOf(Date);
            },
        );

        it('rejects an invalid outcome string with 400 (mission untouched)', async () => {
            const id = await seedActive();
            await expect(
                service.complete('u1', id, 'nailed_it' as MissionOutcome),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(repo._rows[0].status).toBe(MissionStatus.ACTIVE);
            expect(repo._rows[0].outcome ?? null).toBeNull();
        });

        it('complete without an outcome stores outcome=null (verdict is optional)', async () => {
            const id = await seedActive();
            const dto = await service.complete('u1', id);
            expect(dto.status).toBe(MissionStatus.COMPLETED);
            expect(dto.outcome).toBeNull();
            expect(dto.completedAt).toBeInstanceOf(Date);
            const saved = repo.save.mock.calls[repo.save.mock.calls.length - 1][0];
            expect(saved.outcome).toBeNull();
        });

        it('resume: FAILED â†’ ACTIVE clears outcome + completedAt (revival)', async () => {
            const id = await seedActive();
            // FAILED is worker-set only (no user action lands there) â€”
            // mutate the row directly and seed stale verdict fields to
            // prove revival clears them.
            const row = repo._rows.find((r) => r.id === id)!;
            row.status = MissionStatus.FAILED;
            row.outcome = MissionOutcome.FAILED;
            row.completedAt = new Date('2026-07-01T00:00:00Z');
            const dto = await service.resume('u1', id);
            expect(dto.status).toBe(MissionStatus.ACTIVE);
            expect(dto.outcome).toBeNull();
            expect(dto.completedAt).toBeNull();
            // save() upserts a merged object â€” re-find, old ref is stale.
            const persisted = repo._rows.find((r) => r.id === id)!;
            expect(persisted.outcome).toBeNull();
            expect(persisted.completedAt).toBeNull();
        });

        it('resume: still rejects from ACTIVE (revival gate opens only PAUSED/FAILED)', async () => {
            const id = await seedActive();
            await expect(service.resume('u1', id)).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('lifecycle activity logging (PR-3)', () => {
        let activityLog: { log: jest.Mock };

        beforeEach(() => {
            activityLog = { log: jest.fn().mockResolvedValue(undefined) };
            // activityLog is the TRAILING @Optional() ctor param â€” after
            // tickService / missionAttachments / uploadsRepo. Reuses the
            // fresh `repo` from the outer beforeEach.
            service = new MissionsService(
                repo as unknown as Repository<Mission>,
                new TitlerService(),
                undefined, // tickService
                undefined, // missionAttachments
                undefined, // uploadsRepo
                undefined, // missionWorks (PR-2)
                undefined, // worksRepo (PR-2)
                activityLog as unknown as ActivityLogService,
            );
        });

        async function seedActive(): Promise<string> {
            const m = await service.create('u1', {
                title: 't',
                description: 'd',
                type: MissionType.ONE_SHOT,
            });
            return m.id;
        }

        /** Filter log() calls by actionType so these tests stay green if
         *  more lifecycle emits (e.g. mission_created) get wired later. */
        function logCalls(type: ActivityActionType) {
            return activityLog.log.mock.calls.filter(
                (call) => (call[0] as { actionType?: ActivityActionType })?.actionType === type,
            );
        }

        it('pause writes mission_paused', async () => {
            const id = await seedActive();
            await service.pause('u1', id);
            const calls = logCalls(ActivityActionType.MISSION_PAUSED);
            expect(calls).toHaveLength(1);
            expect(calls[0][0]).toEqual(
                expect.objectContaining({
                    userId: 'u1',
                    actionType: ActivityActionType.MISSION_PAUSED,
                    action: 'pause',
                    status: ActivityStatus.COMPLETED,
                    details: expect.objectContaining({ missionId: id }),
                }),
            );
        });

        it('resume writes mission_resumed', async () => {
            const id = await seedActive();
            await service.pause('u1', id);
            await service.resume('u1', id);
            const calls = logCalls(ActivityActionType.MISSION_RESUMED);
            expect(calls).toHaveLength(1);
            expect(calls[0][0]).toEqual(
                expect.objectContaining({
                    userId: 'u1',
                    action: 'resume',
                    status: ActivityStatus.COMPLETED,
                    details: expect.objectContaining({ missionId: id }),
                }),
            );
        });

        it('complete writes mission_completed with the outcome in details', async () => {
            const id = await seedActive();
            await service.complete('u1', id, MissionOutcome.PARTIALLY_SUCCEEDED);
            const calls = logCalls(ActivityActionType.MISSION_COMPLETED);
            expect(calls).toHaveLength(1);
            expect(calls[0][0]).toEqual(
                expect.objectContaining({
                    userId: 'u1',
                    action: 'complete',
                    status: ActivityStatus.COMPLETED,
                    details: expect.objectContaining({
                        missionId: id,
                        outcome: MissionOutcome.PARTIALLY_SUCCEEDED,
                    }),
                }),
            );
        });

        it('complete without an outcome records outcome=null in details', async () => {
            const id = await seedActive();
            await service.complete('u1', id);
            const calls = logCalls(ActivityActionType.MISSION_COMPLETED);
            expect(calls).toHaveLength(1);
            expect(calls[0][0]).toEqual(
                expect.objectContaining({
                    details: expect.objectContaining({ missionId: id, outcome: null }),
                }),
            );
        });

        it('delete writes mission_deleted with the title for post-hoc context', async () => {
            const id = await seedActive();
            await service.delete('u1', id);
            const calls = logCalls(ActivityActionType.MISSION_DELETED);
            expect(calls).toHaveLength(1);
            expect(calls[0][0]).toEqual(
                expect.objectContaining({
                    userId: 'u1',
                    action: 'delete',
                    status: ActivityStatus.COMPLETED,
                    details: expect.objectContaining({ missionId: id, title: 't' }),
                }),
            );
        });

        it('a rejected transition writes no lifecycle activity', async () => {
            const id = await seedActive();
            // resume from ACTIVE throws 400 BEFORE recordActivity runs.
            await expect(service.resume('u1', id)).rejects.toBeInstanceOf(BadRequestException);
            expect(logCalls(ActivityActionType.MISSION_RESUMED)).toHaveLength(0);
        });

        it('an activity failure never fails the operation (best-effort)', async () => {
            activityLog.log.mockRejectedValue(new Error('activity db down'));
            const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});
            const id = await seedActive();
            const dto = await service.pause('u1', id);
            expect(dto.status).toBe(MissionStatus.PAUSED);
            warnSpy.mockRestore();
        });
    });

    // PR-2 (domain-model evolution) â€” the explicit Missionâ†”Work M:N edge.
    // Constructor gained TWO trailing @Optional deps (missionWorks, worksRepo)
    // so the plain `new MissionsService(repo, titler)` construction above
    // still compiles; `wired` passes them explicitly (undefined for the
    // three unrelated optional deps in between). Invariants exercised:
    // I-7 (Missions never own Works â€” attach validates ownership, never
    // transfers it) and I-6 (detach deletes only the edge row, never the Work).
    describe('Mission â†” Work relations (PR-2)', () => {
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
                        tenantId: null,
                        organizationId: null,
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

            it('404s on an unknown/foreign Work (findOne â†’ null; no attach side-effect)', async () => {
                const id = await seedMission();
                worksRepo.findOne.mockResolvedValueOnce(null);
                await expect(
                    wired.attachWork('u1', id, 'w-foreign', 'improves'),
                ).rejects.toBeInstanceOf(NotFoundException);
                // Owner-scoped lookup â€” the IDOR contract: foreign ids look
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
                        tenantId: null,
                        organizationId: null,
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
            it('404s when the edge does not exist (detach â†’ false)', async () => {
                const id = await seedMission();
                missionWorks.detach.mockResolvedValueOnce(false);
                await expect(wired.detachWork('u1', id, 'w1', 'created')).rejects.toBeInstanceOf(
                    NotFoundException,
                );
            });

            it('deletes the edge and returns {deleted: true} â€” the Work is untouched (I-6)', async () => {
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
                // I-6: only the edge row goes â€” the detach path never even
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
                        tenantId: null,
                        organizationId: null,
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

/**
 * APW-08 T34 (FR-51, plan §5 / S27) — the output mode is validated and stored, the Task output is
 * stored normalized, and a Mission that files Tasks with no App Work attached as Improves or
 * Operates is ACCEPTED with the `noAppWorkRelation` warning.
 */
describe('MissionsService — output mode (APW-08 T34)', () => {
    let repo: ReturnType<typeof makeRepoMock>;
    const relationsOf = (rows: Array<{ relation: string; workKind: string | null }>) => ({
        listForMissionWithWork: jest.fn(async () => rows),
    });
    const build = (missionWorks?: unknown) =>
        new MissionsService(
            repo as unknown as Repository<Mission>,
            new TitlerService(),
            undefined, // tickService
            undefined, // missionAttachments
            undefined, // uploadsRepo
            missionWorks as never,
        );
    const base = { title: 'Grow Bookings', description: 'd', type: MissionType.ONE_SHOT };

    beforeEach(() => {
        repo = makeRepoMock();
    });

    it('a Mission without the field is ideas with default Task output, and warns nothing', async () => {
        const dto = await build(relationsOf([])).create('u1', base);
        expect(dto).toMatchObject({
            outputMode: 'ideas',
            taskOutput: { tasksPerTick: 1, openTasksCap: 3 },
            taskOutputNoticeAt: null,
        });
        expect(dto.warnings).toBeUndefined();
    });

    it('files Tasks with no App Work attached: accepted, with noAppWorkRelation', async () => {
        const dto = await build(relationsOf([{ relation: 'markets', workKind: 'app' }])).create(
            'u1',
            { ...base, outputMode: 'tasks' },
        );
        expect(dto.outputMode).toBe('tasks');
        expect(dto.warnings).toEqual(['noAppWorkRelation']);
        expect(repo._rows).toHaveLength(1);
    });

    it('no warning once an App Work is attached as Improves or Operates', async () => {
        for (const relation of ['improves', 'operates']) {
            const dto = await build(relationsOf([{ relation, workKind: 'app' }])).create('u1', {
                ...base,
                outputMode: 'both',
            });
            expect(dto.warnings).toBeUndefined();
        }
        // A directory Work attached as Improves is not an App Work.
        const site = await build(
            relationsOf([{ relation: 'improves', workKind: 'directory' }]),
        ).create('u1', { ...base, outputMode: 'tasks' });
        expect(site.warnings).toEqual(['noAppWorkRelation']);
    });

    it('refuses an unknown mode (400) and stores Task output normalized', async () => {
        await expect(
            build(relationsOf([])).create('u1', { ...base, outputMode: 'all' }),
        ).rejects.toBeInstanceOf(BadRequestException);
        const dto = await build(relationsOf([])).create('u1', {
            ...base,
            taskOutput: { tasksPerTick: 9, openTasksCap: 5, junk: true },
        });
        expect(dto.taskOutput).toEqual({ tasksPerTick: 1, openTasksCap: 5 });
        expect(repo._rows[0].taskOutput).toEqual({ tasksPerTick: 1, openTasksCap: 5 });
    });

    it('update sets the mode and output, and null resets the output to its defaults', async () => {
        const service = build(relationsOf([{ relation: 'improves', workKind: 'app' }]));
        const created = await service.create('u1', base);
        const updated = await service.update('u1', created.id, {
            outputMode: 'tasks',
            taskOutput: { tasksPerTick: 2, openTasksCap: 4 },
        });
        expect(updated).toMatchObject({
            outputMode: 'tasks',
            taskOutput: { tasksPerTick: 2, openTasksCap: 4 },
        });
        const reset = await service.update('u1', created.id, { taskOutput: null });
        expect(reset.taskOutput).toEqual({ tasksPerTick: 1, openTasksCap: 3 });
    });

    // Review of #3061 — the Output card sends only the two bounds; a save must keep the Agent.
    describe('the Task output’s Agent', () => {
        const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        const FOREIGN = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        const agentsRepo = {
            findOne: jest.fn(async (opts: { where: { id: string; userId?: string } }) =>
                opts.where.id === AGENT && opts.where.userId === 'u1' ? { id: AGENT } : null,
            ),
        };
        const withAgents = () =>
            new MissionsService(
                repo as unknown as Repository<Mission>,
                new TitlerService(),
                undefined, // tickService
                undefined, // missionAttachments
                undefined, // uploadsRepo
                relationsOf([{ relation: 'improves', workKind: 'app' }]) as never,
                undefined, // worksRepo
                undefined, // activityLog
                undefined, // accessPolicy
                undefined, // domainEvents
                undefined, // recordVisibility
                agentsRepo as never,
            );

        beforeEach(() => agentsRepo.findOne.mockClear());

        it('merges a partial save over the stored output, so the Agent survives', async () => {
            const service = withAgents();
            const created = await service.create('u1', {
                ...base,
                taskOutput: { tasksPerTick: 1, openTasksCap: 3, agentId: AGENT },
            });
            const saved = await service.update('u1', created.id, {
                taskOutput: { tasksPerTick: 2, openTasksCap: 5 },
            });
            expect(saved.taskOutput).toEqual({ tasksPerTick: 2, openTasksCap: 5, agentId: AGENT });
            // The unchanged Agent is not re-checked on every save.
            expect(agentsRepo.findOne).toHaveBeenCalledTimes(1);
            // An omitted bound keeps its stored value; `agentId: null` clears the Agent.
            const cleared = await service.update('u1', created.id, {
                taskOutput: { openTasksCap: 7, agentId: null },
            });
            expect(cleared.taskOutput).toEqual({ tasksPerTick: 2, openTasksCap: 7 });
        });

        it('refuses an Agent the caller cannot use (400), on create and on update', async () => {
            const service = withAgents();
            await expect(
                service.create('u1', { ...base, taskOutput: { agentId: FOREIGN } }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(repo._rows).toHaveLength(0);
            const created = await service.create('u1', base);
            await expect(
                service.update('u1', created.id, { taskOutput: { agentId: FOREIGN } }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(repo._rows[0].taskOutput).toBeNull();
        });
    });
});

/**
 * APW-08 T39 (FR-56…FR-58, ACC-08-27 unit half) — `templateInputs` on create: the title filled
 * from Product / Business / App Work, the `improves` relation through the ordinary attach path,
 * and the template's two suggested Goals created as DRAFT delivery Goals scoped to the App Work
 * and linked to the Mission. The App spec is untouched: the only git call is the template
 * manifest's own read.
 */
describe('MissionsService — templateInputs (APW-08 T39)', () => {
    const TEMPLATE_ID = 'build-on-open-source-app';
    const APP_WORK = { id: 'w-app', name: 'Cal.com', kind: 'app', userId: 'u1' };
    const RUNTIME_MANIFEST = readFileSync(
        resolve(
            __dirname,
            '../../../../../docs/specs/features/app-works/APW-08-evolve-loop/mission-template-draft/.works/mission.yml',
        ),
        'utf8',
    );

    let repo: ReturnType<typeof makeRepoMock>;
    let missionWorks: ReturnType<typeof makeMissionWorksMock>;
    let worksRepo: { findOne: jest.Mock };
    let git: { getFileContent: jest.Mock };
    let goals: { create: jest.Mock; linkToMission: jest.Mock };
    let goalsWired: boolean;

    const moduleRef = {
        get: jest.fn((token: unknown) => {
            if (token === GoalsService && goalsWired) return goals;
            throw new UnknownElementException(String(token));
        }),
    };

    const build = () =>
        new MissionsService(
            repo as unknown as Repository<Mission>,
            new TitlerService(),
            undefined, // tickService
            undefined, // missionAttachments
            undefined, // uploadsRepo
            missionWorks as unknown as MissionWorkRepository,
            worksRepo as unknown as Repository<Work>,
            undefined, // activityLog
            undefined, // accessPolicy
            undefined, // domainEvents
            undefined, // recordVisibility
            undefined, // agentsRepo
            new MissionTemplateManifestReader(
                new MissionTemplateManifestService(),
                git as unknown as GitFacadeService,
            ),
            moduleRef as unknown as ModuleRef,
        );

    const input = (overrides: Record<string, unknown> = {}) => ({
        description: 'Weekly changes on the App Work.',
        type: MissionType.SCHEDULED,
        missionTemplateRepo: TEMPLATE_ID,
        templateInputs: { product: 'Booking', business: 'Yoga Loft', appWorkId: APP_WORK.id },
        ...overrides,
    });

    beforeEach(() => {
        repo = makeRepoMock();
        missionWorks = makeMissionWorksMock();
        missionWorks.listForMissionWithWork.mockResolvedValue([
            { relation: 'improves', workKind: 'app' } as unknown as MissionWorkWithWork,
        ]);
        worksRepo = {
            findOne: jest.fn(async (opts: { where: { id: string; userId?: string } }) =>
                opts.where.id === APP_WORK.id && opts.where.userId === APP_WORK.userId
                    ? (APP_WORK as unknown as Work)
                    : null,
            ),
        };
        git = {
            getFileContent: jest.fn(async () => ({ content: RUNTIME_MANIFEST, encoding: 'utf-8' })),
        };
        let goalId = 0;
        goals = {
            create: jest.fn(async (_userId: string, goal: { title: string }) => ({
                id: `g${++goalId}`,
                title: goal.title,
            })),
            linkToMission: jest.fn(async () => ({})),
        };
        goalsWired = true;
        moduleRef.get.mockClear();
    });

    it('fills the title, attaches the App Work as Improves and creates two draft Goals scoped to it', async () => {
        const dto = await build().create('u1', input());

        expect(dto.title).toBe('Build my own Booking for Yoga Loft on top of Cal.com');
        // FR-57 from the template's manifest.
        expect(dto).toMatchObject({
            schedule: '0 8 * * 1',
            outputMode: 'tasks',
            taskOutput: { tasksPerTick: 2, openTasksCap: 4 },
            outstandingIdeasCap: 0,
            guardrailsOverride: { maxBudgetCentsPerRun: 1500, requireApprovalBeforeCreate: true },
        });
        expect(dto.warnings).toBeUndefined();

        expect(missionWorks.attach).toHaveBeenCalledTimes(1);
        expect(missionWorks.attach).toHaveBeenCalledWith({
            missionId: dto.id,
            workId: APP_WORK.id,
            userId: 'u1',
            relation: 'improves',
        });

        expect(goals.create).toHaveBeenCalledTimes(2);
        for (const [userId, goal] of goals.create.mock.calls) {
            expect(userId).toBe('u1');
            expect(goal).toMatchObject({ goalKind: 'delivery', workId: APP_WORK.id });
            expect(goal.dodCriteria.length).toBeGreaterThanOrEqual(1);
            for (const criterion of goal.dodCriteria) {
                expect(criterion).toMatchObject({ status: 'open' });
                expect(criterion.text).not.toMatch(/\{(product|business|appWork)\}/);
            }
        }
        expect(goals.create.mock.calls[0][1].dodCriteria[0].text).toBe(
            'A product brief for Booking at Yoga Loft exists in the Mission knowledge base',
        );
        expect(goals.linkToMission.mock.calls).toEqual([
            ['u1', dto.id, 'g1', false, undefined],
            ['u1', dto.id, 'g2', false, undefined],
        ]);
    });

    it('leaves the App spec untouched: the only git call is the template manifest read', async () => {
        await build().create('u1', input());
        expect(git.getFileContent).toHaveBeenCalledTimes(1);
        expect(git.getFileContent.mock.calls[0].slice(0, 3)).toEqual([
            'ever-works',
            'build-on-open-source-app-mission-template',
            '.works/mission.yml',
        ]);
        expect(worksRepo.findOne).toHaveBeenCalled();
        // Nothing else on the git facade is reachable from the stub, so a commit, push or pull
        // request against the App Work's repository would have thrown.
        expect(Object.keys(git)).toEqual(['getFileContent']);
    });

    it('a value the person set wins over the template (FR-60)', async () => {
        const dto = await build().create(
            'u1',
            input({
                title: 'My own title',
                schedule: '0 6 * * 3',
                taskOutput: { tasksPerTick: 1 },
            }),
        );
        expect(dto.title).toBe('My own title');
        expect(dto.schedule).toBe('0 6 * * 3');
        expect(dto.taskOutput.tasksPerTick).toBe(1);
    });

    it('a Work that is not the caller’s is 404 workNotFound and nothing is written', async () => {
        await expect(
            build().create(
                'u1',
                input({ templateInputs: { product: 'P', business: 'B', appWorkId: 'w-other' } }),
            ),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(repo._rows).toHaveLength(0);
        expect(goals.create).not.toHaveBeenCalled();
    });

    it('a Work that is not an App Work is refused before anything is written', async () => {
        worksRepo.findOne.mockResolvedValueOnce({ ...APP_WORK, kind: 'website' });
        await expect(build().create('u1', input())).rejects.toBeInstanceOf(BadRequestException);
        expect(repo._rows).toHaveLength(0);
    });

    it('refuses templateInputs without a catalog template, and over-long inputs', async () => {
        await expect(
            build().create('u1', input({ missionTemplateRepo: null })),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
            build().create(
                'u1',
                input({
                    templateInputs: { product: 'p'.repeat(81), business: 'B', appWorkId: 'w-app' },
                }),
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(repo._rows).toHaveLength(0);
    });

    it('an unreadable manifest still fills the title and attaches the Work, but files no Goal', async () => {
        git.getFileContent.mockRejectedValueOnce(new Error('No connected account'));
        const dto = await build().create('u1', input({ schedule: '0 8 * * 1' }));
        expect(dto.title).toBe('Build my own Booking for Yoga Loft on top of Cal.com');
        expect(missionWorks.attach).toHaveBeenCalledTimes(1);
        expect(goals.create).not.toHaveBeenCalled();
        expect(dto.warnings).toEqual(['templateManifestUnreadable']);
    });

    it('without GoalsService in the graph the Mission is created and the write says so', async () => {
        goalsWired = false;
        const dto = await build().create('u1', input());
        expect(repo._rows).toHaveLength(1);
        expect(missionWorks.attach).toHaveBeenCalledTimes(1);
        expect(dto.warnings).toEqual(['templateGoalsNotCreated']);
    });
});
