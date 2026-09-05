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
    const matches = (
        row: AnyRow,
        where: Record<string, unknown> | Record<string, unknown>[] = {},
    ) => {
        if (Array.isArray(where)) return where.some((branch) => matches(row, branch));
        return Object.entries(where).every(([k, value]) => {
            if (typeof value === 'object' && value !== null) {
                const op = value as { _type?: string; _value?: unknown };
                if (op._type === 'isNull') return row[k] == null;
                if (op._type === 'in') return (op._value as unknown[]).includes(row[k]);
            }
            return row[k] === value;
        });
    };
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
        goalKind: 'metric',
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

/** A delivery Goal (self-build slice AG): no metric, an approved DoD. */
const DELIVERY_DOD = [
    { id: 'api', text: 'API endpoint merged', status: 'open' as const },
    { id: 'web', text: 'Web form merged', status: 'open' as const },
];

function deliveryInput(overrides: Partial<CreateGoalInput> = {}): CreateGoalInput {
    return {
        title: 'Ship feature X across three repos',
        goalKind: 'delivery',
        dodCriteria: DELIVERY_DOD,
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

        it('demotes a legacy (pre-stamping) primary edge when promoting under an Organization scope', async () => {
            const EVER = { tenantId: 't-ever', organizationId: 'o-ever' };
            missionsRepo._rows.push({ id: 'm-ever', userId: 'u1', ...EVER });
            goalsRepo._rows.push(makeGoalRow({ id: 'gEver', userId: 'u1', ...EVER } as never));
            // Edge created before scope stamping: null/null yet still the
            // Mission's primary. The one-primary invariant (and the Postgres
            // partial unique index uq_mission_goals_primary) is per-MISSION
            // and knows nothing about stamps, so the demotion query must see
            // this row - a scope-filtered demote would miss it and the new
            // primary's save would hit the index and 500.
            missionGoalsRepo._rows.push({
                id: 'edge-legacy',
                missionId: 'm-ever',
                goalId: 'gA',
                userId: 'u1',
                isPrimary: true,
                tenantId: null,
                organizationId: null,
                createdAt: new Date('2026-07-19T00:00:00.000Z'),
            });

            const link = await service.linkToMission('u1', 'm-ever', 'gEver', true, EVER);
            expect(link.isPrimary).toBe(true);
            expect(missionGoalsRepo._rows.find((r) => r.id === 'edge-legacy')?.isPrimary).toBe(
                false,
            );
            expect(
                missionGoalsRepo._rows.filter((r) => r.missionId === 'm-ever' && r.isPrimary),
            ).toHaveLength(1);
        });

        it('lists and unlinks a legacy (pre-stamping) edge of an in-scope Mission and Goal', async () => {
            const EVER = { tenantId: 't-ever', organizationId: 'o-ever' };
            missionsRepo._rows.push({ id: 'm-ever', userId: 'u1', ...EVER });
            goalsRepo._rows.push(makeGoalRow({ id: 'gEver', userId: 'u1', ...EVER } as never));
            missionGoalsRepo._rows.push({
                id: 'edge-legacy',
                missionId: 'm-ever',
                goalId: 'gEver',
                userId: 'u1',
                isPrimary: false,
                tenantId: null,
                organizationId: null,
                createdAt: new Date('2026-07-19T00:00:00.000Z'),
            });

            // Both endpoints are visible in the active scope; the edge is a
            // pure join row and must follow them, not its own stamp
            // (upgrade-from-account backfills missions but not
            // mission_goals).
            const links = await service.listForMission('u1', 'm-ever', EVER);
            expect(links).toHaveLength(1);
            expect(links[0]).toMatchObject({ goalId: 'gEver', missionId: 'm-ever' });

            await expect(service.unlinkFromMission('u1', 'm-ever', 'gEver', EVER)).resolves.toEqual(
                { deleted: true },
            );
            expect(missionGoalsRepo._rows.find((r) => r.id === 'edge-legacy')).toBeUndefined();
        });

        it('hides a link whose Goal is not visible in the active scope (no goalId disclosure)', async () => {
            const EVER = { tenantId: 't-ever', organizationId: 'o-ever' };
            missionsRepo._rows.push({ id: 'm-ever', userId: 'u1', ...EVER });
            // The linked Goal lives in ANOTHER workspace of the same user.
            goalsRepo._rows.push(
                makeGoalRow({
                    id: 'gYo',
                    userId: 'u1',
                    tenantId: 't-ever',
                    organizationId: 'o-yo',
                } as never),
            );
            missionGoalsRepo._rows.push({
                id: 'edge-cross',
                missionId: 'm-ever',
                goalId: 'gYo',
                userId: 'u1',
                isPrimary: false,
                tenantId: 't-ever',
                organizationId: 'o-yo',
                createdAt: new Date('2026-07-19T00:00:00.000Z'),
            });

            await expect(service.listForMission('u1', 'm-ever', EVER)).resolves.toEqual([]);
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

        it('does not link a known Goal UUID from another active Organization', async () => {
            const everScope = {
                tenantId: '11111111-1111-4111-8111-111111111111',
                organizationId: '22222222-2222-4222-8222-222222222222',
            };
            missionsRepo._rows[0] = { ...missionsRepo._rows[0], ...everScope };
            goalsRepo._rows[0] = { ...goalsRepo._rows[0], ...everScope };
            goalsRepo._rows[1] = {
                ...goalsRepo._rows[1],
                tenantId: everScope.tenantId,
                organizationId: '33333333-3333-4333-8333-333333333333',
            };

            await expect(
                (service.linkToMission as any)('u1', 'm1', 'gB', true, everScope),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(missionGoalsRepo._rows).toHaveLength(0);
        });

        it('stamps a Mission-Goal edge with the exact active Organization', async () => {
            const everScope = {
                tenantId: '11111111-1111-4111-8111-111111111111',
                organizationId: '22222222-2222-4222-8222-222222222222',
            };
            missionsRepo._rows[0] = { ...missionsRepo._rows[0], ...everScope };
            goalsRepo._rows[0] = { ...goalsRepo._rows[0], ...everScope };

            const linked = await (service.linkToMission as any)('u1', 'm1', 'gA', true, everScope);

            expect(missionGoalsRepo._rows[0]).toMatchObject(everScope);
            expect(linked).toMatchObject(everScope);
            expect(linked.goal).toMatchObject(everScope);
        });
    });

    // ── Self-build slice AG (EW-795): the delivery kind ────────────────

    describe('create — delivery kind', () => {
        it('persists a DRAFT delivery Goal with NULL metric fields, a total window and the normalized DoD', async () => {
            const dto = await service.create('u1', deliveryInput());

            expect(dto.goalKind).toBe('delivery');
            expect(dto.status).toBe(GoalStatus.DRAFT);
            expect(dto.nextCheckAt).toBeNull();
            expect(dto.metricSource).toBeNull();
            expect(dto.comparator).toBeNull();
            expect(dto.targetValue).toBeNull();
            expect(dto.unit).toBeNull();
            expect(dto.window).toBe('total');
            expect(dto.baselineValue).toBeNull();
            expect(dto.dodCriteria).toHaveLength(2);
            expect(dto.dodCriteria?.[0]).toMatchObject({
                id: 'api',
                text: 'API endpoint merged',
                status: 'open',
                source: 'operator',
            });
            expect(dto.dodSummary).toMatchObject({ total: 2, open: 2, complete: false });
            // The row really carries NULLs (what the nullable columns store),
            // not a missing key.
            expect(goalsRepo._rows[0]).toMatchObject({
                goalKind: 'delivery',
                metricSource: null,
                comparator: null,
                targetValue: null,
                unit: null,
                criteria: null,
                constraints: null,
            });
        });

        it('accepts explicit nulls for the metric fields (absent-or-null is the wire contract)', async () => {
            const dto = await service.create(
                'u1',
                deliveryInput({
                    metricSource: null,
                    comparator: null,
                    targetValue: null,
                    unit: null,
                    window: null,
                }),
            );
            expect(dto.goalKind).toBe('delivery');
        });

        it('rejects a delivery Goal without a Definition of Done', async () => {
            for (const dodCriteria of [undefined, null, []]) {
                await expect(
                    service.create('u1', deliveryInput({ dodCriteria })),
                ).rejects.toBeInstanceOf(BadRequestException);
            }
            expect(goalsRepo._rows).toHaveLength(0);
        });

        it.each([
            ['targetValue', { targetValue: 1000 }],
            ['metricSource', { metricSource: { pluginId: 'stripe', metricId: 'income' } }],
            ['comparator', { comparator: 'gte' }],
            ['unit', { unit: 'usd' }],
            ['window', { window: 'month' }],
            ['baselineValue', { baselineValue: 5 }],
            ['criteria', { criteria: [] }],
            ['constraints', { constraints: [] }],
        ] as Array<[string, Partial<CreateGoalInput>]>)(
            'rejects a delivery Goal that carries the metric-only field %s',
            async (_field, extra) => {
                await expect(service.create('u1', deliveryInput(extra))).rejects.toBeInstanceOf(
                    BadRequestException,
                );
                expect(goalsRepo._rows).toHaveLength(0);
            },
        );

        it('rejects a delivery Goal born with proposed (unapproved) criteria', async () => {
            await expect(
                service.create(
                    'u1',
                    deliveryInput({
                        dodCriteria: [{ id: 'a', text: 'x', status: 'open', proposed: true }],
                    }),
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects a malformed Definition of Done', async () => {
            await expect(
                service.create(
                    'u1',
                    deliveryInput({
                        dodCriteria: [{ id: '', text: 'x', status: 'open' }] as never,
                    }),
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects an unknown goalKind without coercing it', async () => {
            await expect(
                service.create('u1', validInput({ goalKind: 'outcome' as never })),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(goalsRepo._rows).toHaveLength(0);
        });

        it('still requires every metric field for an explicit metric kind', async () => {
            await expect(
                service.create('u1', validInput({ goalKind: 'metric', targetValue: undefined })),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                service.create('u1', validInput({ goalKind: 'metric', unit: undefined })),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                service.create('u1', validInput({ goalKind: 'metric', comparator: undefined })),
            ).rejects.toBeInstanceOf(BadRequestException);
            // The e2e validation matrix pins this exact message for a missing source.
            await expect(
                service.create('u1', validInput({ goalKind: 'metric', metricSource: undefined })),
            ).rejects.toThrow('metricSource must be an object.');
        });

        it('defaults an omitted goalKind to metric and keeps an optional seed checklist', async () => {
            const bare = await service.create('u1', validInput());
            expect(bare.goalKind).toBe('metric');
            expect(bare.dodCriteria).toBeNull();

            const seeded = await service.create(
                'u1',
                validInput({
                    dodCriteria: [{ id: 'docs', text: 'Write the docs', status: 'open' }],
                }),
            );
            expect(seeded.goalKind).toBe('metric');
            expect(seeded.targetValue).toBe(1000);
            expect(seeded.dodCriteria).toHaveLength(1);
        });
    });

    describe('activate / update — delivery kind', () => {
        it('activates a delivery Goal with no metric source at all and schedules the first check', async () => {
            const created = await service.create('u1', deliveryInput());
            const dto = await service.activate('u1', created.id);
            expect(dto.status).toBe(GoalStatus.ACTIVE);
            expect(dto.outcome).toBeNull();
            // Scheduled like a metric Goal so deadline → MISSED still works
            // without a plugin; the tick itself reads no provider.
            expect(dto.nextCheckAt).not.toBeNull();
        });

        it('refuses to activate a delivery Goal whose criteria are all still proposed', async () => {
            goalsRepo._rows.push(
                makeGoalRow({
                    id: 'gdel',
                    goalKind: 'delivery',
                    metricSource: null,
                    comparator: null,
                    targetValue: null,
                    unit: null,
                    window: 'total',
                    dodCriteria: [{ id: 'a', text: 'x', status: 'open', proposed: true }],
                }),
            );
            await expect(service.activate('u1', 'gdel')).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(goalsRepo._rows[0].status).toBe(GoalStatus.DRAFT);
        });

        it('refuses to activate a delivery Goal with no Definition of Done at all', async () => {
            goalsRepo._rows.push(
                makeGoalRow({
                    id: 'gdel',
                    goalKind: 'delivery',
                    metricSource: null,
                    comparator: null,
                    targetValue: null,
                    unit: null,
                    window: 'total',
                    dodCriteria: null,
                }),
            );
            await expect(service.activate('u1', 'gdel')).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('refuses to give a delivery Goal a metric target — even as a null "clear"', async () => {
            const created = await service.create('u1', deliveryInput());
            await expect(
                service.update('u1', created.id, { targetValue: 5 }),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                service.update('u1', created.id, {
                    metricSource: { pluginId: 'stripe', metricId: 'income' },
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                service.update('u1', created.id, { comparator: 'gte' }),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                service.update('u1', created.id, { baselineValue: null }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(goalsRepo._rows[0]).toMatchObject({ targetValue: null, metricSource: null });
        });

        it('still lets a delivery Goal change its title and take a human outcome override', async () => {
            const created = await service.create('u1', deliveryInput());
            const renamed = await service.update('u1', created.id, { title: '  Ship it  ' });
            expect(renamed.title).toBe('Ship it');

            await service.activate('u1', created.id);
            const abandoned = await service.update('u1', created.id, {
                outcome: GoalOutcome.ABANDONED,
            });
            expect(abandoned.outcome).toBe(GoalOutcome.ABANDONED);
            expect(abandoned.status).toBe(GoalStatus.COMPLETED);
            expect(abandoned.nextCheckAt).toBeNull();
        });

        it('metric Goals keep their metric-field updates', async () => {
            const created = await service.create('u1', validInput());
            const updated = await service.update('u1', created.id, { targetValue: 2500 });
            expect(updated.targetValue).toBe(2500);
        });
    });
});
