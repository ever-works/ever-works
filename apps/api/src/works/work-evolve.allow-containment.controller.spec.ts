// Stub the agent barrels so the spec never drags the entity / services graph in.
jest.mock('@ever-works/agent/app-works', () => ({
    APP_WORK_RUN_ADMISSION: 'APP_WORK_RUN_ADMISSION',
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

import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { WorkEvolveController } from './work-evolve.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * APW-08 T48 / T12 (plan §4, FR-70, S33) — `POST /api/works/:id/app-runs/allow-containment`
 * `{ nodeId, allow }` → `204`: **Allow on this machine**, or withdraw it. Edit access to the Work,
 * an App Work, and a node that is the caller's own; plan §4's error contract (`404 notFound` for
 * an unknown node, `422 notAppWork`), and `503` when the store is not wired.
 */
describe('WorkEvolveController — allow-containment (APW-08 T48)', () => {
    const NODE = '11111111-1111-4111-8111-111111111111';
    const appWork = {
        id: 'w1',
        userId: 'owner',
        name: 'Bookings',
        kind: 'app',
        organizationId: null,
    };

    function build(
        opts: {
            work?: Record<string, unknown>;
            result?: Record<string, unknown>;
            noStore?: boolean;
            denied?: boolean;
        } = {},
    ) {
        const ownership = {
            ensureCanEdit: jest.fn(async () => {
                if (opts.denied) throw new NotFoundException('Work not found');
                return { work: opts.work ?? appWork, role: 'owner' };
            }),
        };
        const store = {
            setContainmentAllowance: jest.fn(
                async () => opts.result ?? { status: 'ok', allowances: [] },
            ),
        };
        const controller = new WorkEvolveController(
            ownership as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            undefined,
            undefined,
            opts.noStore ? undefined : (store as never),
        );
        return { controller, store, ownership };
    }

    const owner = { userId: 'owner' } as AuthenticatedUser;

    async function refusal(
        promise: Promise<unknown>,
    ): Promise<{ status: number; body: Record<string, unknown> }> {
        try {
            await promise;
        } catch (error) {
            expect(error).toBeInstanceOf(HttpException);
            const http = error as HttpException;
            return {
                status: http.getStatus(),
                body: http.getResponse() as Record<string, unknown>,
            };
        }
        throw new Error('expected a refusal');
    }

    it('answers 204 and allows the node on THIS Work, as the caller', async () => {
        const { controller, store, ownership } = build();
        await expect(
            controller.allowContainment(owner, 'w1', { nodeId: NODE, allow: true }),
        ).resolves.toBeUndefined();

        expect(ownership.ensureCanEdit).toHaveBeenCalledWith('w1', 'owner');
        expect(store.setContainmentAllowance).toHaveBeenCalledWith({
            workId: 'w1',
            nodeId: NODE,
            allow: true,
            actorUserId: 'owner',
        });
        expect(
            Reflect.getMetadata(
                HTTP_CODE_METADATA,
                WorkEvolveController.prototype.allowContainment,
            ),
        ).toBe(HttpStatus.NO_CONTENT);
    });

    it('withdraws with allow: false (and only an explicit true allows)', async () => {
        const { controller, store } = build();
        await controller.allowContainment(owner, 'w1', { nodeId: NODE, allow: false });
        await controller.allowContainment(owner, 'w1', { nodeId: NODE, allow: 'true' as never });
        expect(
            store.setContainmentAllowance.mock.calls.map(
                (call: unknown[]) => (call[0] as { allow: boolean }).allow,
            ),
        ).toEqual([false, false]);
    });

    it('an unknown node (or another account’s) is 404 notFound', async () => {
        const { controller } = build({ result: { status: 'notFound' } });
        const out = await refusal(
            controller.allowContainment(owner, 'w1', { nodeId: NODE, allow: true }),
        );
        expect(out.status).toBe(404);
        expect(out.body).toMatchObject({ code: 'notFound' });
    });

    it('a non-App Work is 422 notAppWork, before the store is asked', async () => {
        const { controller, store } = build({ work: { ...appWork, kind: 'directory' } });
        const out = await refusal(
            controller.allowContainment(owner, 'w1', { nodeId: NODE, allow: true }),
        );
        expect(out.status).toBe(422);
        expect(out.body).toMatchObject({ code: 'notAppWork' });
        expect(store.setContainmentAllowance).not.toHaveBeenCalled();
    });

    it('a Work the caller cannot edit is one 404, and the store is never asked', async () => {
        const { controller, store } = build({ denied: true });
        const out = await refusal(
            controller.allowContainment(owner, 'w1', { nodeId: NODE, allow: true }),
        );
        expect(out.status).toBe(404);
        expect(out.body).toMatchObject({ code: 'not_found' });
        expect(store.setContainmentAllowance).not.toHaveBeenCalled();
    });

    it('503 when the allowance store is not wired', async () => {
        const { controller } = build({ noStore: true });
        const out = await refusal(
            controller.allowContainment(owner, 'w1', { nodeId: NODE, allow: true }),
        );
        expect(out.status).toBe(503);
        expect(out.body).toMatchObject({ code: 'unavailable' });
    });

    it('is throttled at 10 a minute (plan §4)', () => {
        const keys = Reflect.getMetadataKeys(WorkEvolveController.prototype.allowContainment);
        const limitKey = keys.find((key: unknown) => String(key).includes('THROTTLER:LIMIT'));
        expect(limitKey).toBeDefined();
        expect(Reflect.getMetadata(limitKey, WorkEvolveController.prototype.allowContainment)).toBe(
            10,
        );
    });
});
