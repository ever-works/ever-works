// 🛑 `@ever-works/agent/services` is a 200-module barrel: loading it pulls
// `work-lifecycle.service` -> the markdown generator -> `github-slugger`, an
// ESM-only package jest cannot parse, and the suite dies before its first test.
// `work-app-spec.controller.spec.ts` solves it the same way; this suite needs no
// behaviour from the class at all (the ownership service is a double in every
// case below), so a shell is enough.
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));
// The same for the runtime barrel: the controller imports `AppDeployRequestService`
// as a DI token and this suite always supplies a double.
jest.mock('@ever-works/agent/app-runtime', () => ({
    AppDeployRequestService: class AppDeployRequestService {},
}));
// The auth barrel pulls `better-auth`, an ESM package jest cannot parse, which is
// why every controller spec in this app stubs it. Nothing here drives a router,
// so the decorators only have to exist.
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import { HttpException, HttpStatus } from '@nestjs/common';
import type {
    AppDeployRequestResult,
    AppDeployRequestService,
} from '@ever-works/agent/app-runtime';
import type { WorkOwnershipService } from '@ever-works/agent/services';

import { WorkAppDeployController } from './work-app-deploy.controller';

/**
 * APW-06 §2.2 — `POST /api/works/:id/deploy`.
 *
 * The controller decides three things and no more, so this file tests exactly
 * those three:
 *
 *   1. **who may ask** — edit access to a visible App Work, with one `404` for
 *      missing / invisible / another account's, and `422 notAnAppWork` for a
 *      visible Work of the wrong kind;
 *   2. **what it passes on** — the caller's id, `manual`, and only the two body
 *      fields §2.2 step 1 names;
 *   3. **the status** — `result.httpStatus`, verbatim.
 *
 * Everything behind it — the isolated-worker gate, the preconditions, the lock
 * claim, the queue, the dedupe, the dispatch budget — is
 * `app-deploy-request.service.spec.ts`'s, and a second copy of any of it here
 * would be a second answer to the same question.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function result(overrides: Partial<AppDeployRequestResult> = {}): AppDeployRequestResult {
    return {
        status: 'accepted',
        httpStatus: 202,
        code: null,
        deploymentId: 'd-1',
        queuedDeploymentId: null,
        queuedBuildId: null,
        runningDeploymentId: null,
        unmet: [],
        advisory: [],
        warnings: [],
        dispatched: true,
        deduplicated: false,
        stored: {} as AppDeployRequestResult['stored'],
        ...overrides,
    };
}

function ownership(kind = 'app'): WorkOwnershipService {
    return {
        ensureCanEdit: jest.fn(async () => ({ work: { id: WORK_ID, kind }, isCreator: true })),
    } as unknown as WorkOwnershipService;
}

function refusingOwnership(status: HttpStatus): WorkOwnershipService {
    return {
        ensureCanEdit: jest.fn(async () => {
            throw new HttpException('nope', status);
        }),
    } as unknown as WorkOwnershipService;
}

function service(answer = result()): AppDeployRequestService & { request: jest.Mock } {
    return { request: jest.fn(async () => answer) } as unknown as AppDeployRequestService & {
        request: jest.Mock;
    };
}

/** The `@Res({ passthrough: true })` surface, recording what the route set. */
function response(): { status: jest.Mock; code: () => number | undefined } {
    const status = jest.fn();
    return { status, code: () => status.mock.calls.at(-1)?.[0] };
}

const auth = { userId: USER_ID } as never;

describe('WorkAppDeployController — access', () => {
    it('answers ONE 404 for missing, invisible and another account’s alike', async () => {
        // Three different answers would make this route a way to discover whose
        // Work is whose.
        for (const status of [HttpStatus.NOT_FOUND, HttpStatus.FORBIDDEN]) {
            const controller = new WorkAppDeployController(refusingOwnership(status), service());

            await expect(controller.deploy(auth, WORK_ID, {}, response())).rejects.toMatchObject({
                status: HttpStatus.NOT_FOUND,
            });
        }
    });

    it('refuses a visible Work of the wrong kind with 422 notAnAppWork', async () => {
        const request = service();
        const controller = new WorkAppDeployController(ownership('directory'), request);

        await expect(controller.deploy(auth, WORK_ID, {}, response())).rejects.toMatchObject({
            status: HttpStatus.UNPROCESSABLE_ENTITY,
        });
        // And nothing was asked of the deploy path.
        expect(request.request).not.toHaveBeenCalled();
    });

    it('lets an unrelated ownership failure through unchanged', async () => {
        // A 500 from the ownership service is not a "not found", and turning it
        // into one would hide an outage behind a normal-looking answer.
        const controller = new WorkAppDeployController(
            refusingOwnership(HttpStatus.INTERNAL_SERVER_ERROR),
            service(),
        );

        await expect(controller.deploy(auth, WORK_ID, {}, response())).rejects.toMatchObject({
            status: HttpStatus.INTERNAL_SERVER_ERROR,
        });
    });
});

describe('WorkAppDeployController — what it passes on', () => {
    it('records the CALLER, not the owner, and the manual trigger', async () => {
        // The website route deploys as the owner because it needs that member's
        // provider token. This one needs none, so the Deployment records who
        // actually pressed the button — which is what FR-23's `manual` source
        // and the Activity row are for.
        const request = service();

        await new WorkAppDeployController(ownership(), request).deploy(
            auth,
            WORK_ID,
            {},
            response(),
        );

        expect(request.request).toHaveBeenCalledWith({
            workId: WORK_ID,
            userId: USER_ID,
            trigger: 'manual',
        });
    });

    it('forwards only the two body fields §2.2 step 1 names', async () => {
        const request = service();

        await new WorkAppDeployController(ownership(), request).deploy(
            auth,
            WORK_ID,
            { buildId: 'b-1', confirmClusterChange: true } as never,
            response(),
        );

        expect(request.request).toHaveBeenCalledWith({
            workId: WORK_ID,
            userId: USER_ID,
            trigger: 'manual',
            buildId: 'b-1',
            confirmClusterChange: true,
        });
    });

    it('omits confirmClusterChange unless it is literally true', async () => {
        // S29's confirmation is an affirmative act. A missing field, `false` or
        // a truthy string must not move a member's app to a different cluster.
        const request = service();

        await new WorkAppDeployController(ownership(), request).deploy(
            auth,
            WORK_ID,
            { confirmClusterChange: 'yes' } as never,
            response(),
        );

        expect(request.request.mock.calls[0][0]).not.toHaveProperty('confirmClusterChange');
    });
});

describe('WorkAppDeployController — the status', () => {
    it('answers 202 for an accepted Deployment', async () => {
        const res = response();

        const body = await new WorkAppDeployController(ownership(), service()).deploy(
            auth,
            WORK_ID,
            {},
            res,
        );

        expect(res.code()).toBe(202);
        expect(body.deploymentId).toBe('d-1');
        expect(body.status).toBe('accepted');
    });

    it('uses the service’s status VERBATIM for every refusal', async () => {
        // Re-deriving a status from `code` here is how a route and a service
        // start disagreeing about what a refusal means.
        for (const [httpStatus, code] of [
            [409, 'APP_DEPLOY_IN_PROGRESS'],
            [422, 'APP_DEPLOY_PRECONDITIONS'],
            [422, 'worker_not_isolated'],
            [503, 'app_deploy_state_unavailable'],
        ] as const) {
            const res = response();

            await new WorkAppDeployController(
                ownership(),
                service(result({ status: 'refused', httpStatus, code, deploymentId: null })),
            ).deploy(auth, WORK_ID, {}, res);

            expect(res.code()).toBe(httpStatus);
        }
    });

    it('renders unmet preconditions as code + message, and nothing else', async () => {
        // The entries are shown to the member. Anything beyond a code and a
        // sentence is a field nobody vetted for values or log text.
        const res = response();

        const body = await new WorkAppDeployController(
            ownership(),
            service(
                result({
                    status: 'refused',
                    httpStatus: 422,
                    code: 'APP_DEPLOY_PRECONDITIONS',
                    deploymentId: null,
                    unmet: [
                        {
                            code: 'no_green_build',
                            message: 'No green Build to deploy.',
                            detail: { secret: 'must not be rendered' },
                        } as never,
                    ],
                }),
            ),
        ).deploy(auth, WORK_ID, {}, res);

        expect(body.unmet).toEqual([
            { code: 'no_green_build', message: 'No green Build to deploy.' },
        ]);
    });

    it('carries advisories through on an ACCEPTED Deployment too', async () => {
        // `primary_domain_missing` does not refuse, and a member who never sees
        // it wonders why their app has no address.
        const body = await new WorkAppDeployController(
            ownership(),
            service(
                result({
                    advisory: [
                        { code: 'primary_domain_missing', message: 'No primary domain yet.' },
                    ] as never,
                }),
            ),
        ).deploy(auth, WORK_ID, {}, response());

        expect(body.advisory).toEqual([
            { code: 'primary_domain_missing', message: 'No primary domain yet.' },
        ]);
    });
});
