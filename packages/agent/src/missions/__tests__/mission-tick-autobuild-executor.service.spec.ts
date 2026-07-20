import type { Repository } from 'typeorm';
import { MissionTickService } from '../mission-tick.service';
import { Mission, MissionStatus, MissionType } from '../../entities/mission.entity';
import {
    WorkProposal,
    WorkProposalSource,
    WorkProposalStatus,
} from '../../entities/work-proposal.entity';
import type { WorkProposalRepository } from '../../user-research/work-proposal.repository';
import type { WorkProposalService } from '../../user-research/work-proposal.service';
import type { WorkAgentService } from '../../work-agent/work-agent.service';
import type { IdeaBuildExecuteDispatcher } from '../../work-agent/idea-build-executor.dispatcher';

const ENABLED = 'EVER_WORKS_IDEA_BUILD_EXECUTOR_ENABLED';

function makeMissionRepo() {
    const rows: Mission[] = [];
    return {
        find: jest.fn(async (opts: { where?: Partial<Mission>; take?: number } = {}) => {
            const where = opts.where ?? {};
            return rows.filter((m) =>
                Object.entries(where).every(
                    ([k, v]) => (m as unknown as Record<string, unknown>)[k] === v,
                ),
            );
        }),
        findOne: jest.fn(async () => null),
        _seed: (m: Partial<Mission> & { id: string; userId: string }) => {
            const full = {
                id: m.id,
                userId: m.userId,
                title: 'T',
                description: 'D',
                type: MissionType.SCHEDULED,
                status: MissionStatus.ACTIVE,
                schedule: '* * * * *',
                autoBuildWorks: m.autoBuildWorks ?? true,
                outstandingIdeasCap: m.outstandingIdeasCap ?? null,
                guardrailsOverride: null,
                missionTemplateRepo: null,
                missionRepo: null,
                sourceMissionId: null,
                createdAt: new Date('2026-07-19'),
                updatedAt: new Date('2026-07-19'),
            } as Mission;
            rows.push(full);
            return full;
        },
    };
}

function makeProposal(id: string, missionId: string, userId: string): WorkProposal {
    return {
        id,
        userId,
        missionId,
        title: `Idea ${id}`,
        description: 'a description',
        generatedPrompt: 'a generated prompt',
        slugSuggestion: id,
        status: WorkProposalStatus.PENDING,
        source: WorkProposalSource.MISSION,
    } as WorkProposal;
}

function makeWorkProposalService(proposals: WorkProposal[]) {
    return {
        generate: jest.fn(async () => ({ status: 'generated' as const, proposals, tokensUsed: 0 })),
        queueForBuild: jest.fn(async (_userId: string, id: string) => {
            return {
                id,
                status: WorkProposalStatus.QUEUED,
                description: 'a description',
            } as WorkProposal;
        }),
    } as unknown as WorkProposalService & { generate: jest.Mock; queueForBuild: jest.Mock };
}

function makeWorkProposalRepo() {
    return {
        countOutstandingByMission: jest.fn(async () => 0),
    } as unknown as WorkProposalRepository & { countOutstandingByMission: jest.Mock };
}

function makeWorkAgent() {
    return {
        getPreferences: jest.fn(async () => ({ missionDefaultOutstandingCap: null })),
        createGoal: jest.fn(async (_userId: string, input: { ideaId?: string }) => ({
            goal: { id: `goal-for-${input.ideaId}` },
            run: { id: 'run-x' },
        })),
    } as unknown as WorkAgentService & { getPreferences: jest.Mock; createGoal: jest.Mock };
}

function makeDispatcher() {
    return {
        enqueue: jest.fn(async () => ({ handleId: 'handle-1' })),
    } as unknown as IdeaBuildExecuteDispatcher & { enqueue: jest.Mock };
}

describe('MissionTickService — auto-build executor wiring (PR-4 / P3)', () => {
    const OLD_ENV = { ...process.env };
    afterEach(() => {
        process.env = { ...OLD_ENV };
        jest.clearAllMocks();
    });

    function build() {
        const missionRepo = makeMissionRepo();
        const proposals = makeWorkProposalService([makeProposal('p1', 'm1', 'u1')]);
        const proposalRepo = makeWorkProposalRepo();
        const workAgent = makeWorkAgent();
        const dispatcher = makeDispatcher();
        const service = new MissionTickService(
            missionRepo as unknown as Repository<Mission>,
            proposals,
            proposalRepo,
            workAgent,
            undefined, // activityLog (PR-3) — unwired in this executor test
            dispatcher,
        );
        return { service, missionRepo, proposals, workAgent, dispatcher };
    }

    it('flag OFF: auto-build only queues the Idea — no goal created, nothing enqueued (today’s behavior)', async () => {
        delete process.env[ENABLED];
        const { service, missionRepo, proposals, workAgent, dispatcher } = build();
        missionRepo._seed({ id: 'm1', userId: 'u1', autoBuildWorks: true });

        const summary = await service.tickDue(new Date('2026-07-19T00:00:00Z'));

        expect(summary.entries[0].outcome).toBe('spawned');
        expect(summary.entries[0].ideasQueued).toBe(1);
        expect(proposals.queueForBuild).toHaveBeenCalledTimes(1);
        expect(workAgent.createGoal).not.toHaveBeenCalled();
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('flag ON: auto-build queues the Idea AND creates a WorkAgentGoal AND enqueues it', async () => {
        process.env[ENABLED] = 'true';
        const { service, missionRepo, proposals, workAgent, dispatcher } = build();
        missionRepo._seed({ id: 'm1', userId: 'u1', autoBuildWorks: true });

        const summary = await service.tickDue(new Date('2026-07-19T00:00:00Z'));

        expect(summary.entries[0].outcome).toBe('spawned');
        expect(summary.entries[0].ideasQueued).toBe(1);
        expect(proposals.queueForBuild).toHaveBeenCalledTimes(1);
        expect(workAgent.createGoal).toHaveBeenCalledTimes(1);
        const createGoalArgs = workAgent.createGoal.mock.calls[0];
        expect(createGoalArgs[0]).toBe('u1');
        expect(createGoalArgs[1]).toMatchObject({ maxWorksPerRun: 1, ideaId: 'p1' });
        expect(dispatcher.enqueue).toHaveBeenCalledWith({
            goalId: 'goal-for-p1',
            userId: 'u1',
            ideaId: 'p1',
        });
    });

    it('flag ON but createGoal throws: tick still spawns (best-effort, Idea stays queued)', async () => {
        process.env[ENABLED] = 'true';
        const { service, missionRepo, workAgent, dispatcher } = build();
        (workAgent.createGoal as jest.Mock).mockRejectedValueOnce(
            new Error('Work agent is disabled.'),
        );
        missionRepo._seed({ id: 'm1', userId: 'u1', autoBuildWorks: true });

        const summary = await service.tickDue(new Date('2026-07-19T00:00:00Z'));

        expect(summary.entries[0].outcome).toBe('spawned');
        expect(summary.entries[0].ideasQueued).toBe(1);
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });
});
