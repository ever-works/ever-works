import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { MissionsService } from '../missions.service';
import { Mission, MissionOutcome, MissionStatus, MissionType } from '../../entities/mission.entity';
import { TitlerService } from '../../titler/titler.service';
import type { ActivityLogService } from '../../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../../entities/activity-log.types';

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

        it('resume: FAILED → ACTIVE clears outcome + completedAt (revival)', async () => {
            const id = await seedActive();
            // FAILED is worker-set only (no user action lands there) —
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
            // save() upserts a merged object — re-find, old ref is stale.
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
            // activityLog is the TRAILING @Optional() ctor param — after
            // tickService / missionAttachments / uploadsRepo. Reuses the
            // fresh `repo` from the outer beforeEach.
            service = new MissionsService(
                repo as unknown as Repository<Mission>,
                new TitlerService(),
                undefined,
                undefined,
                undefined,
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
});
