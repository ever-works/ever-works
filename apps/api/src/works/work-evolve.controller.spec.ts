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

import { WorkEvolveController } from './work-evolve.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * Prompt-injection hardening — `POST /api/works/:id/evolve` from a member who is
 * NOT the Work owner files the Task but never starts the owner's Agent
 * (`AppChangeRequestService` answers `awaitingOwner`); this route then tells the
 * owner in their Inbox. An owner's own request is unchanged and files no notice.
 */
describe('WorkEvolveController — a held change request reaches the owner', () => {
    const work = { id: 'w1', userId: 'owner', name: 'Helpdesk', kind: 'app', organizationId: null };

    function build(result: Record<string, unknown>) {
        const ownership = { ensureCanEdit: jest.fn(async () => ({ work, role: 'editor' })) };
        const changes = { request: jest.fn(async () => result) };
        const inbox = { notice: jest.fn(async () => undefined) };
        const controller = new WorkEvolveController(
            ownership as never,
            changes as never,
            {} as never,
            {} as never,
            {} as never,
            undefined,
            inbox as never,
        );
        const response = { status: jest.fn() };
        return { controller, changes, inbox, response };
    }

    const accepted = {
        status: 'accepted',
        httpStatus: 202,
        taskId: 't1',
        taskSlug: 'T-1',
        dispatched: false,
    };

    it("files an Inbox notice for the owner when a member's request is held", async () => {
        const { controller, inbox, response } = build({ ...accepted, awaitingOwner: true });
        await controller.evolve(
            { userId: 'editor' } as AuthenticatedUser,
            'w1',
            { request: 'Add dark mode' } as never,
            response as never,
        );
        expect(inbox.notice).toHaveBeenCalledWith(
            'owner',
            expect.objectContaining({ taskId: 't1', workId: 'w1' }),
        );
        expect(response.status).toHaveBeenCalledWith(202);
    });

    it("files no notice for the owner's own (dispatched) request", async () => {
        const { controller, inbox, response } = build({ ...accepted, dispatched: true });
        await controller.evolve(
            { userId: 'owner' } as AuthenticatedUser,
            'w1',
            { request: 'Add dark mode' } as never,
            response as never,
        );
        expect(inbox.notice).not.toHaveBeenCalled();
    });

    it('a failing notice never fails the request', async () => {
        const { controller, inbox, response } = build({ ...accepted, awaitingOwner: true });
        inbox.notice.mockRejectedValueOnce(new Error('inbox down'));
        await expect(
            controller.evolve(
                { userId: 'editor' } as AuthenticatedUser,
                'w1',
                { request: 'x' } as never,
                response as never,
            ),
        ).resolves.toMatchObject({ awaitingOwner: true });
    });
});
