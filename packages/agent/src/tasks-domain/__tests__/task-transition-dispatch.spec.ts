import { TaskTransitionService } from '../task-transition.service';
import { TaskStatus, TaskPriority } from '../../entities/task.entity';
import type { Task } from '../../entities/task.entity';

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 't1',
        userId: 'u1',
        slug: 'T-1',
        title: 'Write the migration',
        description: null,
        status: TaskStatus.TODO,
        previousStatus: null,
        priority: TaskPriority.P3,
        labels: null,
        missionId: null,
        ideaId: null,
        workId: null,
        parentTaskId: null,
        createdByType: 'user',
        createdById: 'u1',
        requireAllApprovers: true,
        startedAt: null,
        completedAt: null,
        isRecurring: false,
        recurrenceOccurredCount: 0,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Task;
}

describe('TaskTransitionService — Phase 15.3 agent dispatch hook', () => {
    let tasks: any;
    let blocks: any;
    let approvers: any;
    let assignees: any;
    let runs: any;
    let dispatcher: any;
    let agents: any;

    beforeEach(() => {
        tasks = {
            casUpdateStatus: jest.fn().mockResolvedValue(true),
            findById: jest.fn(),
        };
        blocks = { findByTaskId: jest.fn().mockResolvedValue([]) };
        approvers = { allApproved: jest.fn().mockResolvedValue(true) };
        assignees = { findAgentAssignees: jest.fn().mockResolvedValue([]) };
        runs = {
            createQueued: jest.fn().mockResolvedValue({ id: 'r1' }),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
        };
        dispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
        agents = {
            findByIdAndUser: jest.fn(async (id: string, userId: string, scope: unknown) => ({
                id,
                userId,
                ...(scope as object),
            })),
        };
    });

    function makeSvc() {
        return new (TaskTransitionService as any)(
            tasks,
            blocks,
            approvers,
            assignees,
            runs,
            dispatcher,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            agents,
        ) as TaskTransitionService;
    }

    it('fails closed before creating a run when Agent ownership validation is unavailable', async () => {
        const serviceWithoutAgents = new TaskTransitionService(
            tasks,
            blocks,
            approvers,
            assignees,
            runs,
            dispatcher,
        );

        await expect(
            serviceWithoutAgents.dispatchAgentRun(makeTask(), 'agent-a'),
        ).resolves.toMatchObject({
            runId: null,
            dispatched: false,
            error: 'agent-not-found',
        });
        expect(runs.createQueued).not.toHaveBeenCalled();
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('does NOT fan out when there are no Agent assignees', async () => {
        const svc = makeSvc();
        const task = makeTask({ status: TaskStatus.TODO });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
        assignees.findAgentAssignees.mockResolvedValueOnce([]);
        await svc.transition(task, TaskStatus.IN_PROGRESS);
        await new Promise((r) => setImmediate(r)); // flush microtasks
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('fans out to every Agent assignee on → in_progress', async () => {
        const svc = makeSvc();
        const task = makeTask({ status: TaskStatus.TODO });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
        assignees.findAgentAssignees.mockResolvedValueOnce([
            { assigneeType: 'agent', assigneeId: 'agent-a' },
            { assigneeType: 'agent', assigneeId: 'agent-b' },
        ]);
        await svc.transition(task, TaskStatus.IN_PROGRESS);
        await new Promise((r) => setImmediate(r));
        expect(dispatcher.enqueue).toHaveBeenCalledTimes(2);
        const firstCall = dispatcher.enqueue.mock.calls[0][0];
        expect(firstCall.taskId).toBe('t1');
        expect(firstCall.dedupKey).toMatch(/t1:agent-[ab]:1/);
        expect(firstCall.runId).toBe('r1');
    });

    it('drops known same-user Agent assignees outside the persisted Task Organization', async () => {
        const svc = makeSvc();
        const task = makeTask({
            status: TaskStatus.TODO,
            tenantId: '11111111-1111-4111-8111-111111111111',
            organizationId: '22222222-2222-4222-8222-222222222222',
        });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
        assignees.findAgentAssignees.mockResolvedValueOnce([
            { assigneeType: 'agent', assigneeId: 'agent-yo' },
        ]);
        agents.findByIdAndUser.mockResolvedValueOnce(null);

        await svc.transition(task, TaskStatus.IN_PROGRESS);
        await new Promise((r) => setImmediate(r));

        expect(agents.findByIdAndUser).toHaveBeenCalledWith('agent-yo', 'u1', {
            tenantId: task.tenantId,
            organizationId: task.organizationId,
        });
        expect(runs.createQueued).not.toHaveBeenCalled();
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('validates task.agentId in the persisted Task scope before fallback dispatch', async () => {
        const svc = makeSvc();
        const task = makeTask({
            status: TaskStatus.TODO,
            agentId: 'agent-yo',
            tenantId: '11111111-1111-4111-8111-111111111111',
            organizationId: '22222222-2222-4222-8222-222222222222',
        });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
        assignees.findAgentAssignees.mockResolvedValueOnce([]);
        agents.findByIdAndUser.mockResolvedValueOnce(null);

        await svc.transition(task, TaskStatus.IN_PROGRESS);
        await new Promise((r) => setImmediate(r));

        expect(runs.createQueued).not.toHaveBeenCalled();
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('dispatches a legacy Task to its same-owner current-tenant Agent', async () => {
        const svc = makeSvc();
        const task = makeTask({ tenantId: null, organizationId: null });
        agents.findByIdAndUser.mockImplementationOnce(
            async (id: string, userId: string, scope: unknown) =>
                scope === undefined
                    ? {
                          id,
                          userId,
                          tenantId: '11111111-1111-4111-8111-111111111111',
                          organizationId: '22222222-2222-4222-8222-222222222222',
                      }
                    : null,
        );

        await expect(svc.dispatchAgentRun(task, 'agent-ever')).resolves.toMatchObject({
            dispatched: true,
            runId: 'r1',
        });

        expect(agents.findByIdAndUser).toHaveBeenCalledWith('agent-ever', 'u1', undefined);
        expect(dispatcher.enqueue).toHaveBeenCalled();
    });

    it('pre-creates a queued AgentRun row before enqueuing the Trigger.dev run', async () => {
        const svc = makeSvc();
        const task = makeTask({ status: TaskStatus.TODO });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
        assignees.findAgentAssignees.mockResolvedValueOnce([
            { assigneeType: 'agent', assigneeId: 'agent-a' },
        ]);
        await svc.transition(task, TaskStatus.IN_PROGRESS);
        await new Promise((r) => setImmediate(r));
        expect(runs.createQueued).toHaveBeenCalledWith(
            expect.objectContaining({
                agentId: 'agent-a',
                userId: 'u1',
                triggerKind: 'task',
                taskId: 't1',
            }),
        );
        expect(dispatcher.enqueue).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1' }));
    });

    it('dedupKey bumps with recurrenceOccurredCount + 1 on recurring instances', async () => {
        const svc = makeSvc();
        const task = makeTask({ status: TaskStatus.TODO, recurrenceOccurredCount: 4 });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
        assignees.findAgentAssignees.mockResolvedValueOnce([
            { assigneeType: 'agent', assigneeId: 'agent-a' },
        ]);
        await svc.transition(task, TaskStatus.IN_PROGRESS);
        await new Promise((r) => setImmediate(r));
        expect(dispatcher.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ dedupKey: 't1:agent-a:5' }),
        );
    });

    it('does NOT fan out on transitions to other states (e.g. in_progress → done)', async () => {
        const svc = makeSvc();
        const task = makeTask({ status: TaskStatus.IN_PROGRESS, requireAllApprovers: false });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.DONE });
        assignees.findAgentAssignees.mockResolvedValueOnce([
            { assigneeType: 'agent', assigneeId: 'agent-a' },
        ]);
        await svc.transition(task, TaskStatus.DONE);
        await new Promise((r) => setImmediate(r));
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('stamps the Trigger.dev run id so a cancel before start can reach the remote run', async () => {
        const svc = makeSvc();
        const task = makeTask({ status: TaskStatus.TODO });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
        assignees.findAgentAssignees.mockResolvedValueOnce([
            { assigneeType: 'agent', assigneeId: 'agent-a' },
        ]);
        await svc.transition(task, TaskStatus.IN_PROGRESS);
        await new Promise((r) => setImmediate(r));
        expect(runs.setTriggerRunId).toHaveBeenCalledWith('r1', 'trd-1');
    });

    it('does not mark a dispatched run failed when stamping the Trigger.dev id throws', async () => {
        const svc = makeSvc();
        // Synchronous throw, not a rejected promise: a `.catch()` would never
        // attach, so the error would escape into the dispatch catch and report
        // a run that DID dispatch as dispatch-failed.
        runs.setTriggerRunId.mockImplementationOnce(() => {
            throw new Error('DB down');
        });
        const task = makeTask({ status: TaskStatus.TODO });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
        assignees.findAgentAssignees.mockResolvedValueOnce([
            { assigneeType: 'agent', assigneeId: 'agent-a' },
        ]);
        await svc.transition(task, TaskStatus.IN_PROGRESS);
        await new Promise((r) => setImmediate(r));
        expect(runs.markDispatchFailed).not.toHaveBeenCalled();
    });

    it('catches dispatcher failures, transitions AgentRun to failed, and does not fail transition', async () => {
        const svc = makeSvc();
        dispatcher.enqueue.mockRejectedValueOnce(new Error('Trigger.dev down'));
        const task = makeTask({ status: TaskStatus.TODO });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
        assignees.findAgentAssignees.mockResolvedValueOnce([
            { assigneeType: 'agent', assigneeId: 'agent-a' },
        ]);
        const result = await svc.transition(task, TaskStatus.IN_PROGRESS);
        expect(result.status).toBe(TaskStatus.IN_PROGRESS); // transition itself succeeded
        await new Promise((r) => setImmediate(r));
        // The `dispatch-failed:` prefix is the contract the Activity tab and any
        // future triage tooling reads — pin it, not just the underlying cause.
        expect(runs.markDispatchFailed).toHaveBeenCalledWith(
            'r1',
            expect.stringContaining('dispatch-failed: Trigger.dev down'),
        );
    });

    it('classifies an unconfigured job runtime under its own stable reason marker', async () => {
        const svc = makeSvc();
        const notConfigured = new Error(
            'Background job runtime is not configured on this install — agent runs cannot execute.',
        );
        notConfigured.name = 'JobRuntimeNotConfiguredError';
        dispatcher.enqueue.mockRejectedValueOnce(notConfigured);
        const task = makeTask({ status: TaskStatus.TODO });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
        assignees.findAgentAssignees.mockResolvedValueOnce([
            { assigneeType: 'agent', assigneeId: 'agent-a' },
        ]);

        await svc.transition(task, TaskStatus.IN_PROGRESS);
        await new Promise((r) => setImmediate(r));

        // Loud degradation: an install-level misconfiguration must be
        // distinguishable from a transient dispatch error — the run-detail
        // UI and the health banner key on this marker.
        expect(runs.markDispatchFailed).toHaveBeenCalledWith(
            'r1',
            expect.stringMatching(/^job-runtime-not-configured: /),
        );
    });

    it('skips reconciliation when the queued run was never created, and keeps fanning out', async () => {
        const svc = makeSvc();
        // createQueued fails for the FIRST assignee only — `run` stays null, so
        // the catch block has nothing to reconcile.
        runs.createQueued.mockRejectedValueOnce(new Error('DB down'));
        const task = makeTask({ status: TaskStatus.TODO });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
        assignees.findAgentAssignees.mockResolvedValueOnce([
            { assigneeType: 'agent', assigneeId: 'agent-a' },
            { assigneeType: 'agent', assigneeId: 'agent-b' },
        ]);
        const result = await svc.transition(task, TaskStatus.IN_PROGRESS);
        expect(result.status).toBe(TaskStatus.IN_PROGRESS); // transition itself succeeded
        await new Promise((r) => setImmediate(r));

        expect(runs.markDispatchFailed).not.toHaveBeenCalled();
        // The `if (run)` guard is load-bearing: without it the catch block
        // dereferences a null `run`, and because the fan-out `for` loop awaits
        // each iteration that TypeError escapes the loop and silently strands
        // every remaining assignee. agent-b must still be dispatched.
        expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
        expect(dispatcher.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ agentId: 'agent-b', runId: 'r1' }),
        );
    });

    describe('Wave 4 M2 — dispatch gate routing', () => {
        const makeGatedSvc = (gate: any) =>
            new TaskTransitionService(
                tasks,
                blocks,
                approvers,
                assignees,
                runs,
                dispatcher,
                undefined, // notifications
                undefined, // runDenorm
                gate,
                undefined, // works
                undefined, // terminalSessions
                agents,
            );

        const toInProgress = async (svc: TaskTransitionService, taskOver: Partial<Task> = {}) => {
            const task = makeTask({ status: TaskStatus.TODO, ...taskOver });
            tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
            assignees.findAgentAssignees.mockResolvedValueOnce([
                { assigneeType: 'agent', assigneeId: 'agent-a' },
            ]);
            await svc.transition(task, TaskStatus.IN_PROGRESS);
            await new Promise((r) => setImmediate(r));
        };

        it('consults the gate with the Task scope (userId + workId + organizationId)', async () => {
            const gate = { admit: jest.fn().mockResolvedValue({ admitted: true }) };
            await toInProgress(makeGatedSvc(gate), {
                workId: 'work-1',
                organizationId: 'org-1',
            } as Partial<Task>);
            // The second argument is the `reserve` half of the admission:
            // the gate runs the `createQueued` insert INSIDE its critical
            // section so the count and the row that consumes the counted
            // slot cannot be split by a parallel burst.
            expect(gate.admit).toHaveBeenCalledWith(
                {
                    userId: 'u1',
                    workId: 'work-1',
                    organizationId: 'org-1',
                },
                expect.any(Function),
            );
            expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
        });

        it('denormalizes task.workId onto the queued run at creation', async () => {
            const gate = { admit: jest.fn().mockResolvedValue({ admitted: true }) };
            await toInProgress(makeGatedSvc(gate), { workId: 'work-1' });
            expect(runs.createQueued).toHaveBeenCalledWith(
                expect.objectContaining({ workId: 'work-1', queuedReason: null }),
            );
        });

        it('over-limit: parks the run (queuedReason=concurrency-limit) and SKIPS the enqueue', async () => {
            const gate = {
                admit: jest
                    .fn()
                    .mockResolvedValue({ admitted: false, queuedReason: 'concurrency-limit' }),
            };
            await toInProgress(makeGatedSvc(gate), { workId: 'work-1' });
            expect(runs.createQueued).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: 'work-1',
                    queuedReason: 'concurrency-limit',
                }),
            );
            expect(dispatcher.enqueue).not.toHaveBeenCalled();
            // A parked run is not a failed run.
            expect(runs.markDispatchFailed).not.toHaveBeenCalled();
        });

        it('fails OPEN when the gate itself throws — a broken valve never stops dispatch', async () => {
            const gate = { admit: jest.fn().mockRejectedValue(new Error('count query died')) };
            await toInProgress(makeGatedSvc(gate), { workId: 'work-1' });
            expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
            expect(runs.createQueued).toHaveBeenCalledWith(
                expect.objectContaining({ queuedReason: null }),
            );
        });

        it('dispatches ungated when no gate is bound (fixtures + installs without the module)', async () => {
            await toInProgress(makeSvc(), { workId: 'work-1' });
            expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
        });
    });

    it('catches dispatcher failures gracefully when runs repository is missing', async () => {
        const svc = new TaskTransitionService(
            tasks,
            blocks,
            approvers,
            assignees,
            undefined,
            dispatcher,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            agents,
        );
        dispatcher.enqueue.mockRejectedValueOnce(new Error('Trigger.dev down'));
        const task = makeTask({ status: TaskStatus.TODO });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
        assignees.findAgentAssignees.mockResolvedValueOnce([
            { assigneeType: 'agent', assigneeId: 'agent-a' },
        ]);
        const result = await svc.transition(task, TaskStatus.IN_PROGRESS);
        expect(result.status).toBe(TaskStatus.IN_PROGRESS); // transition itself succeeded
        await new Promise((r) => setImmediate(r));
        // No runs repository ⇒ no row was ever persisted, so dispatch still had to
        // be attempted with an undefined runId, and reconciliation must be skipped
        // rather than throwing. Asserting the runId pins the `run?.id` behaviour
        // that hoisting `run` out of the try block could silently have broken.
        expect(dispatcher.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ runId: undefined }),
        );
        expect(runs.markDispatchFailed).not.toHaveBeenCalled();
    });

    /**
     * Streaming terminal — the automatic session dispatch. The persistent
     * gate itself lives in the launcher (see
     * `agents/__tests__/terminal-session-launcher.service.spec.ts`); what is
     * pinned here is that the fan-out ASKS with `requirePersistent: true`,
     * for the run it just dispatched, and that a terminal hiccup can never
     * contaminate the run's own dispatch bookkeeping.
     */
    describe('terminal session start on fan-out', () => {
        function makeTerminalSvc(terminalSessions: { startForRun: jest.Mock }) {
            return new TaskTransitionService(
                tasks,
                blocks,
                approvers,
                assignees,
                runs,
                dispatcher,
                undefined,
                undefined,
                undefined,
                undefined,
                terminalSessions as never,
                agents,
            );
        }

        async function fanOut(svc: TaskTransitionService) {
            const task = makeTask({ status: TaskStatus.TODO });
            tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
            assignees.findAgentAssignees.mockResolvedValueOnce([
                { assigneeType: 'agent', assigneeId: 'agent-a' },
            ]);
            await svc.transition(task, TaskStatus.IN_PROGRESS);
            await new Promise((r) => setImmediate(r));
        }

        it('asks the starter for the dispatched run, gated on persistent', async () => {
            const terminalSessions = {
                startForRun: jest.fn().mockResolvedValue({ started: false }),
            };
            await fanOut(makeTerminalSvc(terminalSessions));

            expect(terminalSessions.startForRun).toHaveBeenCalledTimes(1);
            expect(terminalSessions.startForRun).toHaveBeenCalledWith({
                userId: 'u1',
                agentId: 'agent-a',
                runId: 'r1',
                requirePersistent: true,
            });
        });

        it('never marks a live run dispatch-failed when starting its terminal throws', async () => {
            const terminalSessions = {
                startForRun: jest.fn().mockRejectedValue(new Error('terminal dispatch down')),
            };
            await fanOut(makeTerminalSvc(terminalSessions));

            expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
            expect(runs.markDispatchFailed).not.toHaveBeenCalled();
        });

        it('is a silent no-op when no starter is bound (installs without a job runtime)', async () => {
            await fanOut(makeSvc());
            expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
            expect(runs.markDispatchFailed).not.toHaveBeenCalled();
        });
    });
});

describe('TaskTransitionService — owner-column agent fallback (kanban/detail-page assign)', () => {
    let tasks: any;
    let blocks: any;
    let approvers: any;
    let assignees: any;
    let runs: any;
    let dispatcher: any;
    let agents: any;

    beforeEach(() => {
        tasks = { casUpdateStatus: jest.fn().mockResolvedValue(true), findById: jest.fn() };
        blocks = { findByTaskId: jest.fn().mockResolvedValue([]) };
        approvers = { allApproved: jest.fn().mockResolvedValue(true) };
        assignees = { findAgentAssignees: jest.fn().mockResolvedValue([]) };
        runs = {
            createQueued: jest.fn().mockResolvedValue({ id: 'r1' }),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
        };
        dispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
        agents = {
            findByIdAndUser: jest.fn(async (id: string, userId: string, scope: unknown) => ({
                id,
                userId,
                ...(scope as object),
            })),
        };
    });

    const makeSvc = () =>
        new (TaskTransitionService as any)(
            tasks,
            blocks,
            approvers,
            assignees,
            runs,
            dispatcher,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            agents,
        ) as TaskTransitionService;

    it('dispatches the Task OWN agent (task.agentId) when there are no assignee rows', async () => {
        // The Task detail page assigns an Agent by writing task.agentId — it
        // creates NO task_assignees row. Pre-fix, fanOutAgentExecutions
        // returned at `agentAssignees.length === 0`, so moving such a Task to
        // In Progress dispatched nothing, silently: the primary human flow.
        const svc = makeSvc();
        const task = makeTask({ status: TaskStatus.TODO, agentId: 'agent-9' } as Partial<Task>);
        tasks.findById.mockResolvedValueOnce({
            ...task,
            status: TaskStatus.IN_PROGRESS,
        });
        assignees.findAgentAssignees.mockResolvedValueOnce([]);

        await svc.transition(task, TaskStatus.IN_PROGRESS);
        await new Promise((r) => setImmediate(r));

        expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
        const call = dispatcher.enqueue.mock.calls[0][0];
        expect(call.taskId).toBe('t1');
        // The dedup key carries the agent id — proves WHICH agent dispatched.
        expect(call.dedupKey).toContain('agent-9');
    });

    it('assignee rows take precedence — the owner column does not double-dispatch', async () => {
        // When explicit assignee rows exist they are the fan-out set, exactly
        // as before this fix; task.agentId must not add a duplicate run.
        const svc = makeSvc();
        const task = makeTask({ status: TaskStatus.TODO, agentId: 'agent-9' } as Partial<Task>);
        tasks.findById.mockResolvedValueOnce({
            ...task,
            status: TaskStatus.IN_PROGRESS,
        });
        assignees.findAgentAssignees.mockResolvedValueOnce([
            { assigneeId: 'agent-a' },
            { assigneeId: 'agent-b' },
        ]);

        await svc.transition(task, TaskStatus.IN_PROGRESS);
        await new Promise((r) => setImmediate(r));

        expect(dispatcher.enqueue).toHaveBeenCalledTimes(2);
        const keys = dispatcher.enqueue.mock.calls.map((c: any[]) => c[0].dedupKey).join('|');
        expect(keys).toContain('agent-a');
        expect(keys).toContain('agent-b');
        expect(keys).not.toContain('agent-9');
    });
});
