import { randomUUID } from 'node:crypto';
import { UnprocessableEntityException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DomainEvent } from '../../entities/domain-event.entity';
import { Goal, GoalStatus } from '../../entities/goal.entity';
import { GoalMetricSample } from '../../entities/goal-metric-sample.entity';
import { MissionGoal } from '../../entities/mission-goal.entity';
import { Mission } from '../../entities/mission.entity';
import { Team } from '../../entities/team.entity';
import { GoalEvaluationService } from '../../goals/goal-evaluation.service';
import { GOAL_PROGRESS_EVENT_MIN_INTERVAL_MS } from '../../goals/goal-domain-events';
import { GoalsService } from '../../goals/goals.service';
import { RecordVisibilityService } from '../../record-visibility/record-visibility.service';
import {
    AggregateVersionConflictError,
    runExpectingAggregateVersion,
} from '../domain-event-context';
import { DomainEventPublisher } from '../domain-event-publisher.service';
import { DomainEventRecorder } from '../domain-event-recorder.service';
import {
    catalogDataValidator,
    createDomainEventsDataSource,
    ORG_A,
    resetDomainEventsTables,
    TENANT,
} from './domain-events.test-helpers';

/**
 * Goal recording points (EW-P2-2) on SQLite: the real `GoalsService` and
 * `GoalEvaluationService` with the real publisher. Every `goal.*` event carries the
 * next `aggregate.version` and `data` valid against the goal schema the catalog
 * names. Integration creates are `draft` and external-only (D9); external samples
 * drive `currentValue` and the criterion scores; `goal.progress_changed` is
 * throttled while the version still moves.
 */
describe('goal recording points', () => {
    let dataSource: DataSource;
    let goals: GoalsService;
    let evaluation: GoalEvaluationService;
    let metrics: { getMetricValue: jest.Mock };
    const expectValid = catalogDataValidator();
    const OWNER = randomUUID();
    const KEY = randomUUID();
    const scope = { tenantId: TENANT, organizationId: ORG_A };

    const events = async () =>
        dataSource.getRepository(DomainEvent).find({ order: { outboxSeq: 'ASC' } });

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        const recorder = new DomainEventRecorder();
        const publisher = new DomainEventPublisher(recorder, dataSource);
        metrics = { getMetricValue: jest.fn() };
        evaluation = new GoalEvaluationService(
            dataSource.getRepository(Goal),
            dataSource.getRepository(GoalMetricSample),
            metrics as never,
            undefined,
            publisher,
        );
        goals = new GoalsService(
            dataSource.getRepository(Goal),
            dataSource.getRepository(GoalMetricSample),
            dataSource.getRepository(MissionGoal),
            dataSource.getRepository(Mission),
            evaluation,
            undefined,
            publisher,
            new RecordVisibilityService(dataSource, recorder),
        );
    });

    beforeEach(async () => {
        await resetDomainEventsTables(dataSource);
        for (const table of ['goal_metric_samples', 'goals', 'team_resources']) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
        metrics.getMetricValue.mockReset();
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const external = (overrides: Record<string, unknown> = {}) =>
        goals.createExternal(
            OWNER,
            {
                title: 'Grow paying customers',
                goalKind: 'metric',
                metricSource: { pluginId: 'external', metricId: 'value' },
                comparator: 'gte',
                targetValue: 120,
                unit: 'customers',
                window: 'point',
                createdBy: { type: 'integration', id: KEY },
                ...overrides,
            } as never,
            scope,
        );

    it('createExternal runs withinCreate in its transaction: a throw rolls the Goal and its event back', async () => {
        let seen: unknown;
        await expect(
            goals.createExternal(
                OWNER,
                {
                    title: 'Linked',
                    goalKind: 'metric',
                    metricSource: { pluginId: 'external', metricId: 'value' },
                    comparator: 'gte',
                    targetValue: 1,
                    unit: 'customers',
                    window: 'point',
                    createdBy: { type: 'integration', id: KEY },
                } as never,
                scope,
                {
                    withinCreate: async (goal, manager) => {
                        seen = await manager.getRepository(Goal).findOneBy({ id: goal.id });
                        throw new Error('the link lost its race');
                    },
                },
            ),
        ).rejects.toThrow('the link lost its race');
        // The row existed inside the transaction, and is gone after it.
        expect(seen).toBeTruthy();
        expect(await dataSource.getRepository(Goal).count()).toBe(0);
        expect(await events()).toEqual([]);
    });

    it('createExternal stores a draft Goal and records goal.created at version 1, with its Teams (D11)', async () => {
        const team = await dataSource.getRepository(Team).save(
            dataSource.getRepository(Team).create({
                userId: OWNER,
                name: 'Growth',
                slug: 'growth',
                tenantId: TENANT,
                organizationId: ORG_A,
            } as Partial<Team>),
        );
        const goal = await external({ teamIds: [team.id] });
        expect(goal).toMatchObject({ status: GoalStatus.DRAFT, organizationId: ORG_A });
        const [created, ...rest] = await events();
        // Review 2026-10-17 F34: the Team's own side follows the record's event.
        expect(rest.map((event) => [event.type, event.aggregateId])).toEqual([
            ['team.resource.added', team.id],
        ]);
        expectValid(rest[0]);
        expect(created).toMatchObject({
            type: 'goal.created',
            aggregateType: 'goal',
            aggregateId: goal.id,
            aggregateVersion: 1,
            visibility: 'team',
        });
        expect(created.data).toMatchObject({
            status: 'draft',
            teamIds: [team.id],
            createdBy: { type: 'integration', id: KEY },
            metricSource: { pluginId: 'external', metricId: 'value' },
        });
        expectValid(created);
    });

    it('createExternal without Teams or a visibility derives `organization`, never the column default `private`', async () => {
        const goal = await external();
        const stored = await dataSource.getRepository(Goal).findOneByOrFail({ id: goal.id });
        expect(stored).toMatchObject({ visibility: 'organization', visibilityExplicit: false });
        const [created] = await events();
        expect(created).toMatchObject({ type: 'goal.created', visibility: 'organization' });
        expectValid(created);
    });

    it('refuses a provider metric source from an integration (422) and writes nothing', async () => {
        await expect(
            external({ metricSource: { pluginId: 'stripe', metricId: 'income' } }),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
        await expect(
            external({
                criteria: [
                    {
                        id: 'kr',
                        name: 'Revenue',
                        weight: 1,
                        target: 10,
                        direction: 'gte',
                        metricSource: { pluginId: 'stripe', metricId: 'income' },
                    },
                ],
            }),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(await dataSource.getRepository(Goal).count()).toBe(0);
        expect(await events()).toHaveLength(0);
    });

    it('an external sample drives currentValue and the baseline, recording goal.progress_changed', async () => {
        const goal = await external();
        const at = new Date(Date.now() - 60_000);
        const dto = await goals.recordExternalSample(
            OWNER,
            goal.id,
            { value: 96, sampledAt: at },
            scope,
        );
        expect(dto).toMatchObject({ currentValue: 96, baselineValue: 96, status: 'draft' });
        const progress = (await events()).filter((event) => event.type === 'goal.progress_changed');
        expect(progress).toHaveLength(1);
        expect(progress[0]).toMatchObject({ aggregateVersion: 2 });
        expect(progress[0].data).toMatchObject({ currentValue: 96 });
        expectValid(progress[0]);
        expect(await dataSource.getRepository(GoalMetricSample).count()).toBe(1);
    });

    it('throttles goal.progress_changed to one per 5 minutes; the version still moves', async () => {
        expect(GOAL_PROGRESS_EVENT_MIN_INTERVAL_MS).toBe(5 * 60_000);
        const goal = await external();
        await goals.recordExternalSample(
            OWNER,
            goal.id,
            { value: 90, sampledAt: new Date() },
            scope,
        );
        await goals.recordExternalSample(
            OWNER,
            goal.id,
            { value: 91, sampledAt: new Date() },
            scope,
        );
        const progress = (await events()).filter((event) => event.type === 'goal.progress_changed');
        expect(progress).toHaveLength(1);
        const row = await dataSource.getRepository(Goal).findOneByOrFail({ id: goal.id });
        expect(row).toMatchObject({ currentValue: 91, version: 3 });
    });

    it('an older sample is kept as history but does not replace the newer currentValue', async () => {
        const goal = await external();
        await goals.recordExternalSample(
            OWNER,
            goal.id,
            { value: 100, sampledAt: new Date() },
            scope,
        );
        await goals.recordExternalSample(
            OWNER,
            goal.id,
            { value: 50, sampledAt: new Date(Date.now() - 3_600_000) },
            scope,
        );
        const row = await dataSource.getRepository(Goal).findOneByOrFail({ id: goal.id });
        expect(row.currentValue).toBe(100);
        expect(await dataSource.getRepository(GoalMetricSample).count()).toBe(2);
    });

    it('a criterion sample re-scores the Goal from the pushed values', async () => {
        const goal = await external({
            criteria: [
                { id: 'kr-signups', name: 'Signups', weight: 1, target: 50, direction: 'gte' },
                { id: 'kr-churn', name: 'Churn', weight: 1, target: 2, direction: 'lte' },
            ],
        });
        const dto = await goals.recordExternalSample(
            OWNER,
            goal.id,
            { criterionId: 'kr-signups', value: 25, sampledAt: new Date() },
            scope,
        );
        const signups = dto.resolvedScore?.criteria.find((entry) => entry.id === 'kr-signups');
        expect(signups).toMatchObject({ value: 25, ratio: 0.5, satisfied: false });
        await expect(
            goals.recordExternalSample(
                OWNER,
                goal.id,
                { criterionId: 'nope', value: 1, sampledAt: new Date() },
                scope,
            ),
        ).rejects.toThrow('not found');
        const [sample] = await dataSource.getRepository(GoalMetricSample).find();
        expect(sample.criterionId).toBe('kr-signups');
    });

    // Review 2026-10-17 F48: a criterion's samples are another series, not the Goal's own.
    it("the Goal's sample history leaves out the per-criterion samples", async () => {
        const goal = await external({
            criteria: [{ id: 'kr-nps', name: 'NPS', weight: 1, target: 50, direction: 'gte' }],
        });
        await goals.recordExternalSample(
            OWNER,
            goal.id,
            { value: 120, sampledAt: new Date() },
            scope,
        );
        await goals.recordExternalSample(
            OWNER,
            goal.id,
            { criterionId: 'kr-nps', value: 40, sampledAt: new Date() },
            scope,
        );
        const history = await goals.listSamples(OWNER, goal.id, 100, scope);
        expect(history.map((sample) => sample.value)).toEqual([120]);
    });

    it('a provider Goal takes no external sample (422)', async () => {
        const goal = await goals.create(
            OWNER,
            {
                title: 'Income',
                metricSource: { pluginId: 'stripe', metricId: 'income' },
                comparator: 'gte',
                targetValue: 1000,
                unit: 'USD',
                window: 'month',
            },
            scope,
        );
        await expect(
            goals.recordExternalSample(OWNER, goal.id, { value: 1, sampledAt: new Date() }, scope),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('update records goal.updated; an outcome override records goal.status_changed', async () => {
        const goal = await external();
        await goals.update(OWNER, goal.id, { targetValue: 150 }, scope);
        await goals.update(OWNER, goal.id, { outcome: 'abandoned' as never }, scope);
        const recorded = (await events()).filter((event) => event.type !== 'goal.created');
        expect(recorded.map((event) => [event.type, event.aggregateVersion])).toEqual([
            ['goal.updated', 2],
            ['goal.status_changed', 3],
        ]);
        expect(recorded[0].changedFields).toEqual(['targetValue']);
        expect(recorded[1].previous).toEqual({ status: 'draft' });
        for (const event of recorded) expectValid(event);
    });

    it('a stale If-Match version rolls the update back with its event', async () => {
        const goal = await external();
        await expect(
            runExpectingAggregateVersion({ aggregateType: 'goal', id: goal.id, version: 9 }, () =>
                goals.update(OWNER, goal.id, { title: 'Stale' }, scope),
            ),
        ).rejects.toBeInstanceOf(AggregateVersionConflictError);
        const row = await dataSource.getRepository(Goal).findOneByOrFail({ id: goal.id });
        expect(row).toMatchObject({ title: 'Grow paying customers', version: 1 });
        expect((await events()).map((event) => event.type)).toEqual(['goal.created']);
    });

    it('activate and pause record goal.status_changed with the previous status', async () => {
        const goal = await external();
        await goals.activate(OWNER, goal.id, scope);
        await goals.pause(OWNER, goal.id, scope);
        const recorded = (await events()).filter((event) => event.type === 'goal.status_changed');
        expect(recorded.map((event) => event.previous)).toEqual([
            { status: 'draft' },
            { status: 'active' },
        ]);
    });

    it('evaluating an ACTIVE external Goal reads the pushed value, never a provider, and records the outcome', async () => {
        const goal = await external({ targetValue: 100 });
        await goals.activate(OWNER, goal.id, scope);
        await goals.recordExternalSample(
            OWNER,
            goal.id,
            { value: 120, sampledAt: new Date() },
            scope,
        );
        const row = await dataSource.getRepository(Goal).findOneByOrFail({ id: goal.id });
        const entry = await evaluation.evaluateOne(row);
        expect(entry).toMatchObject({ outcome: 'achieved', value: 120 });
        expect(metrics.getMetricValue).not.toHaveBeenCalled();
        // The pushed sample is the observation: no extra sample row.
        expect(await dataSource.getRepository(GoalMetricSample).count()).toBe(1);
        const completed = (await events()).filter(
            (event) => event.type === 'goal.status_changed' && event.previous?.status === 'active',
        );
        expect(completed).toHaveLength(1);
        expect(completed[0].data).toMatchObject({ status: 'completed', outcome: 'achieved' });
    });

    it('an evaluation of the scanned copy never writes back a sample pushed after the scan', async () => {
        const goal = await external({ targetValue: 100 });
        await goals.activate(OWNER, goal.id, scope);
        await goals.recordExternalSample(
            OWNER,
            goal.id,
            { value: 10, sampledAt: new Date() },
            scope,
        );
        // The due scan's copy, then a newer sample lands before the evaluation saves.
        const scanned = await dataSource.getRepository(Goal).findOneByOrFail({ id: goal.id });
        await goals.recordExternalSample(
            OWNER,
            goal.id,
            { value: 40, sampledAt: new Date() },
            scope,
        );
        await evaluation.evaluateOne(scanned);
        const stored = await dataSource.getRepository(Goal).findOneByOrFail({ id: goal.id });
        expect(Number(stored.currentValue)).toBe(40);
        expect(stored.status).toBe(GoalStatus.ACTIVE);
        // The version only moves forward (the stale copy's is never written back).
        expect(Number(stored.version)).toBeGreaterThan(Number(scanned.version));
    });

    it('delete records goal.deleted with the last snapshot at a version claimed first', async () => {
        const goal = await external();
        await goals.delete(OWNER, goal.id, scope);
        const deleted = (await events()).find((event) => event.type === 'goal.deleted');
        expect(deleted).toMatchObject({ aggregateId: goal.id, aggregateVersion: 2 });
        expect(deleted?.data).toMatchObject({ id: goal.id, deleted: true });
        expectValid(deleted!);
        expect(await dataSource.getRepository(Goal).findOneBy({ id: goal.id })).toBeNull();
    });
});
