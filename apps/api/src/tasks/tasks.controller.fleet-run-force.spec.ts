jest.mock('@ever-works/agent/tasks-domain', () => ({
    TasksService: class {},
    TaskChatService: class {},
    TaskReviewRejectionService: class {},
    TaskWorkspaceService: class {},
    TaskPrStatusService: class {},
    TaskStatus: { TODO: 'todo', IN_PROGRESS: 'in_progress', IN_REVIEW: 'in_review', DONE: 'done' },
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
import { TasksController } from './tasks.controller';

/**
 * `force` on `POST /api/tasks/:id/transition` is refused for a FLEET-RUN
 * credential (found in review of self-build slice AD, EW-811).
 *
 * `force` overrides the approver gate on `in_review → done` — every
 * approver, human or agent. The MCP whitelist withholds it
 * (`omitArgs: ['force']`) because it answers a gate, but a fleet-run token
 * acts AS THE OWNER and the route itself is on the token's surface, so a
 * model holding the token could send the field directly. A path allowlist
 * cannot see a body field; the controller refuses it.
 */
describe('TasksController.transition — force is not available to a fleet-run credential', () => {
    const auth = { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } as never;
    const taskId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const scope = { tenantId: null, organizationId: null };

    function build() {
        const service = { transition: jest.fn().mockResolvedValue({ id: taskId, status: 'done' }) };
        const controller = new TasksController(
            service as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            { getScope: () => scope } as never,
        );
        return { controller, service };
    }

    const runTokenRequest = { fleetRunCredential: { jobId: 'job-1', organizationId: 'org-1' } };

    it('refuses force=true from a fleet-run credential, and never reaches the service', async () => {
        const { controller, service } = build();
        await expect(
            controller.transition(
                auth,
                taskId,
                { to: 'done', force: true } as never,
                runTokenRequest,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(service.transition).not.toHaveBeenCalled();
    });

    it('still lets a fleet-run credential transition WITHOUT force — the gate then applies', async () => {
        const { controller, service } = build();
        await controller.transition(auth, taskId, { to: 'done' } as never, runTokenRequest);
        expect(service.transition).toHaveBeenCalledWith(
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            taskId,
            'done',
            { force: false },
            scope,
        );
    });

    it('leaves a person (no run credential) able to force, exactly as before', async () => {
        const { controller, service } = build();
        await controller.transition(auth, taskId, { to: 'done', force: true } as never, {});
        expect(service.transition).toHaveBeenCalledWith(
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            taskId,
            'done',
            { force: true },
            scope,
        );
        // …and a positional caller that passes no request at all, too.
        await controller.transition(auth, taskId, { to: 'done', force: true } as never);
        expect(service.transition).toHaveBeenCalledTimes(2);
    });
});

/**
 * `requireAllApprovers` — the approver POLICY, the other gate override the
 * MCP whitelist withholds (`omitArgs` on create and update). `false` turns
 * the `→ done` approver check off for every approver, human or agent, so a
 * fleet-run credential may not send it; `true` only keeps the gate on.
 */
describe('TasksController create/update — a fleet-run credential cannot relax the approver policy', () => {
    const auth = { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } as never;
    const taskId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const scope = { tenantId: null, organizationId: null };
    const runTokenRequest = { fleetRunCredential: { jobId: 'job-1', organizationId: 'org-1' } };

    function build() {
        const service = {
            create: jest.fn().mockResolvedValue({ id: taskId }),
            update: jest.fn().mockResolvedValue({ id: taskId }),
        };
        const controller = new TasksController(
            service as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            { getScope: () => scope } as never,
        );
        return { controller, service };
    }

    it('refuses requireAllApprovers=false on create and on update, and never reaches the service', async () => {
        const { controller, service } = build();
        await expect(
            controller.create(
                auth,
                { title: 'x', requireAllApprovers: false } as never,
                runTokenRequest,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            controller.update(
                auth,
                taskId,
                { requireAllApprovers: false } as never,
                runTokenRequest,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        // Fail closed on anything that is not the literal `true`.
        await expect(
            controller.update(
                auth,
                taskId,
                { requireAllApprovers: null } as never,
                runTokenRequest,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(service.create).not.toHaveBeenCalled();
        expect(service.update).not.toHaveBeenCalled();
    });

    it('lets a fleet-run credential omit the flag, or keep the gate ON', async () => {
        const { controller, service } = build();
        await controller.create(auth, { title: 'x' } as never, runTokenRequest);
        await controller.update(
            auth,
            taskId,
            { requireAllApprovers: true } as never,
            runTokenRequest,
        );
        expect(service.create).toHaveBeenCalledTimes(1);
        expect(service.update).toHaveBeenCalledTimes(1);
    });

    it('leaves a person (no run credential) able to relax the policy, exactly as before', async () => {
        const { controller, service } = build();
        await controller.create(auth, { title: 'x', requireAllApprovers: false } as never, {});
        await controller.update(auth, taskId, { requireAllApprovers: false } as never);
        expect(service.create).toHaveBeenCalledWith(
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            expect.objectContaining({ requireAllApprovers: false }),
            scope,
        );
        expect(service.update).toHaveBeenCalledWith(
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            taskId,
            expect.objectContaining({ requireAllApprovers: false }),
            scope,
        );
    });
});
