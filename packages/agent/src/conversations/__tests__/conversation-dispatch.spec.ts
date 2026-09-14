import { ConversationDispatchService } from '../conversation-dispatch.service';
import { MAX_DISPATCH_PER_MESSAGE } from '../conversation.types';

const DIRECT = {
    id: 'c1',
    userId: 'u1',
    kind: 'direct',
    agentId: 'a1',
    tenantId: 't1',
    organizationId: 'o1',
} as any;
const MESSAGE = { id: 'm1', conversationId: 'c1', content: 'hi' } as any;

function request(overrides: Record<string, unknown> = {}) {
    return {
        conversation: DIRECT,
        message: MESSAGE,
        userId: 'u1',
        agentVisibleBody: 'hi',
        mentionedAgentIds: [] as string[],
        ...overrides,
    };
}

describe('ConversationDispatchService — the reply contract', () => {
    let agents: { findByIdAndUser: jest.Mock };
    let runs: Record<string, jest.Mock>;
    let dispatcher: { enqueue: jest.Mock };
    let steering: { steer: jest.Mock };
    let gate: { admit: jest.Mock };
    let service: ConversationDispatchService;
    let runCounter: number;

    beforeEach(() => {
        runCounter = 0;
        agents = {
            findByIdAndUser: jest.fn(async (id: string) => ({ id, status: 'active' })),
        };
        runs = {
            createQueued: jest.fn(async () => ({ id: `run-${++runCounter}` })),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
            findInFlightForConversationAgent: jest.fn().mockResolvedValue(null),
        };
        dispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'job-1' }) };
        steering = { steer: jest.fn() };
        gate = { admit: jest.fn().mockResolvedValue({ admitted: true }) };
        service = new ConversationDispatchService(
            agents as any,
            runs as any,
            dispatcher,
            steering as any,
            gate as any,
        );
    });

    it('a direct Conversation dispatches its addressed Agent through the reply port', async () => {
        const reach = await service.dispatch(request());

        expect(reach).toEqual([{ agentId: 'a1', outcome: 'delivered', runId: 'run-1' }]);
        expect(gate.admit).toHaveBeenCalledWith({
            userId: 'u1',
            workId: null,
            organizationId: 'o1',
        });
        expect(runs.createQueued).toHaveBeenCalledWith({
            agentId: 'a1',
            userId: 'u1',
            triggerKind: 'conversation',
            conversationMessageId: 'm1',
            workId: null,
            tenantId: 't1',
            organizationId: 'o1',
        });
        expect(dispatcher.enqueue).toHaveBeenCalledWith({
            agentId: 'a1',
            userId: 'u1',
            conversationId: 'c1',
            triggeringMessageId: 'm1',
            dedupKey: 'conversation:m1:a1:run-1',
            runId: 'run-1',
            tenantId: 't1',
            organizationId: 'o1',
        });
        expect(runs.setTriggerRunId).toHaveBeenCalledWith('run-1', 'job-1');
    });

    it('a direct Conversation ignores other mentions — only the addressed Agent replies', async () => {
        const reach = await service.dispatch(request({ mentionedAgentIds: ['a2', 'a3'] }));
        expect(reach.map((entry) => entry.agentId)).toEqual(['a1']);
    });

    it('the assistant thread (no Agent) dispatches nothing', async () => {
        const reach = await service.dispatch(
            request({ conversation: { ...DIRECT, agentId: null } }),
        );
        expect(reach).toEqual([]);
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('in a multi-Agent kind a mention dispatches exactly the mentioned Agents, once each', async () => {
        const group = { ...DIRECT, kind: 'group', agentId: null };
        const reach = await service.dispatch(
            request({ conversation: group, mentionedAgentIds: ['a2', 'a3', 'a2'] }),
        );
        expect(reach.map((entry) => [entry.agentId, entry.outcome])).toEqual([
            ['a2', 'delivered'],
            ['a3', 'delivered'],
        ]);
        expect(dispatcher.enqueue).toHaveBeenCalledTimes(2);
    });

    it('starts at most eight replies from one message and records the rest as queued', async () => {
        const group = { ...DIRECT, kind: 'group', agentId: null };
        const ids = Array.from({ length: MAX_DISPATCH_PER_MESSAGE + 2 }, (_, i) => `a${i}`);
        const reach = await service.dispatch(
            request({ conversation: group, mentionedAgentIds: ids }),
        );

        expect(dispatcher.enqueue).toHaveBeenCalledTimes(MAX_DISPATCH_PER_MESSAGE);
        expect(reach.slice(MAX_DISPATCH_PER_MESSAGE)).toEqual([
            { agentId: 'a8', outcome: 'queued', reason: 'dispatch-ceiling' },
            { agentId: 'a9', outcome: 'queued', reason: 'dispatch-ceiling' },
        ]);
    });

    it('delivers into a live run already answering this Conversation instead of starting another', async () => {
        runs.findInFlightForConversationAgent.mockResolvedValue({ id: 'live-run' });
        steering.steer.mockResolvedValue({ dispatched: 'injected', runId: 'live-run' });

        const reach = await service.dispatch(request({ agentVisibleBody: 'also check the logs' }));

        expect(reach).toEqual([
            { agentId: 'a1', outcome: 'delivered', reason: 'steered', runId: 'live-run' },
        ]);
        expect(runs.findInFlightForConversationAgent).toHaveBeenCalledWith('c1', 'a1', 'u1', {
            tenantId: 't1',
            organizationId: 'o1',
        });
        expect(steering.steer).toHaveBeenCalledWith({
            runId: 'live-run',
            userId: 'u1',
            message: 'also check the logs',
        });
        expect(runs.createQueued).not.toHaveBeenCalled();
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('falls through to a new run when steering finds the run already finished or fails', async () => {
        runs.findInFlightForConversationAgent.mockResolvedValue({ id: 'live-run' });
        steering.steer.mockResolvedValueOnce({ dispatched: 'new-run', runId: 'live-run' });
        await expect(service.dispatch(request())).resolves.toEqual([
            { agentId: 'a1', outcome: 'delivered', runId: 'run-1' },
        ]);

        steering.steer.mockRejectedValueOnce(new Error('steer down'));
        await expect(service.dispatch(request())).resolves.toEqual([
            { agentId: 'a1', outcome: 'delivered', runId: 'run-2' },
        ]);
    });

    it('records queued with the gate’s reason, and creates no run nothing could drain', async () => {
        gate.admit.mockResolvedValue({ admitted: false, queuedReason: 'concurrency-limit' });

        const reach = await service.dispatch(request());

        expect(reach).toEqual([{ agentId: 'a1', outcome: 'queued', reason: 'concurrency-limit' }]);
        expect(runs.createQueued).not.toHaveBeenCalled();
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('fails open when the dispatch gate itself breaks', async () => {
        gate.admit.mockRejectedValue(new Error('count query failed'));
        await expect(service.dispatch(request())).resolves.toEqual([
            { agentId: 'a1', outcome: 'delivered', runId: 'run-1' },
        ]);
    });

    it('skips an Agent that is paused, draft, errored or archived, naming the status', async () => {
        for (const status of ['paused', 'draft', 'error', 'archived']) {
            agents.findByIdAndUser.mockResolvedValueOnce({ id: 'a1', status });
            await expect(service.dispatch(request())).resolves.toEqual([
                { agentId: 'a1', outcome: 'skipped', reason: status },
            ]);
        }
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('skips an Agent that is gone or not visible to the sender', async () => {
        agents.findByIdAndUser.mockResolvedValue(null);
        await expect(service.dispatch(request())).resolves.toEqual([
            { agentId: 'a1', outcome: 'skipped', reason: 'agent-unavailable' },
        ]);
    });

    it('refuses with a named reason when no job runtime is bound', async () => {
        const unbound = new ConversationDispatchService(agents as any, runs as any);
        await expect(unbound.dispatch(request())).resolves.toEqual([
            { agentId: 'a1', outcome: 'refused', reason: 'job-runtime-not-configured' },
        ]);
    });

    it('refuses and rolls the run to failed when the runtime reports it is not configured', async () => {
        const notConfigured = Object.assign(new Error('not configured'), {
            name: 'JobRuntimeNotConfiguredError',
        });
        dispatcher.enqueue.mockRejectedValue(notConfigured);

        const reach = await service.dispatch(request());

        expect(reach).toEqual([
            {
                agentId: 'a1',
                outcome: 'refused',
                reason: 'job-runtime-not-configured',
                runId: 'run-1',
            },
        ]);
        expect(runs.markDispatchFailed).toHaveBeenCalledWith(
            'run-1',
            'job-runtime-not-configured: not configured',
        );
    });

    it('refuses with dispatch-failed when the enqueue throws for any other reason', async () => {
        dispatcher.enqueue.mockRejectedValue(new Error('network'));
        await expect(service.dispatch(request())).resolves.toEqual([
            { agentId: 'a1', outcome: 'refused', reason: 'dispatch-failed', runId: 'run-1' },
        ]);
    });

    it('a failed triggerRunId stamp does not turn a delivered reply into a failure', async () => {
        runs.setTriggerRunId.mockRejectedValue(new Error('stamp failed'));
        await expect(service.dispatch(request())).resolves.toEqual([
            { agentId: 'a1', outcome: 'delivered', runId: 'run-1' },
        ]);
        expect(runs.markDispatchFailed).not.toHaveBeenCalled();
    });
});
