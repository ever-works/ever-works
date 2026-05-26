import {
    AgentScheduleDispatcherService,
    type AgentHeartbeatTrigger,
} from '../agent-schedule-dispatcher.service';
import {
    AgentScope,
    AgentStatus,
    AgentAvatarMode,
    AgentIdleBehavior,
} from '../../entities/agent.entity';
import type { Agent } from '../../entities/agent.entity';

function makeAgent(over: Partial<Agent> = {}): Agent {
    return {
        id: 'a1',
        userId: 'u1',
        scope: AgentScope.TENANT,
        missionId: null,
        ideaId: null,
        workId: null,
        name: 'CEO',
        slug: 'ceo',
        title: null,
        capabilities: null,
        aiProviderId: null,
        modelId: null,
        maxSkillContextTokens: 4000,
        status: AgentStatus.ACTIVE,
        permissions: {
            canCreateAgents: false,
            canAssignTasks: false,
            canEditSkills: false,
            canEditAgentFiles: false,
            canSpend: false,
            canCommitToRepo: false,
            canOpenPullRequests: false,
            canCallExternalTools: false,
        },
        targets: null,
        heartbeatCadence: '*/5 * * * *',
        idleBehavior: AgentIdleBehavior.PROPOSE,
        nextHeartbeatAt: new Date('2026-05-26T12:00:00Z'),
        lastRunAt: null,
        lastRunStatus: null,
        errorCount: 0,
        pauseAfterFailures: 3,
        avatarMode: AgentAvatarMode.INITIALS,
        avatarIcon: null,
        avatarImageUploadId: null,
        soulMd: null,
        agentsMd: null,
        heartbeatMd: null,
        toolsMd: null,
        agentYml: null,
        contentHash: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Agent;
}

describe('AgentScheduleDispatcherService', () => {
    let agentRepo: any;
    let runRepo: any;
    let svc: AgentScheduleDispatcherService;
    let trigger: jest.Mocked<AgentHeartbeatTrigger>;

    beforeEach(() => {
        agentRepo = {
            findDueForHeartbeat: jest.fn().mockResolvedValue([]),
            tryClaimForRun: jest.fn(),
            findStuckRunning: jest.fn().mockResolvedValue([]),
            updateById: jest.fn().mockResolvedValue(undefined),
            // Review-fix C11: dispatcher releases the CAS claim on
            // enqueue failure so the Agent doesn't stay stuck in RUNNING
            // until the 30-min recovery sweep.
            releaseAfterRun: jest.fn().mockResolvedValue(undefined),
        };
        runRepo = {
            createQueued: jest.fn().mockResolvedValue({ id: 'run-1' }),
        };
        trigger = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
        svc = new AgentScheduleDispatcherService(agentRepo, runRepo);
    });

    it('returns an empty summary when no Agents are due', async () => {
        const summary = await svc.dispatchDue(trigger);
        expect(summary.dueCount).toBe(0);
        expect(summary.dispatched).toBe(0);
        expect(trigger.enqueue).not.toHaveBeenCalled();
    });

    it('dispatches one due Agent — happy path', async () => {
        const agent = makeAgent();
        agentRepo.findDueForHeartbeat.mockResolvedValueOnce([agent]);
        agentRepo.tryClaimForRun.mockResolvedValueOnce(agent.nextHeartbeatAt);

        const summary = await svc.dispatchDue(trigger);

        expect(summary.dueCount).toBe(1);
        expect(summary.dispatched).toBe(1);
        expect(summary.skipped).toBe(0);
        expect(summary.failed).toBe(0);
        expect(runRepo.createQueued).toHaveBeenCalledWith(
            expect.objectContaining({ agentId: 'a1', userId: 'u1', triggerKind: 'heartbeat' }),
        );
        expect(trigger.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ agentId: 'a1', userId: 'u1' }),
        );
    });

    it('race-safety: when two workers see the same due row, only the one that wins tryClaimForRun dispatches', async () => {
        const agent = makeAgent();
        agentRepo.findDueForHeartbeat.mockResolvedValueOnce([agent]);
        // Simulate a second worker beat us — CAS returns null.
        agentRepo.tryClaimForRun.mockResolvedValueOnce(null);

        const summary = await svc.dispatchDue(trigger);

        expect(summary.dispatched).toBe(0);
        expect(summary.skipped).toBe(1);
        expect(trigger.enqueue).not.toHaveBeenCalled();
        expect(runRepo.createQueued).not.toHaveBeenCalled();
    });

    it('handles dispatch failure: increments failed count + logs, does NOT throw', async () => {
        const agent = makeAgent();
        agentRepo.findDueForHeartbeat.mockResolvedValueOnce([agent]);
        agentRepo.tryClaimForRun.mockResolvedValueOnce(agent.nextHeartbeatAt);
        trigger.enqueue.mockRejectedValueOnce(new Error('Trigger.dev down'));

        const summary = await svc.dispatchDue(trigger);

        expect(summary.failed).toBe(1);
        expect(summary.entries[0].outcome).toBe('failed');
        expect(summary.entries[0].message).toMatch(/Trigger\.dev down/);
    });

    it('Review-fix C11: releases the CAS claim when enqueue fails after a successful claim', async () => {
        const agent = makeAgent();
        const originalNext = agent.nextHeartbeatAt;
        agentRepo.findDueForHeartbeat.mockResolvedValueOnce([agent]);
        agentRepo.tryClaimForRun.mockResolvedValueOnce(originalNext);
        trigger.enqueue.mockRejectedValueOnce(new Error('queue full'));

        await svc.dispatchDue(trigger);

        expect(agentRepo.releaseAfterRun).toHaveBeenCalledWith(
            agent.id,
            originalNext,
            'dispatch-failed',
        );
    });

    it('Review-fix C11: does NOT call releaseAfterRun when tryClaimForRun returned null (we never claimed)', async () => {
        const agent = makeAgent();
        agentRepo.findDueForHeartbeat.mockResolvedValueOnce([agent]);
        agentRepo.tryClaimForRun.mockResolvedValueOnce(null);

        await svc.dispatchDue(trigger);

        expect(agentRepo.releaseAfterRun).not.toHaveBeenCalled();
    });

    it('recovers stuck-running Agents by resetting status + computing fresh nextHeartbeatAt', async () => {
        const stuck = makeAgent({
            id: 'a2',
            status: AgentStatus.RUNNING,
            lastRunAt: new Date(Date.now() - 2 * 60 * 60_000),
            heartbeatCadence: '*/5 * * * *',
        });
        agentRepo.findStuckRunning.mockResolvedValueOnce([stuck]);

        const summary = await svc.dispatchDue(trigger);

        expect(summary.recoveredStuck).toBe(1);
        expect(agentRepo.updateById).toHaveBeenCalledWith(
            'a2',
            expect.objectContaining({
                status: AgentStatus.ACTIVE,
                lastRunStatus: 'recovered-stuck',
            }),
        );
    });

    it('honors the dispatcher-enabled feature flag (env override)', async () => {
        const oldEnv = process.env.AGENTS_DISPATCHER_ENABLED;
        process.env.AGENTS_DISPATCHER_ENABLED = 'false';
        try {
            const agent = makeAgent();
            agentRepo.findDueForHeartbeat.mockResolvedValueOnce([agent]);
            const summary = await svc.dispatchDue(trigger);
            expect(summary.dispatched).toBe(0);
            expect(agentRepo.findDueForHeartbeat).not.toHaveBeenCalled();
        } finally {
            if (oldEnv === undefined) {
                delete process.env.AGENTS_DISPATCHER_ENABLED;
            } else {
                process.env.AGENTS_DISPATCHER_ENABLED = oldEnv;
            }
        }
    });
});
