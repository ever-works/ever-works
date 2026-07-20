import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { Goal, GoalOutcome, GoalStatus } from '../../entities/goal.entity';
import type { GoalMetricSample } from '../../entities/goal-metric-sample.entity';
import type { MissionGoal } from '../../entities/mission-goal.entity';
import type { Mission } from '../../entities/mission.entity';
import type { GoalEvaluationService } from '../goal-evaluation.service';
import { GoalsService } from '../goals.service';
import type { CreateGoalInput } from '../types';

/**
 * Goals & Metrics — PR-8 CRUD + lifecycle + mission-link unit tests.
 *
 * Hand-rolled in-memory repository mocks (mirrors the
 * missions.service.spec idiom). One generic factory backs all four
 * repos the service constructs with; it interprets only plain
 * scalar-equality `where` clauses — enough for every call the tested
 * paths make (no TypeORM `In`/operator paths are exercised here).
 * `GoalEvaluationService` is a plain `jest.fn()` object.
 */

interface AnyRow {
    id: string;
    [key: string]: unknown;
}

function makeRepo(prefix: string) {
    const rows: AnyRow[] = [];
    let counter = 0;
    const matches = (row: AnyRow, where: Record<string, unknown> = {}) =>
        Object.entries(where).every(([k, v]) => row[k] === v);
    const repo = {
        find: jest.fn(async (opts: any = {}) => {
            let result = rows.filter((r) => matches(r, opts.where));
            if (opts.order) {
                const [key, dir] = Object.entries(opts.order)[0] as [string, string];
                result = [...result].sort((a, b) => {
                    const av = a[key] as never;
                    const bv = b[key] as never;
                    const cmp = av > bv ? 1 : av < bv ? -1 : 0;
                    return dir === 'DESC' ? -cmp : cmp;
                });
            }
            if (opts.skip) result = result.slice(opts.skip);
            if (opts.take !== undefined) result = result.slice(0, opts.take);
            return result;
        }),
        findOne: jest.fn(async (opts: any) => rows.find((r) => matches(r, opts.where)) ?? null),
        create: jest.fn((partial: any) => ({
            id: `${prefix}${++counter}`,
            createdAt: new Date('2026-07-19T00:00:00.000Z'),
            updatedAt: new Date('2026-07-19T00:00:00.000Z'),
            ...partial,
        })),
        save: jest.fn(async (entity: any) => {
            const idx = rows.findIndex((r) => r.id === entity.id);
            if (idx >= 0) {
                rows[idx] = { ...rows[idx], ...entity };
                return rows[idx];
            }
            const row = { ...entity };
            if (!row.id) row.id = `${prefix}${++counter}`;
            rows.push(row);
            return row;
        }),
        remove: jest.fn(async (entity: any) => {
            const idx = rows.findIndex((r) => r.id === entity.id);
            if (idx >= 0) rows.splice(idx, 1);
        }),
        update: jest.fn(async (criteria: any, patch: any) => {
            const affected = rows.filter((r) => matches(r, criteria));
            affected.forEach((r) => Object.assign(r, patch));
            return { affected: affected.length };
        }),
        insert: jest.fn(async (partial: any) => {
            rows.push({ id: `${prefix}${++counter}`, ...partial });
            return { identifiers: [] };
        }),
        _rows: rows,
    };
    return repo;
}

/** A fully-shaped Goal row for seeding the store directly (bypasses
 *  create's validation — used to construct states create won't allow). */
function makeGoalRow(overrides: Partial<Goal> = {}): AnyRow {
    return {
        id: 'gseed',
        userId: 'u1',
        title: 'seed goal',
        description: null,
        metricSource: { pluginId: 'stripe', metricId: 'income' },
        comparator: 'gte',
        targetValue: 1000,
        unit: 'usd',
        window: 'month',
        baselineValue: null,
        currentValue: null,
        currentValueAt: null,
        deadline: null,
        checkFrequencyMinutes: 60,
        nextCheckAt: null,
        status: GoalStatus.DRAFT,
        outcome: null,
        createdAt: new Date('2026-07-19T00:00:00.000Z'),
        updatedAt: new Date('2026-07-19T00:00:00.000Z'),
        ...overrides,
    } as unknown as AnyRow;
}

function validInput(overrides: Partial<CreateGoalInput> = {}): CreateGoalInput {
    return {
        title: 'Income >= 1000/month',
        metricSource: { pluginId: 'stripe', metricId: 'income' },
        comparator: 'gte',
        targetValue: 1000,
        unit: 'usd',
        window: 'month',
        ...overrides,
    };
}

describe('GoalsService', () => {
    let goalsRepo: ReturnType<typeof makeRepo>;
    let samplesRepo: ReturnType<typeof makeRepo>;
    let missionGoalsRepo: ReturnType<typeof makeRepo>;
    let missionsRepo: ReturnType<typeof makeRepo>;
    let evaluationService: { evaluateOne: jest.Mock };
    let service: GoalsService;

    beforeEach(() => {
        goalsRepo = makeRepo('g');
        samplesRepo = makeRepo('s');
        missionGoalsRepo = makeRepo('mg');
        missionsRepo = makeRepo('m');
        evaluationService = { evaluateOne: jest.fn() };
        service = new GoalsService(
            goalsRepo as unknown as Repository<Goal>,
            samplesRepo as unknown as Repository<GoalMetricSample>,
            missionGoalsRepo as unknown as Repository<MissionGoal>,
            missionsRepo as unknown as Repository<Mission>,
            evaluationService as unknown as GoalEvaluationService,
        );
    });

    describe('create', () => {
        it('persists a DRAFT goal with nextCheckAt null and default 60-minute cadence', async () => {
            const dto = await service.create('u1', validInput());
            expect(dto.status).toBe(GoalStatus.DRAFT);
            expect(dto.nextCheckAt).toBeNull();
            expect(dto.outcome).toBeNull();
            expect(dto.checkFrequencyMinutes).toBe(60);
            expect(goalsRepo._rows).toHaveLength(1);
        });

        it('clamps checkFrequencyMinutes below the 15-minute floor up to 15', async () => {
            const dto = await service.create('u1', validInput({ checkFrequencyMinutes: 5 }));
            expect(dto.checkFrequencyMinutes).toBe(15);
        });

        it('keeps a checkFrequencyMinutes above the floor unchanged', async () => {
            const dto = await service.create('u1', validInput({ checkFrequencyMinutes: 120 }));
            expect(dto.checkFrequencyMinutes).toBe(120);
        });

        it('rejects a non-integer checkFrequencyMinutes', async () => {
            await expect(
                service.create('u1', validInput({ checkFrequencyMinutes: 15.5 })),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects an unknown comparator', async () => {
            await expect(
                service.create('u1', validInput({ comparator: 'eq' as never })),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects an unknown window', async () => {
            await expect(
                service.create('u1', validInput({ window: 'year' as never })),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects a metricSource missing pluginId/metricId', async () => {
            await expect(
                service.create('u1', validInput({ metricSource: { metricId: 'income' } as never })),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects a non-object metricSource', async () => {
            await expect(
                service.create('u1', validInput({ metricSource: null as never })),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects a metricSource whose params is an array (not an object)', async () => {
            await expect(
                service.create(
                    'u1',
                    validInput({
                        metricSource: {
                            pluginId: 'stripe',
                            metricId: 'income',
                            params: [] as never,
                        },
                    }),
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects a non-finite targetValue', async () => {
            await expect(
                service.create('u1', validInput({ targetValue: Number.NaN })),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('activate', () => {
        it('DRAFT → ACTIVE: sets nextCheckAt and clears outcome', async () => {
            const created = await service.create('u1', validInput());
            const dto = await service.activate('u1', created.id);
            expect(dto.status).toBe(GoalStatus.ACTIVE);
            expect(dto.nextCheckAt).not.toBeNull();
            expect(dto.outcome).toBeNull();
        });

        it('rejects activation when metricSource lacks a concrete pluginId + metricId', async () => {
            // Seed a DRAFT goal with an un-evaluable placeholder source
            // (create would have rejected this, so we seed the row directly).
            goalsRepo._rows.push(
                makeGoalRow({
                    id: 'gbad',
                    userId: 'u1',
                    status: GoalStatus.DRAFT,
                    metricSource: { pluginId: '', metricId: '' },
                }),
            );
            await expect(service.activate('u1', 'gbad')).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('rejects activation from an already-ACTIVE status', async () => {
            const created = await service.create('u1', validInput());
            await service.activate('u1', created.id);
            await expect(service.activate('u1', created.id)).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('re-activating a COMPLETED goal clears its outcome', async () => {
            goalsRepo._rows.push(
                makeGoalRow({
                    id: 'gdone',
                    userId: 'u1',
                    status: GoalStatus.COMPLETED,
                    outcome: GoalOutcome.MISSED,
                }),
            );
            const dto = await service.activate('u1', 'gdone');
            expect(dto.status).toBe(GoalStatus.ACTIVE);
            expect(dto.outcome).toBeNull();
        });
    });

    describe('pause', () => {
        it('ACTIVE → PAUSED: clears nextCheckAt', async () => {
            const created = await service.create('u1', validInput());
            await service.activate('u1', created.id);
            const dto = await service.pause('u1', created.id);
            expect(dto.status).toBe(GoalStatus.PAUSED);
            expect(dto.nextCheckAt).toBeNull();
        });

        it('rejects pausing a DRAFT goal', async () => {
            const created = await service.create('u1', validInput());
            await expect(service.pause('u1', created.id)).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });
    });

    describe('update — human outcome override (FR-13)', () => {
        it('setting a non-null outcome completes the goal and clears nextCheckAt', async () => {
            const created = await service.create('u1', validInput());
            await service.activate('u1', created.id);
            const dto = await service.update('u1', created.id, {
                outcome: GoalOutcome.ABANDONED,
            });
            expect(dto.outcome).toBe(GoalOutcome.ABANDONED);
            expect(dto.status).toBe(GoalStatus.COMPLETED);
            expect(dto.nextCheckAt).toBeNull();
        });

        it('clearing the outcome (null) leaves status COMPLETED unchanged', async () => {
            const created = await service.create('u1', validInput());
            await service.activate('u1', created.id);
            await service.update('u1', created.id, { outcome: GoalOutcome.ACHIEVED });
            const cleared = await service.update('u1', created.id, { outcome: null });
            expect(cleared.outcome).toBeNull();
            expect(cleared.status).toBe(GoalStatus.COMPLETED);
        });

        it('rejects an invalid outcome value', async () => {
            const created = await service.create('u1', validInput());
            await expect(
                service.update('u1', created.id, { outcome: 'winning' as never }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('ownership (404-no-leak)', () => {
        it('getForUser: 404 when the goal belongs to another user', async () => {
            const created = await service.create('alice', validInput());
            await expect(service.getForUser('bob', created.id)).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('delete: 404 when the goal does not exist', async () => {
            await expect(
                service.delete('u1', '00000000-0000-0000-0000-000000000000'),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    describe('evaluateNow', () => {
        it('rejects when the goal is not ACTIVE', async () => {
            const created = await service.create('u1', validInput());
            await expect(service.evaluateNow('u1', created.id)).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(evaluationService.evaluateOne).not.toHaveBeenCalled();
        });

        it('delegates to GoalEvaluationService for an ACTIVE goal and returns entry + fresh goal', async () => {
            const created = await service.create('u1', validInput());
            await service.activate('u1', created.id);
            evaluationService.evaluateOne.mockResolvedValue({
                goalId: created.id,
                outcome: 'evaluated',
                value: 42,
            });
            const res = await service.evaluateNow('u1', created.id);
            expect(evaluationService.evaluateOne).toHaveBeenCalledTimes(1);
            expect(res.entry).toEqual({ goalId: created.id, outcome: 'evaluated', value: 42 });
            expect(res.goal.id).toBe(created.id);
        });
    });

    describe('linkToMission — one-primary-per-Mission (FR-11)', () => {
        beforeEach(() => {
            missionsRepo._rows.push({ id: 'm1', userId: 'u1' });
            goalsRepo._rows.push(makeGoalRow({ id: 'gA', userId: 'u1' }));
            goalsRepo._rows.push(makeGoalRow({ id: 'gB', userId: 'u1' }));
        });

        it('promoting a second primary demotes the prior primary edge', async () => {
            const link1 = await service.linkToMission('u1', 'm1', 'gA', true);
            expect(link1.isPrimary).toBe(true);

            const link2 = await service.linkToMission('u1', 'm1', 'gB', true);
            expect(link2.isPrimary).toBe(true);

            const rowA = missionGoalsRepo._rows.find((r) => r.goalId === 'gA');
            const rowB = missionGoalsRepo._rows.find((r) => r.goalId === 'gB');
            expect(rowA?.isPrimary).toBe(false);
            expect(rowB?.isPrimary).toBe(true);
            // Exactly one primary edge remains on the mission.
            expect(missionGoalsRepo._rows.filter((r) => r.isPrimary === true)).toHaveLength(1);
        });

        it('re-linking the same (mission, goal) is idempotent and only flips isPrimary', async () => {
            await service.linkToMission('u1', 'm1', 'gA', true);
            const relink = await service.linkToMission('u1', 'm1', 'gA', false);
            expect(relink.isPrimary).toBe(false);
            // No duplicate edge row was created.
            expect(missionGoalsRepo._rows.filter((r) => r.goalId === 'gA')).toHaveLength(1);
        });

        it('404s when the mission is not owned by the user', async () => {
            await expect(service.linkToMission('bob', 'm1', 'gA', false)).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('404s when the goal is not owned by the user', async () => {
            await expect(service.linkToMission('u1', 'm1', 'ghost', false)).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });
});
