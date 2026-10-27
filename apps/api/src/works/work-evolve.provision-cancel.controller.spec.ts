// Stub the agent barrels so the spec never drags the entity / services graph in.
jest.mock('@ever-works/agent/app-works', () => ({
    AppChangeRequestService: class AppChangeRequestService {},
    AppProvisioningService: class AppProvisioningService {},
    EVOLVE_APP_AGENT_TEMPLATE: {},
    PROVISION_LABEL: 'app-provision',
}));
jest.mock('@ever-works/agent/database', () => ({ ownershipScopeOf: () => ({}) }));
jest.mock('@ever-works/agent/inbox', () => ({ INBOX_PRODUCER: 'INBOX_PRODUCER' }));
jest.mock('@ever-works/agent/agents', () => ({
    AgentScope: { WORK: 'work' },
    AgentTemplatesService: class AgentTemplatesService {},
}));
jest.mock('@ever-works/agent/tasks-domain', () => ({ TaskRepository: class TaskRepository {} }));
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));
jest.mock('@ever-works/agent/upstream-pull-requests', () => ({
    UpstreamPullRequestOpenService: class UpstreamPullRequestOpenService {},
}));
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import { HttpException, HttpStatus } from '@nestjs/common';
import { WorkEvolveController } from './work-evolve.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * APW-04 (plan §4) — `POST /api/works/:id/provision/cancel`. The controller decides
 * nothing about the cancel itself: it authorises EDIT access on an App Work, hands the
 * service the Work and the caller, and sets the answer's `httpStatus` verbatim.
 */
describe('WorkEvolveController — POST :id/provision/cancel', () => {
    const appWork = { id: 'w1', userId: 'owner', name: 'Helpdesk', kind: 'app' };

    function build(options: {
        work?: Record<string, unknown>;
        access?: () => Promise<unknown>;
        result?: Record<string, unknown>;
    }) {
        const ownership = {
            ensureCanEdit: jest.fn(
                options.access ?? (async () => ({ work: options.work ?? appWork, role: 'editor' })),
            ),
            ensureCanView: jest.fn(),
        };
        const provisioning = {
            cancel: jest.fn(
                async () =>
                    options.result ?? {
                        status: 'cancelled',
                        httpStatus: 202,
                        taskId: 't1',
                        alreadyCancelled: false,
                        cancelledRunIds: ['r1'],
                    },
            ),
        };
        const controller = new WorkEvolveController(
            ownership as never,
            {} as never,
            provisioning as never,
            {} as never,
            {} as never,
        );
        const response = { status: jest.fn() };
        return { controller, ownership, provisioning, response };
    }

    const editor = { userId: 'editor' } as AuthenticatedUser;

    it('asks for EDIT access, cancels through the service and sets its status verbatim', async () => {
        const { controller, ownership, provisioning, response } = build({});

        await expect(
            controller.cancelProvisioning(editor, 'w1', response as never),
        ).resolves.toMatchObject({ status: 'cancelled', taskId: 't1' });

        expect(ownership.ensureCanEdit).toHaveBeenCalledWith('w1', 'editor');
        expect(ownership.ensureCanView).not.toHaveBeenCalled();
        expect(provisioning.cancel).toHaveBeenCalledWith({ workId: 'w1', userId: 'editor' });
        expect(response.status).toHaveBeenCalledWith(202);
    });

    it('passes a refusal through with its own status', async () => {
        const { controller, response } = build({
            result: {
                status: 'refused',
                httpStatus: 409,
                code: 'nothingToCancel',
                taskId: null,
                alreadyCancelled: false,
                cancelledRunIds: [],
            },
        });
        await expect(
            controller.cancelProvisioning(editor, 'w1', response as never),
        ).resolves.toMatchObject({ code: 'nothingToCancel' });
        expect(response.status).toHaveBeenCalledWith(409);
    });

    it('answers 404 for a viewer (no edit access) and never reaches the service', async () => {
        const { controller, provisioning, response } = build({
            access: async () => {
                throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
            },
        });
        await expect(
            controller.cancelProvisioning(editor, 'w1', response as never),
        ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
        expect(provisioning.cancel).not.toHaveBeenCalled();
    });

    it('answers 422 notAppWork for a Work that is not an App Work', async () => {
        const { controller, provisioning, response } = build({
            work: { ...appWork, kind: 'directory' },
        });
        await expect(
            controller.cancelProvisioning(editor, 'w1', response as never),
        ).rejects.toMatchObject({ status: HttpStatus.UNPROCESSABLE_ENTITY });
        expect(provisioning.cancel).not.toHaveBeenCalled();
    });
});
