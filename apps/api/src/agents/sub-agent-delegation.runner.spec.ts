import { Test, TestingModule } from '@nestjs/testing';
import { DELEGATION_CLOCK, SubAgentDelegationRunnerService } from './sub-agent-delegation.runner';
import {
    AgentCollaboratorRepository,
    AgentRepository,
    AgentRunRepository,
} from '@ever-works/agent/database';
import { TasksService, TaskTransitionService } from '@ever-works/agent/tasks-domain';

const PARENT_AGENT = 'agent-parent';
const CHILD_AGENT = 'agent-child';
const OWNER = 'user-1';
const EVER_SCOPE = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
};
const YO_SCOPE = {
    tenantId: EVER_SCOPE.tenantId,
    organizationId: '33333333-3333-4333-8333-333333333333',
};

/**
 * The real sub-agent delegation runner.
 *
 * Before this existed, `SUB_AGENT_DELEGATION_RUNNER` was never bound and
 * every delegation came back refused with `no-runner`. So the behaviours
 * pinned here are the ones that make it genuinely work — and the ones
 * that keep it safe:
 *
 *  - a delegation reaches the SAME dispatch path a human-assigned Task
 *    takes, so it inherits the concurrency gate, run rows and telemetry;
 *  - a cross-owner child is refused, because narrowing never loads the
 *    agents and so cannot catch it;
 *  - a child that never finishes is reported `failed`, not `completed`
 *    with an empty output.
 */
describe('SubAgentDelegationRunnerService', () => {
    let runner: SubAgentDelegationRunnerService;
    let agents: { findById: jest.Mock; findByIdAndUser: jest.Mock };
    let runs: { findById: jest.Mock };
    let tasks: { create: jest.Mock; getOne: jest.Mock };
    let transitions: { dispatchAgentRun: jest.Mock };
    let collaborators: { listForAgent: jest.Mock };

    const request = (over: Record<string, unknown> = {}) =>
        ({
            delegationId: 'del-1',
            parentAgentId: PARENT_AGENT,
            depth: 0,
            objective: 'Summarise the release notes',
            scope: { allowedTools: [], workId: 'work-1', organizationId: 'org-1' },
            ...over,
        }) as never;

    beforeEach(async () => {
        agents = {
            findById: jest.fn(async (id: string) => ({ id, userId: OWNER, ...EVER_SCOPE })),
            findByIdAndUser: jest.fn(async (id: string) => ({ id, userId: OWNER, ...EVER_SCOPE })),
        };
        runs = { findById: jest.fn().mockResolvedValue({ status: 'completed', summary: 'done' }) };
        tasks = {
            create: jest.fn().mockResolvedValue({ id: 'task-child', userId: OWNER, ...EVER_SCOPE }),
            getOne: jest
                .fn()
                .mockResolvedValue({ id: 'task-parent', userId: OWNER, ...EVER_SCOPE }),
        };
        transitions = {
            dispatchAgentRun: jest
                .fn()
                .mockResolvedValue({ runId: 'run-child', dispatched: true, parked: false }),
        };
        // Agent Collaborators — the default fixture ENABLES the child so
        // the pre-existing "any same-owner child" scenarios keep running
        // unchanged; the refusal tests below override this per-case.
        collaborators = {
            listForAgent: jest
                .fn()
                .mockResolvedValue([{ collaboratorAgentId: CHILD_AGENT, enabled: true }]),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SubAgentDelegationRunnerService,
                { provide: AgentRepository, useValue: agents },
                { provide: AgentRunRepository, useValue: runs },
                { provide: TasksService, useValue: tasks },
                { provide: TaskTransitionService, useValue: transitions },
                { provide: AgentCollaboratorRepository, useValue: collaborators },
                // Deterministic clock so the poll loop never really sleeps.
                // Must use the real token: a bare string that does not match
                // the @Inject leaves `clock` undefined and the test silently
                // sleeps for real (this one took 2s before the token existed).
                { provide: DELEGATION_CLOCK, useValue: { sleep: async () => undefined } },
            ],
        }).compile();

        runner = module.get(SubAgentDelegationRunnerService);
    });

    it('creates a child Task and dispatches it through the production path', async () => {
        const result = await runner.run(request({ childAgentId: CHILD_AGENT }));

        // The child Task is what makes the run observable, gated and
        // cancellable like any other — not a side channel.
        expect(tasks.create).toHaveBeenCalledWith(
            OWNER,
            expect.objectContaining({ createdByType: 'agent', agentId: CHILD_AGENT }),
            EVER_SCOPE,
        );
        expect(transitions.dispatchAgentRun).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'task-child' }),
            CHILD_AGENT,
            expect.objectContaining({ dedupKey: 'delegation:del-1' }),
        );
        expect(result.status).toBe('completed');
        expect(result.childRunId).toBe('run-child');
    });

    it('propagates the persisted parent Agent scope into the child Task and dispatched run', async () => {
        await runner.run(request({ childAgentId: CHILD_AGENT, parentTaskId: 'task-parent' }));

        expect(agents.findByIdAndUser).toHaveBeenCalledWith(CHILD_AGENT, OWNER, EVER_SCOPE);
        expect(tasks.getOne).toHaveBeenCalledWith(OWNER, 'task-parent', EVER_SCOPE);
        expect(tasks.create).toHaveBeenCalledWith(
            OWNER,
            expect.objectContaining({ parentTaskId: 'task-parent', agentId: CHILD_AGENT }),
            EVER_SCOPE,
        );
        expect(transitions.dispatchAgentRun).toHaveBeenCalledWith(
            expect.objectContaining(EVER_SCOPE),
            CHILD_AGENT,
            expect.any(Object),
        );
    });

    it('refuses a same-user child Agent from another Organization before creating work', async () => {
        agents.findById.mockImplementation(async (id: string) => ({
            id,
            userId: OWNER,
            ...(id === CHILD_AGENT ? YO_SCOPE : EVER_SCOPE),
        }));
        agents.findByIdAndUser.mockResolvedValue(null);

        const result = await runner.run(request({ childAgentId: CHILD_AGENT }));

        expect(result.status).toBe('failed');
        expect(tasks.create).not.toHaveBeenCalled();
        expect(transitions.dispatchAgentRun).not.toHaveBeenCalled();
    });

    it('keeps legacy personal delegation children and runs personal', async () => {
        const personalScope = { tenantId: null, organizationId: null };
        agents.findById.mockImplementation(async (id: string) => ({
            id,
            userId: OWNER,
            ...personalScope,
        }));
        agents.findByIdAndUser.mockImplementation(async (id: string) => ({
            id,
            userId: OWNER,
            ...personalScope,
        }));
        tasks.create.mockResolvedValue({ id: 'task-child', userId: OWNER, ...personalScope });

        await runner.run(request({ childAgentId: CHILD_AGENT }));

        expect(tasks.create).toHaveBeenCalledWith(OWNER, expect.any(Object), personalScope);
        expect(transitions.dispatchAgentRun).toHaveBeenCalledWith(
            expect.objectContaining(personalScope),
            CHILD_AGENT,
            expect.any(Object),
        );
    });

    describe("inputs reach the child's brief", () => {
        // The child Task description IS the delegation's only channel into
        // the child's prompt. When `inputs` was left out of it, every
        // caller that gathered context up front (the `delegateToAgent`
        // tool's `context` argument, an `agent.delegate` node's inputs)
        // had it accepted, validated, narrowed and then dropped — and the
        // child answered the objective without the data while the
        // delegation still reported `completed`.
        const descriptionOf = () => tasks.create.mock.calls[0][1].description as string;

        it('serializes inputs into the description under an Inputs heading', async () => {
            await runner.run(
                request({
                    childAgentId: CHILD_AGENT,
                    inputs: { ticket: 'EW-1234', urls: ['https://example.test/a'] },
                }),
            );

            const description = descriptionOf();
            expect(description).toContain('Inputs:');
            expect(description).toContain('EW-1234');
            expect(description).toContain('https://example.test/a');
        });

        it('omits the Inputs block entirely when there is nothing to hand over', async () => {
            await runner.run(request({ childAgentId: CHILD_AGENT }));
            expect(descriptionOf()).not.toContain('Inputs:');

            tasks.create.mockClear();
            await runner.run(request({ childAgentId: CHILD_AGENT, inputs: {} }));
            expect(descriptionOf()).not.toContain('Inputs:');
        });

        it('truncates oversized inputs with a visible marker instead of dropping them', async () => {
            await runner.run(
                request({
                    childAgentId: CHILD_AGENT,
                    inputs: { blob: 'x'.repeat(20_000) },
                }),
            );

            const description = descriptionOf();
            expect(description).toContain('Inputs:');
            expect(description).toContain('[inputs truncated at 4000 characters]');
            // Bounded: the stored description cannot grow with the payload.
            expect(description.length).toBeLessThan(4_500);
        });

        it('survives inputs that cannot be serialized rather than failing the delegation', async () => {
            const cyclic: Record<string, unknown> = { name: 'loop' };
            cyclic.self = cyclic;

            const result = await runner.run(request({ childAgentId: CHILD_AGENT, inputs: cyclic }));

            expect(result.status).toBe('completed');
            expect(descriptionOf()).not.toContain('Inputs:');
        });
    });

    it('records the PARENT as the author of the delegated work', async () => {
        await runner.run(request({ childAgentId: CHILD_AGENT }));

        // Recording the child would lose who decided the work should exist.
        expect(tasks.create.mock.calls[0][1].createdById).toBe(PARENT_AGENT);
    });

    it('recovers parentTaskId from the parent RUN when the caller names no Task', async () => {
        // The graph path only ever knows the run. Without this recovery
        // every delegated Task is created as a fresh root: no audit
        // linkage, and `TasksService.create`'s parent-chain guard is
        // skipped because it lives entirely inside `if (parentTaskId)`.
        // `runs.findById` serves BOTH the parent lookup and awaitTerminal's
        // poll loop, so the stub must also carry a terminal status — a run
        // with no status leaves the poll spinning until its budget expires.
        runs.findById.mockResolvedValue({
            id: 'run-parent',
            taskId: 'task-parent',
            status: 'completed',
            summary: 'done',
        });

        await runner.run(
            request({ childAgentId: CHILD_AGENT, parentTaskId: null, parentRunId: 'run-parent' }),
        );

        expect(tasks.create.mock.calls[0][1].parentTaskId).toBe('task-parent');
    });

    it('leaves parentTaskId null when the parent run resolves to nothing', async () => {
        runs.findById.mockResolvedValue(null);

        await runner.run(
            request({ childAgentId: CHILD_AGENT, parentTaskId: null, parentRunId: 'run-gone' }),
        );

        expect(tasks.create.mock.calls[0][1].parentTaskId).toBeNull();
    });

    it('stamps the child Task one delegation deeper than this request', async () => {
        // Judgment layer G9. This stamp is the ONLY record of how deep a
        // chain has gone: the depth resolver reads it back on the next hop,
        // and without it the ceiling is evaluated against a number the
        // caller declares — which is how the cap came to be inert.
        await runner.run(request({ childAgentId: CHILD_AGENT, depth: 2 }));

        expect(tasks.create.mock.calls[0][1].delegationDepth).toBe(3);
    });

    it('treats a missing depth as 0 rather than skipping the stamp', async () => {
        await runner.run(request({ childAgentId: CHILD_AGENT, depth: undefined as never }));

        // A child with no stamp would read back as depth 0 forever, which
        // is exactly the unbounded case.
        expect(tasks.create.mock.calls[0][1].delegationDepth).toBe(1);
    });

    it('refuses a child agent owned by someone else', async () => {
        agents.findByIdAndUser.mockResolvedValue(null);

        const result = await runner.run(request({ childAgentId: CHILD_AGENT }));

        // Otherwise a parent could spend another owner's budget and reach
        // their scope; the narrowing step cannot catch this.
        expect(result.status).toBe('failed');
        expect(result.summary).toMatch(/not found/);
        expect(transitions.dispatchAgentRun).not.toHaveBeenCalled();
    });

    it('refuses a named child with NO collaborator rows (legacy: self only)', async () => {
        collaborators.listForAgent.mockResolvedValue([]);

        const result = await runner.run(request({ childAgentId: CHILD_AGENT }));

        // A refusal, not a failure: the contract said no before anything
        // ran. The typed code lets callers branch and surfaces in the UI.
        expect(result.status).toBe('refused');
        expect(result.refusalCode).toBe('collaborator-not-allowed');
        expect(tasks.create).not.toHaveBeenCalled();
        expect(transitions.dispatchAgentRun).not.toHaveBeenCalled();
    });

    it('refuses a named child whose collaborator row is disabled', async () => {
        collaborators.listForAgent.mockResolvedValue([
            { collaboratorAgentId: CHILD_AGENT, enabled: false },
        ]);

        const result = await runner.run(request({ childAgentId: CHILD_AGENT }));

        expect(result.status).toBe('refused');
        expect(result.refusalCode).toBe('collaborator-not-allowed');
        expect(result.summary).toMatch(/disabled/);
        expect(transitions.dispatchAgentRun).not.toHaveBeenCalled();
    });

    it('allows an enabled collaborator child through to dispatch', async () => {
        collaborators.listForAgent.mockResolvedValue([
            { collaboratorAgentId: CHILD_AGENT, enabled: true },
        ]);

        const result = await runner.run(request({ childAgentId: CHILD_AGENT }));

        expect(result.status).toBe('completed');
        expect(transitions.dispatchAgentRun).toHaveBeenCalled();
    });

    it('refuses an ARCHIVED child even when an enabled rule still names it', async () => {
        // The rule row outlives the archive and the Collaborators tab
        // lists only live agents, so an owner who retires an agent has no
        // way to see (let alone clear) the rule still pointing at it —
        // and nothing downstream of dispatch re-checks agent status, so
        // the archived agent would keep executing delegated work.
        agents.findByIdAndUser.mockResolvedValue({
            id: CHILD_AGENT,
            userId: OWNER,
            status: 'archived',
            ...EVER_SCOPE,
        });
        collaborators.listForAgent.mockResolvedValue([
            { collaboratorAgentId: CHILD_AGENT, enabled: true },
        ]);

        const result = await runner.run(request({ childAgentId: CHILD_AGENT }));

        expect(result.status).toBe('refused');
        expect(result.refusalCode).toBe('collaborator-not-allowed');
        expect(result.summary).toMatch(/archived/);
        expect(tasks.create).not.toHaveBeenCalled();
        expect(transitions.dispatchAgentRun).not.toHaveBeenCalled();
    });

    it('still admits a non-archived child (the guard is not a blanket refusal)', async () => {
        agents.findByIdAndUser.mockImplementation(async (id: string) => ({
            id,
            userId: OWNER,
            status: 'paused',
            ...EVER_SCOPE,
        }));
        collaborators.listForAgent.mockResolvedValue([
            { collaboratorAgentId: CHILD_AGENT, enabled: true },
        ]);

        const result = await runner.run(request({ childAgentId: CHILD_AGENT }));

        expect(result.status).toBe('completed');
        expect(transitions.dispatchAgentRun).toHaveBeenCalled();
    });

    it('never consults the allow-list for self-delegation', async () => {
        // No childAgentId ⇒ the child IS the parent — exactly today's
        // default path, which must keep working with zero configuration.
        const result = await runner.run(request());

        expect(result.status).toBe('completed');
        expect(collaborators.listForAgent).not.toHaveBeenCalled();
    });

    it('checks ownership BEFORE the allow-list (cross-owner stays a failure)', async () => {
        agents.findByIdAndUser.mockResolvedValue(null);
        collaborators.listForAgent.mockResolvedValue([
            { collaboratorAgentId: CHILD_AGENT, enabled: true },
        ]);

        const result = await runner.run(request({ childAgentId: CHILD_AGENT }));

        // An enabled collaborator row must never launder a cross-owner
        // child into admissibility.
        expect(result.status).toBe('failed');
        expect(result.summary).toMatch(/not found/);
    });

    it('reports a failed child run as failed, carrying its error', async () => {
        runs.findById.mockResolvedValue({ status: 'failed', errorMessage: 'tool exploded' });

        const result = await runner.run(request());

        expect(result.status).toBe('failed');
        expect(result.summary).toBe('tool exploded');
        expect(result.output).toBeNull();
    });

    it('does not report success when the child never finishes', async () => {
        // A run parked by the gate, or a dead runtime, must not resolve as
        // completed-with-nothing — a parent would build on empty output.
        runs.findById.mockResolvedValue({ status: 'queued' });

        const result = await runner.run(request({ budget: { maxDurationMs: 1 } }));

        expect(result.status).toBe('failed');
        expect(result.summary).toMatch(/did not finish/);
    });

    it('fails cleanly when dispatch produces no run', async () => {
        transitions.dispatchAgentRun.mockResolvedValue({
            runId: null,
            dispatched: false,
            parked: false,
            error: 'no-dispatcher',
        });

        const result = await runner.run(request());

        expect(result.status).toBe('failed');
        expect(result.summary).toMatch(/no-dispatcher/);
    });
});
