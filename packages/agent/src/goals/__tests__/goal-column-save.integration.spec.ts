import type { DataSource, Repository } from 'typeorm';
import { Goal, GoalStatus } from '../../entities/goal.entity';
import { GoalEvent } from '../../entities/goal-event.entity';
import { Task } from '../../entities/task.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import {
    createDomainEventsDataSource,
    ORG_A,
    TENANT,
} from '../../domain-events/__tests__/domain-events.test-helpers';
import { saveGoalColumns } from '../goal-column-save';
import { GoalOrchestratorService } from '../goal-orchestrator.service';

/**
 * EW-P2-2 follow-up — the orchestrator's writes save only the columns they decide, on
 * real SQLite. A Goal copy read before a concurrent write (an integration PATCH, a pushed
 * sample, another loop control) must not write that write back, nor roll `version` back.
 */
describe('saveGoalColumns + the orchestrator writes (SQLite)', () => {
    const OWNER = '3d0c8f4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    let dataSource: DataSource;
    let goals: Repository<Goal>;

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        goals = dataSource.getRepository(Goal);
    });

    beforeEach(async () => {
        await dataSource.query('DELETE FROM "goals"');
        await dataSource.query('DELETE FROM "goal_events"');
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const newGoal = async () =>
        goals.save(
            goals.create({
                userId: OWNER,
                tenantId: TENANT,
                organizationId: ORG_A,
                title: 'Ship the integration',
                goalKind: 'delivery',
                window: 'total',
                status: GoalStatus.ACTIVE,
                loopStatus: 'running',
                spentCents: 0,
                dodCriteria: [{ id: 'c1', text: 'Merged', status: 'open' }],
                version: 3,
            } as Partial<Goal>),
        );

    it('writes only the named columns and keeps a concurrent write to the others', async () => {
        const { id } = await newGoal();
        const stale = await goals.findOneByOrFail({ id });
        // A concurrent write lands after the copy was read (and bumps the version).
        await goals.update({ id }, { title: 'Renamed by Ever Gauzy', spentCents: 70, version: 4 });

        stale.loopStatus = 'paused';
        const saved = await saveGoalColumns(goals, stale, ['loopStatus']);

        const row = await goals.findOneByOrFail({ id });
        expect(row).toMatchObject({
            loopStatus: 'paused',
            title: 'Renamed by Ever Gauzy',
            spentCents: 70,
            version: 4,
        });
        // The caller's object is whole again: the columns it did not write are back.
        expect(saved).toBe(stale);
        expect(stale.title).toBe('Ship the integration');
        expect(stale.loopStatus).toBe('paused');
    });

    it('the orchestrator pause does not write back a title changed while it ran', async () => {
        const { id } = await newGoal();
        // The orchestrator reads the Goal; a PATCH lands right after that read.
        const findOne = goals.findOne.bind(goals);
        const racing = Object.create(goals) as Repository<Goal>;
        racing.findOne = (async (options: Parameters<Repository<Goal>['findOne']>[0]) => {
            const copy = await findOne(options);
            await goals.update({ id }, { title: 'Renamed mid-call', version: 4 });
            return copy;
        }) as Repository<Goal>['findOne'];
        const orchestrator = new GoalOrchestratorService(
            racing,
            dataSource.getRepository(GoalEvent),
            dataSource.getRepository(Task),
            dataSource.getRepository(AgentRun),
        );

        const dto = await orchestrator.pauseLoop(OWNER, id);

        expect(dto.loopStatus).toBe('paused');
        expect(await goals.findOneByOrFail({ id })).toMatchObject({
            loopStatus: 'paused',
            title: 'Renamed mid-call',
            version: 4,
        });
    });
});
