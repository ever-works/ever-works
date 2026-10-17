// The same three stubs `work-app-deploy.controller.spec.ts` uses, for the same reasons: the
// services and runtime barrels pull ESM-only packages jest cannot parse, and the auth barrel pulls
// `better-auth`. Every collaborator below is a double.
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));
jest.mock('@ever-works/agent/app-runtime', () => ({
    AppTargetService: class AppTargetService {},
}));
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import { HttpException, HttpStatus, NotFoundException, ForbiddenException } from '@nestjs/common';
import { WorkAppRuntimeController } from './work-app-runtime.controller';

/**
 * APW-06 T33 (lane aw-deploy-2) — the access rule and the status mapping of the four Deploy-tab
 * routes. The service is a fake: what it decides is `app-target.service.spec.ts`'s subject.
 */
describe('WorkAppRuntimeController', () => {
    const auth = { userId: 'u-1' } as never;
    const WORK_ID = '00000000-0000-4000-8000-000000000001';

    function build(kind = 'app', deny?: Error) {
        const ownership = {
            ensureCanView: jest.fn(async () => {
                if (deny) throw deny;
                return { work: { id: WORK_ID, kind } };
            }),
            ensureCanEdit: jest.fn(async () => {
                if (deny) throw deny;
                return { work: { id: WORK_ID, kind } };
            }),
        };
        const targets = {
            getTarget: jest.fn(async () => ({ target: 'your-cluster' })),
            putTarget: jest.fn(async () => ({ ok: true, body: { target: 'your-cluster' } })),
            check: jest.fn(async () => ({
                ok: true,
                httpStatus: 202,
                requestId: 'req-1',
                dispatched: true,
            })),
            getStatus: jest.fn(async () => ({ state: 'live' })),
            rollback: jest.fn(async () => ({
                ok: true,
                result: {
                    status: 'accepted',
                    httpStatus: 202,
                    code: null,
                    deploymentId: 'd-2',
                    unmet: [],
                    advisory: [],
                    warnings: [],
                },
            })),
            lifecycle: jest.fn(async () => ({
                ok: true,
                httpStatus: 202,
                requestId: 'req-2',
                dispatched: true,
                action: 'remove',
            })),
        };
        return {
            controller: new WorkAppRuntimeController(ownership as never, targets as never),
            ownership,
            targets,
        };
    }

    it('answers the target, the status and a 202 check with no credential in the body', async () => {
        const { controller, targets } = build();
        const response = { status: jest.fn() };

        await expect(controller.getAppTarget(auth, WORK_ID)).resolves.toEqual({
            target: 'your-cluster',
        });
        await expect(controller.getAppStatus(auth, WORK_ID)).resolves.toEqual({ state: 'live' });
        await expect(
            controller.checkAppTarget(auth, WORK_ID, { kubeconfig: 'apiVersion: v1' }, response),
        ).resolves.toEqual({ status: 'accepted', requestId: 'req-1', dispatched: true });
        expect(response.status).toHaveBeenCalledWith(HttpStatus.ACCEPTED);
        expect(targets.check).toHaveBeenCalledWith(WORK_ID, 'u-1', {
            kubeconfig: 'apiVersion: v1',
        });
    });

    it('answers one 404 for a missing or invisible Work, and 404 notAppWork for a website', async () => {
        for (const deny of [new NotFoundException(), new ForbiddenException()]) {
            const { controller, targets } = build('app', deny);
            await expect(controller.getAppTarget(auth, WORK_ID)).rejects.toMatchObject({
                status: 404,
            });
            expect(targets.getTarget).not.toHaveBeenCalled();
        }
        const website = build('website');
        await expect(website.controller.getAppStatus(auth, WORK_ID)).rejects.toMatchObject({
            status: 404,
            response: expect.objectContaining({ code: 'notAppWork' }),
        });
    });

    it('uses view access for reads and edit access for writes', async () => {
        const { controller, ownership } = build();
        await controller.getAppTarget(auth, WORK_ID);
        await controller.putAppTarget(auth, WORK_ID, { target: 'your-cluster' });
        expect(ownership.ensureCanView).toHaveBeenCalledTimes(1);
        expect(ownership.ensureCanEdit).toHaveBeenCalledTimes(1);
    });

    it("throws the service's refusal with its status and unmet list", async () => {
        const { controller, targets } = build();
        targets.putTarget.mockResolvedValueOnce({
            ok: false,
            refusal: {
                httpStatus: 422,
                code: 'APP_TARGET_REFUSED',
                message: 'closed',
                unmet: [{ code: 'managed_disabled', message: 'closed' }],
            },
        } as never);

        const error = await controller
            .putAppTarget(auth, WORK_ID, { target: 'ever-works-apps' })
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(422);
        expect((error as HttpException).getResponse()).toMatchObject({
            code: 'APP_TARGET_REFUSED',
            unmet: [{ code: 'managed_disabled' }],
        });
    });

    it('rolls back with the deploy answer and passes the Work slug to a lifecycle action (lane aw-deploy-3)', async () => {
        const { controller, targets } = build();
        const response = { status: jest.fn() };

        await expect(
            controller.rollbackApp(auth, WORK_ID, { deploymentId: 'd-1' }, response),
        ).resolves.toMatchObject({ status: 'accepted', deploymentId: 'd-2', unmet: [] });
        expect(response.status).toHaveBeenCalledWith(202);

        await expect(
            controller.lifecycleApp(auth, WORK_ID, { action: 'remove' }, response),
        ).resolves.toEqual({
            status: 'accepted',
            action: 'remove',
            requestId: 'req-2',
            dispatched: true,
        });
        expect(targets.lifecycle).toHaveBeenCalledWith({ id: WORK_ID, slug: null }, 'u-1', {
            action: 'remove',
        });
    });
});
