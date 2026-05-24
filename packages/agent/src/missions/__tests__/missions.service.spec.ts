import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { MissionsService } from '../missions.service';
import { Mission, MissionStatus, MissionType } from '../../entities/mission.entity';

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
        service = new MissionsService(repo as unknown as Repository<Mission>);
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
});
