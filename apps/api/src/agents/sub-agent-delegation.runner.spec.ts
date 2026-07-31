import { Test, TestingModule } from '@nestjs/testing';
import { DELEGATION_CLOCK, SubAgentDelegationRunnerService } from './sub-agent-delegation.runner';
import { AgentRepository, AgentRunRepository } from '@ever-works/agent/database';
import { TasksService, TaskTransitionService } from '@ever-works/agent/tasks-domain';

const PARENT_AGENT = 'agent-parent';
const CHILD_AGENT = 'agent-child';
const OWNER = 'user-1';

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
    let agents: { findById: jest.Mock };
    let runs: { findById: jest.Mock };
    let tasks: { create: jest.Mock };
    let transitions: { dispatchAgentRun: jest.Mock };

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
            findById: jest.fn(async (id: string) => ({ id, userId: OWNER })),
        };
        runs = { findById: jest.fn().mockResolvedValue({ status: 'completed', summary: 'done' }) };
        tasks = { create: jest.fn().mockResolvedValue({ id: 'task-child' }) };
        transitions = {
            dispatchAgentRun: jest
                .fn()
                .mockResolvedValue({ runId: 'run-child', dispatched: true, parked: false }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SubAgentDelegationRunnerService,
                { provide: AgentRepository, useValue: agents },
                { provide: AgentRunRepository, useValue: runs },
                { provide: TasksService, useValue: tasks },
                { provide: TaskTransitionService, useValue: transitions },
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
        );
        expect(transitions.dispatchAgentRun).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'task-child' }),
            CHILD_AGENT,
            expect.objectContaining({ dedupKey: 'delegation:del-1' }),
        );
        expect(result.status).toBe('completed');
        expect(result.childRunId).toBe('run-child');
    });

    it('records the PARENT as the author of the delegated work', async () => {
        await runner.run(request({ childAgentId: CHILD_AGENT }));

        // Recording the child would lose who decided the work should exist.
        expect(tasks.create.mock.calls[0][1].createdById).toBe(PARENT_AGENT);
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
        agents.findById.mockImplementation(async (id: string) =>
            id === CHILD_AGENT ? { id, userId: 'someone-else' } : { id, userId: OWNER },
        );

        const result = await runner.run(request({ childAgentId: CHILD_AGENT }));

        // Otherwise a parent could spend another owner's budget and reach
        // their scope; the narrowing step cannot catch this.
        expect(result.status).toBe('failed');
        expect(result.summary).toMatch(/different owner/);
        expect(transitions.dispatchAgentRun).not.toHaveBeenCalled();
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
