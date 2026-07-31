jest.mock('@ever-works/agent/database', () => ({ AgentRunRepository: class {} }));
jest.mock('@ever-works/agent/tasks-domain', () => ({ TaskRepository: class {} }));

import type { SubAgentDelegationRequest } from '@ever-works/contracts';
import { SubAgentDelegationDepthResolverService } from './sub-agent-delegation-depth.resolver';
import type { AgentRunRepository } from '@ever-works/agent/database';
import type { TaskRepository } from '@ever-works/agent/tasks-domain';

/**
 * Judgment layer G9 — server-derived delegation depth.
 *
 * The property under test is that the number comes from a row the
 * PLATFORM wrote, never from the caller. Everything here is about the
 * lookup being correct and, when it cannot be, failing in the direction
 * that leaves the existing behaviour untouched rather than inventing a
 * depth.
 */
describe('SubAgentDelegationDepthResolverService', () => {
    const PARENT_TASK = 'task-parent';
    const PARENT_RUN = 'run-parent';

    let tasks: { findById: jest.Mock };
    let runs: { findById: jest.Mock };
    let resolver: SubAgentDelegationDepthResolverService;

    const request = (over: Partial<SubAgentDelegationRequest> = {}): SubAgentDelegationRequest =>
        ({
            delegationId: 'del-1',
            parentAgentId: 'agent-1',
            depth: 0,
            objective: 'do the thing',
            scope: { allowedTools: ['read_file'] },
            ...over,
        }) as SubAgentDelegationRequest;

    beforeEach(() => {
        tasks = { findById: jest.fn() };
        runs = { findById: jest.fn() };
        resolver = new SubAgentDelegationDepthResolverService(
            tasks as unknown as TaskRepository,
            runs as unknown as AgentRunRepository,
        );
    });

    afterEach(() => jest.restoreAllMocks());

    it('reads the depth off the parent Task', async () => {
        tasks.findById.mockResolvedValue({ id: PARENT_TASK, delegationDepth: 2 });

        await expect(resolver.resolveDepth(request({ parentTaskId: PARENT_TASK }))).resolves.toBe(
            2,
        );
        expect(tasks.findById).toHaveBeenCalledWith(PARENT_TASK);
    });

    it('treats a null delegationDepth as 0, not as unresolvable', async () => {
        // Every human-filed Task, and every row predating the column. 0 is
        // a real depth for a root Task — returning null here would let the
        // caller's declared value stand for no reason.
        tasks.findById.mockResolvedValue({ id: PARENT_TASK, delegationDepth: null });

        await expect(resolver.resolveDepth(request({ parentTaskId: PARENT_TASK }))).resolves.toBe(
            0,
        );
    });

    it('falls back to the parent RUN when no parent task is threaded', async () => {
        runs.findById.mockResolvedValue({ id: PARENT_RUN, taskId: PARENT_TASK });
        tasks.findById.mockResolvedValue({ id: PARENT_TASK, delegationDepth: 1 });

        await expect(resolver.resolveDepth(request({ parentRunId: PARENT_RUN }))).resolves.toBe(1);
        expect(runs.findById).toHaveBeenCalledWith(PARENT_RUN);
    });

    it('prefers the parent task over the run when both are present', async () => {
        tasks.findById.mockResolvedValue({ id: PARENT_TASK, delegationDepth: 3 });

        await expect(
            resolver.resolveDepth(request({ parentTaskId: PARENT_TASK, parentRunId: PARENT_RUN })),
        ).resolves.toBe(3);
        expect(runs.findById).not.toHaveBeenCalled();
    });

    it('returns null when nothing anchors the request', async () => {
        await expect(resolver.resolveDepth(request())).resolves.toBeNull();
        expect(tasks.findById).not.toHaveBeenCalled();
    });

    it('returns null when the parent Task no longer exists', async () => {
        tasks.findById.mockResolvedValue(null);

        await expect(
            resolver.resolveDepth(request({ parentTaskId: PARENT_TASK })),
        ).resolves.toBeNull();
    });

    it('returns null when the parent run has no task', async () => {
        runs.findById.mockResolvedValue({ id: PARENT_RUN, taskId: null });

        await expect(
            resolver.resolveDepth(request({ parentRunId: PARENT_RUN })),
        ).resolves.toBeNull();
    });

    it('never throws — a lookup outage resolves to null', async () => {
        // A database blip must not convert a delegation into an error; the
        // declared depth simply stands.
        tasks.findById.mockRejectedValue(new Error('db down'));

        await expect(
            resolver.resolveDepth(request({ parentTaskId: PARENT_TASK })),
        ).resolves.toBeNull();
    });

    it('normalizes a corrupt stored depth to 0 rather than trusting it', async () => {
        tasks.findById.mockResolvedValue({ id: PARENT_TASK, delegationDepth: -7 });

        await expect(resolver.resolveDepth(request({ parentTaskId: PARENT_TASK }))).resolves.toBe(
            0,
        );
    });

    it('leaks nothing but the integer', async () => {
        // The lookup is not user-scoped (the service is runtime-free and
        // has no userId), so the mitigation is that the return value is a
        // number and nothing else — no title, no ids, no existence signal.
        tasks.findById.mockResolvedValue({
            id: PARENT_TASK,
            title: 'secret task title',
            userId: 'someone-else',
            delegationDepth: 1,
        });

        const result = await resolver.resolveDepth(request({ parentTaskId: PARENT_TASK }));

        expect(typeof result).toBe('number');
        expect(result).toBe(1);
    });
});
