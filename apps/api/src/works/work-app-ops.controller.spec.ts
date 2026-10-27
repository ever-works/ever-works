// The same stubs `work-app-runtime.controller.spec.ts` uses, for the same reasons: the services
// and runtime barrels pull ESM-only packages jest cannot parse, and the auth barrel pulls
// `better-auth`. Every collaborator below is a double.
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));
jest.mock('@ever-works/agent/app-runtime', () => ({
    AppTargetService: class AppTargetService {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class ActivityLogService {},
}));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: { APP_JOB: 'app_job', APP_SMOKE: 'app_smoke' },
    ActivityStatus: { PENDING: 'pending' },
}));
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import { ForbiddenException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { WorkAppOpsController } from './work-app-ops.controller';

/**
 * Lane aw-ops (APW-06 §9.1) — the access rule and the status mapping of the live App's
 * operations. The service is a fake: what it decides is `app-target.ops.spec.ts`'s subject.
 *
 * Pinned: (a) a stranger gets the unknown-id 404 body on every route; (b) a viewer gets 403 on
 * every action AND on the log read (FR-48), but may read the history (S28); (c) only then the kind;
 * a 202 answers `{ status: 'accepted', op, requestId, dispatched }`; a refusal keeps its status,
 * code and, for a 429, its wait (body and `Retry-After`); job and smoke requests write one
 * Activity row each, with no value in it.
 */
describe('WorkAppOpsController', () => {
    const auth = { userId: 'u-1', authMethod: 'session' } as never;
    const WORK_ID = '00000000-0000-4000-8000-000000000001';
    const REQUEST_ID = 'b5e1c7a0-3333-4c4d-9e5f-607182930415';

    function build(opts: { kind?: string; view?: Error; edit?: Error } = {}) {
        const kind = opts.kind ?? 'app';
        const ownership = {
            ensureCanView: jest.fn(async () => {
                if (opts.view) throw opts.view;
                return { work: { id: WORK_ID, kind } };
            }),
            ensureCanEdit: jest.fn(async () => {
                if (opts.edit) throw opts.edit;
                return { work: { id: WORK_ID, kind }, role: 'editor' };
            }),
        };
        const accepted = (op: string) =>
            jest.fn(async () => ({ ok: true, httpStatus: 202, op, requestId: REQUEST_ID, dispatched: true }));
        const targets = {
            refreshStatus: accepted('status-refresh'),
            requestLogs: accepted('logs'),
            readLogs: jest.fn(async () => ({ ok: true, body: { requestId: REQUEST_ID, status: 'pending' } })),
            runJob: accepted('job-run'),
            runSmoke: accepted('smoke'),
            listDeployments: jest.fn(async () => [{ id: 'd-1', state: 'READY' }]),
        };
        const activity = { log: jest.fn(async () => undefined) };
        const response = { status: jest.fn(), setHeader: jest.fn() };
        return {
            controller: new WorkAppOpsController(ownership as never, targets as never, activity as never),
            ownership,
            targets,
            activity,
            response,
        };
    }

    /** Every route, called the way Nest would. */
    const routes = (c: WorkAppOpsController, response: unknown) => ({
        refresh: () => c.refreshStatus(auth, WORK_ID, response as never),
        logs: () => c.requestLogs(auth, WORK_ID, { component: 'web' }, response as never),
        readLogs: () => c.readLogs(auth, WORK_ID, REQUEST_ID),
        job: () => c.runJob(auth, WORK_ID, 'migrate', { confirmFirstDeploy: true }, response as never),
        smoke: () => c.runSmoke(auth, WORK_ID, response as never),
        history: () => c.listDeployments(auth, WORK_ID),
    });

    async function statusOf(call: () => Promise<unknown>): Promise<{ status: number; body: unknown }> {
        try {
            await call();
            return { status: 200, body: null };
        } catch (error) {
            const http = error as HttpException;
            return { status: http.getStatus(), body: http.getResponse() };
        }
    }

    it('answers a stranger the unknown-id 404 on every route, with nothing reaching the service', async () => {
        for (const denial of [new NotFoundException(), new ForbiddenException()]) {
            const { controller, targets, response } = build({ view: denial });
            for (const [name, call] of Object.entries(routes(controller, response))) {
                const answer = await statusOf(call);
                expect([name, answer]).toEqual([
                    name,
                    {
                        status: HttpStatus.NOT_FOUND,
                        body: { status: 'error', message: `Work with id '${WORK_ID}' not found` },
                    },
                ]);
            }
            for (const fn of Object.values(targets)) expect(fn).not.toHaveBeenCalled();
        }
    });

    it('answers a viewer 403 on every action and on the log read, but lists the history', async () => {
        const { controller, targets, response } = build({ edit: new ForbiddenException() });
        const all = routes(controller, response);
        for (const name of ['refresh', 'logs', 'readLogs', 'job', 'smoke'] as const) {
            const answer = await statusOf(all[name]);
            expect([name, answer.status, (answer.body as { code?: string }).code]).toEqual([
                name,
                HttpStatus.FORBIDDEN,
                'forbidden',
            ]);
        }
        expect(targets.refreshStatus).not.toHaveBeenCalled();
        expect(targets.readLogs).not.toHaveBeenCalled();
        await expect(all.history()).resolves.toEqual({ deployments: [{ id: 'd-1', state: 'READY' }] });
    });

    it('checks the kind only after access: a visible non-App Work is 404 notAppWork', async () => {
        const { controller, response } = build({ kind: 'directory' });
        const answer = await statusOf(routes(controller, response).smoke);
        expect(answer.status).toBe(HttpStatus.NOT_FOUND);
        expect(answer.body).toMatchObject({ code: 'notAppWork' });
    });

    it('answers 202 with the request id for each queued op', async () => {
        const { controller, response, targets } = build();
        const all = routes(controller, response);
        await expect(all.refresh()).resolves.toEqual({
            status: 'accepted',
            op: 'status-refresh',
            requestId: REQUEST_ID,
            dispatched: true,
        });
        await expect(all.logs()).resolves.toMatchObject({ op: 'logs' });
        await expect(all.job()).resolves.toMatchObject({ op: 'job-run' });
        await expect(all.smoke()).resolves.toMatchObject({ op: 'smoke' });
        expect(response.status).toHaveBeenCalledWith(HttpStatus.ACCEPTED);
        expect(targets.runJob).toHaveBeenCalledWith(WORK_ID, 'u-1', 'migrate', { confirmFirstDeploy: true });
        await expect(all.readLogs()).resolves.toEqual({ requestId: REQUEST_ID, status: 'pending' });
    });

    it('keeps a refusal’s status and code, and a 429’s wait in the body and Retry-After', async () => {
        const { controller, response, targets } = build();
        targets.refreshStatus.mockResolvedValueOnce({
            ok: false,
            refusal: { httpStatus: 429, code: 'refresh_too_soon', message: 'wait', retryAfterSeconds: 9 },
        } as never);
        const answer = await statusOf(() => controller.refreshStatus(auth, WORK_ID, response as never));
        expect(answer).toEqual({
            status: 429,
            body: { status: 'error', code: 'refresh_too_soon', message: 'wait', retryAfterSeconds: 9 },
        });
        expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '9');

        targets.readLogs.mockResolvedValueOnce({
            ok: false,
            refusal: { httpStatus: 404, code: 'logs_request_not_found', message: 'gone' },
        } as never);
        await expect(statusOf(() => controller.readLogs(auth, WORK_ID, REQUEST_ID))).resolves.toMatchObject({
            status: 404,
            body: { code: 'logs_request_not_found' },
        });
    });

    it('records one Activity row per job or smoke request — names and ids, no value', async () => {
        const { controller, response, activity } = build();
        await controller.runJob(auth, WORK_ID, 'migrate', { confirmFirstDeploy: true }, response as never);
        await controller.runSmoke(auth, WORK_ID, response as never);
        await controller.refreshStatus(auth, WORK_ID, response as never);
        await controller.requestLogs(auth, WORK_ID, { job: 'migrate' }, response as never);

        expect(activity.log).toHaveBeenCalledTimes(2);
        expect(activity.log).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                workId: WORK_ID,
                userId: 'u-1',
                actionType: 'app_job',
                action: 'app.job.requested',
                metadata: { jobName: 'migrate', requestId: REQUEST_ID, dispatched: true },
            }),
        );
        expect(activity.log).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ actionType: 'app_smoke', action: 'app.smoke.requested' }),
        );
    });

    it('writes no Activity row for a refused job run', async () => {
        const { controller, response, targets, activity } = build();
        targets.runJob.mockResolvedValueOnce({
            ok: false,
            refusal: { httpStatus: 422, code: 'job_confirmation_required', message: 'confirm' },
        } as never);
        const answer = await statusOf(() => controller.runJob(auth, WORK_ID, 'migrate', {}, response as never));
        expect(answer.status).toBe(422);
        expect(activity.log).not.toHaveBeenCalled();
    });
});
