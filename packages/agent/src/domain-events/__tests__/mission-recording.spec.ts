import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { DomainEvent } from '../../entities/domain-event.entity';
import { Goal } from '../../entities/goal.entity';
import { GoalMetricSample } from '../../entities/goal-metric-sample.entity';
import { Mission, MissionStatus, MissionType } from '../../entities/mission.entity';
import { MissionGoal } from '../../entities/mission-goal.entity';
import { MissionWork } from '../../entities/mission-work.entity';
import { Team } from '../../entities/team.entity';
import { Work } from '../../entities/work.entity';
import {
    WorkProposal,
    WorkProposalSource,
    WorkProposalStatus,
} from '../../entities/work-proposal.entity';
import { MissionWorkRepository } from '../../database/repositories/mission-work.repository';
import { GoalsService } from '../../goals/goals.service';
import { MissionCloneService } from '../../missions/mission-clone.service';
import { MissionsService } from '../../missions/missions.service';
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
 * Mission recording points (EW-P2-5) on SQLite with the real publisher:
 * `MissionsService` (create, integration create, update, transitions, delete,
 * typed Work links), `GoalsService` Mission ↔ Goal links and the clone. Every
 * `mission.*` event carries the next `aggregate.version` and `data` valid against
 * the catalog's schema; link events are children of the Mission.
 */
describe('mission recording points', () => {
    let dataSource: DataSource;
    let missions: MissionsService;
    let goals: GoalsService;
    let clones: MissionCloneService;
    const expectValid = catalogDataValidator();
    const OWNER = randomUUID();
    const KEY = randomUUID();
    const scope = { tenantId: TENANT, organizationId: ORG_A };
    const titler = { generateTitle: jest.fn(async () => 'Generated') };

    const events = async () =>
        dataSource.getRepository(DomainEvent).find({ order: { outboxSeq: 'ASC' } });

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        const recorder = new DomainEventRecorder();
        const publisher = new DomainEventPublisher(recorder, dataSource);
        const visibility = new RecordVisibilityService(dataSource, recorder);
        const u = undefined as never;
        missions = new MissionsService(
            dataSource.getRepository(Mission),
            titler as never,
            u,
            u,
            u,
            new MissionWorkRepository(dataSource.getRepository(MissionWork)),
            dataSource.getRepository(Work),
            u,
            u,
            publisher,
            visibility,
        );
        goals = new GoalsService(
            dataSource.getRepository(Goal),
            dataSource.getRepository(GoalMetricSample),
            dataSource.getRepository(MissionGoal),
            dataSource.getRepository(Mission),
            u,
            undefined,
            publisher,
            visibility,
        );
        clones = new MissionCloneService(
            dataSource.getRepository(Mission),
            dataSource.getRepository(WorkProposal),
            publisher,
        );
    });

    beforeEach(async () => {
        await resetDomainEventsTables(dataSource);
        for (const table of [
            'mission_goals',
            'mission_works',
            'work_proposals',
            'goals',
            'missions',
            'works',
            'team_resources',
        ]) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const external = (overrides: Record<string, unknown> = {}) =>
        missions.createExternal(
            OWNER,
            {
                title: 'Win the SMB market',
                description: 'From Gauzy.',
                createdBy: { type: 'integration', id: KEY },
                ...overrides,
            },
            scope,
        );

    it('createExternal runs withinCreate in its transaction: a throw rolls the Mission and its event back', async () => {
        let seen: unknown;
        await expect(
            missions.createExternal(
                OWNER,
                {
                    title: 'Linked',
                    description: 'From Gauzy.',
                    createdBy: { type: 'integration', id: KEY },
                },
                scope,
                {
                    withinCreate: async (mission, manager) => {
                        seen = await manager.getRepository(Mission).findOneBy({ id: mission.id });
                        throw new Error('the link lost its race');
                    },
                },
            ),
        ).rejects.toThrow('the link lost its race');
        // The row existed inside the transaction, and is gone after it.
        expect(seen).toBeTruthy();
        expect(await dataSource.getRepository(Mission).count()).toBe(0);
        expect(await events()).toEqual([]);
    });

    it('createExternal stores a PAUSED one-shot Mission with no auto-build and records mission.created', async () => {
        const team = await dataSource.getRepository(Team).save(
            dataSource.getRepository(Team).create({
                userId: OWNER,
                name: 'Sales',
                slug: 'sales',
                tenantId: TENANT,
                organizationId: ORG_A,
            } as Partial<Team>),
        );
        const mission = await external({ teamIds: [team.id] });
        expect(mission).toMatchObject({
            status: MissionStatus.PAUSED,
            type: MissionType.ONE_SHOT,
            autoBuildWorks: false,
            schedule: null,
        });
        expect(titler.generateTitle).not.toHaveBeenCalled();
        const [created, ...rest] = await events();
        expect(rest).toHaveLength(0);
        expect(created).toMatchObject({
            type: 'mission.created',
            aggregateVersion: 1,
            visibility: 'team',
        });
        expect(created.data).toMatchObject({
            status: 'paused',
            teamIds: [team.id],
            createdBy: { type: 'integration', id: KEY },
            goals: [],
            works: [],
        });
        expectValid(created);
    });

    it('update records mission.updated; a stale If-Match rolls it back', async () => {
        const mission = await external();
        await missions.update(OWNER, mission.id, { title: 'Win SMB' }, scope);
        await expect(
            runExpectingAggregateVersion(
                { aggregateType: 'mission', id: mission.id, version: 7 },
                () => missions.update(OWNER, mission.id, { title: 'Stale' }, scope),
            ),
        ).rejects.toBeInstanceOf(AggregateVersionConflictError);
        const row = await dataSource.getRepository(Mission).findOneByOrFail({ id: mission.id });
        expect(row).toMatchObject({ title: 'Win SMB', version: 2 });
        const updated = (await events()).filter((event) => event.type === 'mission.updated');
        expect(updated).toHaveLength(1);
        expect(updated[0].changedFields).toEqual(['title']);
        expectValid(updated[0]);
    });

    it('transitions record mission.status_changed with the previous status', async () => {
        const mission = await external();
        await missions.resume(OWNER, mission.id, scope);
        await missions.pause(OWNER, mission.id, scope);
        await missions.complete(OWNER, mission.id, 'cancelled' as never, scope);
        const moves = (await events()).filter((event) => event.type === 'mission.status_changed');
        expect(
            moves.map((event) => [event.previous, (event.data as { status: string }).status]),
        ).toEqual([
            [{ status: 'paused' }, 'active'],
            [{ status: 'active' }, 'paused'],
            [{ status: 'paused' }, 'completed'],
        ]);
        expect(moves[2].data).toMatchObject({ outcome: 'cancelled' });
        for (const event of moves) expectValid(event);
    });

    it('Work links record mission.work.linked / unlinked as children of the Mission', async () => {
        const mission = await external();
        const work = await dataSource.getRepository(Work).save(
            dataSource.getRepository(Work).create({
                userId: OWNER,
                name: 'Shop',
                slug: `shop-${randomUUID().slice(0, 6)}`,
                description: 'A shop',
                tenantId: TENANT,
                organizationId: ORG_A,
            } as Partial<Work>),
        );
        await missions.setWorks(
            OWNER,
            mission.id,
            [{ workId: work.id, relation: 'improves' }],
            scope,
        );
        // Idempotent: the same set records nothing.
        await missions.setWorks(
            OWNER,
            mission.id,
            [{ workId: work.id, relation: 'improves' }],
            scope,
        );
        await missions.setWorks(OWNER, mission.id, [], scope);
        const links = (await events()).filter((event) => event.type.startsWith('mission.work.'));
        expect(links.map((event) => [event.type, event.aggregateVersion])).toEqual([
            ['mission.work.linked', 2],
            ['mission.work.unlinked', 3],
        ]);
        expect(links[0].data).toEqual({
            missionId: mission.id,
            workId: work.id,
            relation: 'improves',
        });
        expect(links[1].data).toMatchObject({ deleted: true });
        for (const event of links) expectValid(event);
    });

    it("Goal links record mission.goal.linked / unlinked and the Goal's goal.updated", async () => {
        const mission = await external();
        const goal = await goals.createExternal(
            OWNER,
            {
                title: 'Grow',
                metricSource: { pluginId: 'external', metricId: 'value' },
                comparator: 'gte',
                targetValue: 10,
                unit: 'deals',
                window: 'point',
            },
            scope,
        );
        await goals.linkToMission(OWNER, mission.id, goal.id, true, scope);
        await goals.unlinkFromMission(OWNER, mission.id, goal.id, scope);
        const recorded = (await events()).filter(
            (event) => event.type.startsWith('mission.goal.') || event.type === 'goal.updated',
        );
        expect(recorded.map((event) => event.type)).toEqual([
            'mission.goal.linked',
            'goal.updated',
            'mission.goal.unlinked',
            'goal.updated',
        ]);
        expect(recorded[0].data).toEqual({
            missionId: mission.id,
            goalId: goal.id,
            isPrimary: true,
        });
        expect(recorded[1].data).toMatchObject({
            missionIds: [mission.id],
            primaryMissionId: mission.id,
        });
        expect(recorded[3].data).toMatchObject({ missionIds: [], primaryMissionId: null });
        for (const event of recorded) expectValid(event);
    });

    it('deleting a linked Goal records mission.goal.unlinked for its Mission', async () => {
        const mission = await external();
        const goal = await goals.createExternal(
            OWNER,
            {
                title: 'Grow',
                metricSource: { pluginId: 'external', metricId: 'value' },
                comparator: 'gte',
                targetValue: 10,
                unit: 'deals',
                window: 'point',
            },
            scope,
        );
        await goals.linkToMission(OWNER, mission.id, goal.id, true, scope);
        await resetDomainEventsTables(dataSource);
        await goals.delete(OWNER, goal.id, scope);
        const recorded = await events();
        expect(recorded.map((event) => [event.type, event.aggregateId])).toEqual([
            ['goal.deleted', goal.id],
            ['mission.goal.unlinked', mission.id],
        ]);
        expect(recorded[1].data).toMatchObject({
            missionId: mission.id,
            goalId: goal.id,
            isPrimary: true,
            deleted: true,
        });
        for (const event of recorded) expectValid(event);
    });

    it('delete records mission.deleted with the last snapshot', async () => {
        const mission = await external();
        await missions.delete(OWNER, mission.id, scope);
        const deleted = (await events()).find((event) => event.type === 'mission.deleted');
        expect(deleted).toMatchObject({ aggregateId: mission.id, aggregateVersion: 2 });
        expect(deleted?.data).toMatchObject({ id: mission.id, deleted: true });
        expectValid(deleted!);
    });

    it('delete also records goal.updated / idea.updated for the records its cascade changes', async () => {
        const mission = await external();
        const goal = await goals.createExternal(
            OWNER,
            {
                title: 'Grow',
                metricSource: { pluginId: 'external', metricId: 'value' },
                comparator: 'gte',
                targetValue: 10,
                unit: 'deals',
                window: 'point',
            },
            scope,
        );
        await goals.linkToMission(OWNER, mission.id, goal.id, true, scope);
        const idea = await dataSource.getRepository(WorkProposal).save(
            dataSource.getRepository(WorkProposal).create({
                userId: OWNER,
                tenantId: TENANT,
                organizationId: ORG_A,
                missionId: mission.id,
                title: 'Self-serve onboarding',
                description: 'An Idea of the deleted Mission.',
                slugSuggestion: 'onboarding',
                suggestedCategories: [],
                suggestedFields: [],
                recommendedPlugins: [],
                reasoning: 'test',
                source: WorkProposalSource.MISSION,
                status: WorkProposalStatus.PENDING,
            }),
        );
        await resetDomainEventsTables(dataSource);
        await missions.delete(OWNER, mission.id, scope);
        // The helper's SQLite runs with foreign keys OFF, so only the recording is pinned
        // here (the cascade itself is the migrations' ON DELETE rules).
        const recorded = await events();
        expect(recorded.map((event) => [event.type, event.aggregateId])).toEqual([
            ['mission.deleted', mission.id],
            ['goal.updated', goal.id],
            ['idea.updated', idea.id],
        ]);
        for (const event of recorded) expectValid(event);
    });

    it('a clone records mission.created and idea.created for every Idea it copies', async () => {
        const source = await external();
        await dataSource.getRepository(WorkProposal).save(
            dataSource.getRepository(WorkProposal).create({
                userId: OWNER,
                tenantId: TENANT,
                organizationId: ORG_A,
                missionId: source.id,
                title: 'Self-serve onboarding',
                description: 'An Idea of the source Mission.',
                slugSuggestion: 'onboarding',
                suggestedCategories: [],
                suggestedFields: [],
                recommendedPlugins: [],
                reasoning: 'test',
                source: WorkProposalSource.MISSION,
                status: WorkProposalStatus.PENDING,
            }),
        );
        await resetDomainEventsTables(dataSource);
        const result = await clones.cloneForUser(OWNER, source.id, {}, scope);
        const recorded = await events();
        expect(recorded.map((event) => event.type)).toEqual(['idea.created', 'mission.created']);
        expect(recorded[1]).toMatchObject({ aggregateId: result.mission.id });
        for (const event of recorded) expectValid(event);
    });
});
