import { TaskChatService } from '../task-chat.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Run orchestration — an `@agent` mention is a DISPATCH, and it now goes
 * through the same concurrency choke point as the task fan-out, the
 * board run and resume.
 *
 * Before this, a chat storm on a saturated Work put unbounded runs on the
 * job runtime while the board path politely parked its own: the valve
 * held on one path and was invisible on the other. Over-limit now parks
 * the row (`queuedReason`, no enqueue) with `chatMessageId` intact, which
 * is what lets `RunDispatchGateService.drainForWork` put it back on the
 * CHAT path rather than the task path.
 */
describe('TaskChatService — agent-mention dispatch is gated', () => {
    let tasks: any;
    let messages: any;
    let kbMentions: any;
    let activity: any;
    let runs: any;
    let chatDispatcher: any;

    beforeEach(() => {
        tasks = { findByIdAndUser: jest.fn() };
        messages = {
            findByTaskId: jest.fn().mockResolvedValue([]),
            findById: jest.fn(),
            create: jest.fn(),
            updateBody: jest.fn().mockResolvedValue(undefined),
            updateBodyAndMentions: jest.fn().mockResolvedValue(undefined),
        };
        kbMentions = { add: jest.fn().mockResolvedValue({}) };
        activity = { log: jest.fn().mockResolvedValue(undefined) };
        runs = {
            createQueued: jest.fn().mockResolvedValue({ id: 'run-chat-1' }),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
        };
        chatDispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
    });

    const makeSvc = (dispatchGate?: any) =>
        new TaskChatService(
            tasks,
            messages,
            kbMentions,
            activity,
            runs as any,
            chatDispatcher,
            undefined,
            dispatchGate,
        );

    /** The fan-out is fire-and-forget; let the IIFE settle. */
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    const postMention = async (svc: TaskChatService, task: Record<string, unknown> = {}) => {
        tasks.findByIdAndUser.mockResolvedValueOnce({ id: 't1', workId: 'w1', ...task });
        messages.create.mockImplementationOnce((d: any) => Promise.resolve({ id: 'm1', ...d }));
        await svc.post(
            'u1',
            { taskId: 't1', authorType: 'user', authorId: 'u1', body: 'hey @ceo, look' },
            { ownedAgentSlugs: new Map([['ceo', 'agent-a1']]) },
        );
        await settle();
    };

    it('consults the gate with the Task scope before enqueuing', async () => {
        const gate = { admit: jest.fn().mockResolvedValue({ admitted: true }) };
        await postMention(makeSvc(gate), { workId: 'w1', organizationId: 'o1' });
        expect(gate.admit).toHaveBeenCalledWith(
            { userId: 'u1', workId: 'w1', organizationId: 'o1' },
            expect.any(Function),
        );
    });

    it('dispatches normally when admitted', async () => {
        const gate = {
            admit: jest.fn(async (_i: unknown, reserve: any) => {
                await reserve({ admitted: true });
                return { admitted: true };
            }),
        };
        await postMention(makeSvc(gate));
        expect(runs.createQueued).toHaveBeenCalledWith(
            expect.objectContaining({ triggerKind: 'chat', queuedReason: null }),
        );
        expect(chatDispatcher.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ runId: 'run-chat-1', triggeringMessageId: 'm1' }),
        );
    });

    it('PARKS the run and SKIPS the enqueue when over the valve', async () => {
        const gate = {
            admit: jest.fn(async (_i: unknown, reserve: any) => {
                await reserve({ admitted: false, queuedReason: 'concurrency-limit' });
                return { admitted: false, queuedReason: 'concurrency-limit' };
            }),
        };
        await postMention(makeSvc(gate));
        expect(runs.createQueued).toHaveBeenCalledWith(
            expect.objectContaining({
                triggerKind: 'chat',
                queuedReason: 'concurrency-limit',
                // Kept so the drain can put it back on the CHAT path.
                chatMessageId: 'm1',
                workId: 'w1',
            }),
        );
        expect(chatDispatcher.enqueue).not.toHaveBeenCalled();
        // Parked, NOT failed — it is waiting for capacity.
        expect(runs.markDispatchFailed).not.toHaveBeenCalled();
    });

    it('FAILS OPEN — a gate that throws never swallows a user mention', async () => {
        const gate = { admit: jest.fn().mockRejectedValue(new Error('gate exploded')) };
        await postMention(makeSvc(gate));
        expect(runs.createQueued).toHaveBeenCalledTimes(1);
        expect(chatDispatcher.enqueue).toHaveBeenCalledTimes(1);
    });

    it('creates the run itself when a gate stub ignores the reserve callback', async () => {
        const gate = { admit: jest.fn().mockResolvedValue({ admitted: true }) };
        await postMention(makeSvc(gate));
        expect(runs.createQueued).toHaveBeenCalledTimes(1);
        expect(chatDispatcher.enqueue).toHaveBeenCalledTimes(1);
    });

    it('behaves exactly as before when no gate is bound at all', async () => {
        await postMention(makeSvc(undefined));
        expect(runs.createQueued).toHaveBeenCalledTimes(1);
        expect(chatDispatcher.enqueue).toHaveBeenCalledTimes(1);
    });

    it('still rolls the run to dispatch-failed when the enqueue throws', async () => {
        chatDispatcher.enqueue.mockRejectedValueOnce(new Error('Trigger.dev down'));
        const gate = {
            admit: jest.fn(async (_i: unknown, reserve: any) => {
                await reserve({ admitted: true });
                return { admitted: true };
            }),
        };
        await postMention(makeSvc(gate));
        expect(runs.markDispatchFailed).toHaveBeenCalledWith(
            'run-chat-1',
            expect.stringContaining('dispatch-failed: Trigger.dev down'),
        );
    });
});
