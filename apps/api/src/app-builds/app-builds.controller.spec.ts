// The services barrel is large; this suite only needs the class as a DI token,
// and every case supplies a double — the same shell the deploy controller spec uses.
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));
// The Builds barrel: DI tokens plus the one pure mapper the controller calls.
jest.mock('@ever-works/agent/app-builds', () => ({
    AppBuildsService: class AppBuildsService {},
    AppBuildPullTokenService: class AppBuildPullTokenService {},
    toAppBuildSummary: (build: { id: string; number: number; status: string }) => ({
        id: build.id,
        number: build.number,
        status: build.status,
    }),
}));
jest.mock('@ever-works/agent/config', () => ({
    config: { everWorks: { apps: { worksEnabled: jest.fn(() => true) } } },
}));
// The auth barrel pulls `better-auth` (ESM); nothing here drives a router.
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import { ForbiddenException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { config } from '@ever-works/agent/config';
import type { AppBuildPullTokenService, AppBuildsService } from '@ever-works/agent/app-builds';
import type { WorkOwnershipService } from '@ever-works/agent/services';

import { AppBuildsController } from './app-builds.controller';

/**
 * APW-05 T23 — the Builds routes (plan §5).
 *
 * The controller decides who may ask, what it passes on and which status
 * answers; the dedupe, the limits and the pull-token checks are the services'
 * and have their own specs. ACC-05-08 (dedupe), ACC-05-09 (cancel), ACC-05-21
 * (no token in any response) and ACC-05-24 (foreign ids 404, viewers 403).
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const BUILD_ID = '33333333-3333-4333-8333-333333333333';
const USER = { userId: '22222222-2222-4222-8222-222222222222' } as never;
const SECRET_TOKEN = 'ghp_thisMustNeverComeBack0000000000000';

const worksEnabled = (config as unknown as { everWorks: { apps: { worksEnabled: jest.Mock } } })
    .everWorks.apps.worksEnabled;

type Role = 'owner' | 'viewer' | 'foreign' | 'missing';

function ownership(role: Role, kind = 'app'): WorkOwnershipService {
    const access = { work: { id: WORK_ID, kind }, isCreator: role === 'owner' };
    return {
        ensureCanView: jest.fn(async () => {
            if (role === 'missing') throw new NotFoundException('Work not found');
            if (role === 'foreign') throw new ForbiddenException('No access');
            return access;
        }),
        ensureCanEdit: jest.fn(async () => {
            if (role === 'missing') throw new NotFoundException('Work not found');
            if (role !== 'owner') throw new ForbiddenException('Edit access required');
            return access;
        }),
    } as unknown as WorkOwnershipService;
}

function buildsService(overrides: Partial<Record<keyof AppBuildsService, jest.Mock>> = {}) {
    return {
        listForWork: jest.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })),
        getDetail: jest.fn(async () => ({ id: BUILD_ID, canEdit: true })),
        requestRebuild: jest.fn(async () => ({
            ok: true,
            build: { id: BUILD_ID, number: 4, status: 'queued' },
            deduped: false,
        })),
        cancel: jest.fn(async () => ({
            ok: true,
            build: { id: BUILD_ID, number: 4, status: 'cancelled' },
        })),
        ...overrides,
    } as unknown as AppBuildsService & Record<string, jest.Mock>;
}

function pullTokenService(overrides: Partial<Record<string, jest.Mock>> = {}) {
    return {
        save: jest.fn(async () => ({
            ok: true,
            pullAccess: { visibility: 'private', tokenSet: true, tokenExpiresAt: null },
            buildId: BUILD_ID,
            imageDigest: `sha256:${'a'.repeat(64)}`,
            expiresInDays: null,
        })),
        warningDaysUntilExpiry: jest.fn(() => null),
        ...overrides,
    } as unknown as AppBuildPullTokenService & Record<string, jest.Mock>;
}

function controller(
    role: Role = 'owner',
    options: {
        kind?: string;
        builds?: ReturnType<typeof buildsService>;
        pullTokens?: ReturnType<typeof pullTokenService>;
    } = {},
) {
    const builds = options.builds ?? buildsService();
    const pullTokens = options.pullTokens ?? pullTokenService();
    return {
        subject: new AppBuildsController(ownership(role, options.kind), builds, pullTokens),
        builds,
        pullTokens,
    };
}

/** The status and body an HttpException carries. */
async function refusalOf(promise: Promise<unknown>): Promise<{ status: number; body: any }> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        const http = error as HttpException;
        return { status: http.getStatus(), body: http.getResponse() };
    }
    throw new Error('expected the call to be refused');
}

beforeEach(() => {
    worksEnabled.mockReturnValue(true);
});

describe('AppBuildsController — access (ACC-05-24)', () => {
    for (const role of ['foreign', 'missing'] as const) {
        it(`a ${role} Work answers 404 on read, Rebuild and Cancel — one answer for all`, async () => {
            const { subject, builds } = controller(role);
            for (const call of [
                subject.list(USER, WORK_ID, {}),
                subject.detail(USER, WORK_ID, BUILD_ID),
                subject.request(USER, WORK_ID, {}),
                subject.cancel(USER, WORK_ID, BUILD_ID),
                subject.savePullToken(USER, WORK_ID, { token: SECRET_TOKEN }),
            ]) {
                const { status, body } = await refusalOf(call);
                expect(status).toBe(HttpStatus.NOT_FOUND);
                expect(body.code).toBe('notAppWork');
            }
            expect(builds.listForWork).not.toHaveBeenCalled();
            expect(builds.requestRebuild).not.toHaveBeenCalled();
            expect(builds.cancel).not.toHaveBeenCalled();
        });
    }

    it('a visible Work of another kind is 404 notAppWork', async () => {
        const { subject } = controller('owner', { kind: 'directory' });
        const { status, body } = await refusalOf(subject.list(USER, WORK_ID, {}));
        expect(status).toBe(HttpStatus.NOT_FOUND);
        expect(body.code).toBe('notAppWork');
    });

    it('a viewer reads, but is 403 editAccessRequired on Rebuild, Cancel and the pull token', async () => {
        const { subject, builds, pullTokens } = controller('viewer');
        await expect(subject.list(USER, WORK_ID, {})).resolves.toBeDefined();
        await expect(subject.detail(USER, WORK_ID, BUILD_ID)).resolves.toBeDefined();

        for (const call of [
            subject.request(USER, WORK_ID, {}),
            subject.cancel(USER, WORK_ID, BUILD_ID),
            subject.savePullToken(USER, WORK_ID, { token: SECRET_TOKEN }),
        ]) {
            const { status, body } = await refusalOf(call);
            expect(status).toBe(HttpStatus.FORBIDDEN);
            expect(body.code).toBe('editAccessRequired');
        }
        expect(builds.requestRebuild).not.toHaveBeenCalled();
        expect(builds.cancel).not.toHaveBeenCalled();
        expect(pullTokens.save).not.toHaveBeenCalled();
    });

    it('with App Works switched off every route is 404 appWorksDisabled before any ownership read', async () => {
        worksEnabled.mockReturnValue(false);
        const { subject, builds } = controller('owner');
        const { status, body } = await refusalOf(subject.list(USER, WORK_ID, {}));
        expect(status).toBe(HttpStatus.NOT_FOUND);
        expect(body.code).toBe('appWorksDisabled');
        expect(builds.listForWork).not.toHaveBeenCalled();
    });

    it('a Build of another Work (service answers null) is 404 buildNotFound', async () => {
        const builds = buildsService({ getDetail: jest.fn(async () => null) });
        const { subject } = controller('owner', { builds });
        const { status, body } = await refusalOf(subject.detail(USER, WORK_ID, BUILD_ID));
        expect(status).toBe(HttpStatus.NOT_FOUND);
        expect(body.code).toBe('buildNotFound');
    });
});

describe('AppBuildsController — list and detail', () => {
    it('passes the caller and the parsed filters to the service', async () => {
        const { subject, builds } = controller('owner');
        await subject.list(USER, WORK_ID, {
            page: 2,
            pageSize: 50,
            status: 'running,queued',
            trigger: 'push',
            branch: 'main',
            pullRequest: 7,
        });
        expect(builds.listForWork).toHaveBeenCalledWith(
            WORK_ID,
            {
                page: 2,
                pageSize: 50,
                status: ['running', 'queued'],
                trigger: ['push'],
                branch: 'main',
                pullRequest: 7,
            },
            (USER as { userId: string }).userId,
        );
    });

    it('the detail is read with the caller, so canEdit is the caller’s', async () => {
        const { subject, builds } = controller('owner');
        await subject.detail(USER, WORK_ID, BUILD_ID);
        expect(builds.getDetail).toHaveBeenCalledWith(
            WORK_ID,
            BUILD_ID,
            (USER as { userId: string }).userId,
        );
    });
});

describe('AppBuildsController — Rebuild (ACC-05-08)', () => {
    it('answers { build, deduped } and passes a lower-cased commitSha', async () => {
        const { subject, builds } = controller('owner');
        const answer = await subject.request(USER, WORK_ID, { commitSha: 'A'.repeat(40) });
        expect(answer).toEqual({
            build: { id: BUILD_ID, number: 4, status: 'queued' },
            deduped: false,
        });
        expect(builds.requestRebuild).toHaveBeenCalledWith(
            WORK_ID,
            (USER as { userId: string }).userId,
            { commitSha: 'a'.repeat(40) },
        );
    });

    it('a second request inside the dedupe window answers the same Build with deduped: true', async () => {
        const builds = buildsService({
            requestRebuild: jest.fn(async () => ({
                ok: true,
                build: { id: BUILD_ID, number: 4, status: 'queued' },
                deduped: true,
            })),
        });
        const { subject } = controller('owner', { builds });
        const answer = await subject.request(USER, WORK_ID, {});
        expect(answer.deduped).toBe(true);
        expect(answer.build.id).toBe(BUILD_ID);
    });

    it('429 rebuildRateLimited carries retryAfterMinutes', async () => {
        const builds = buildsService({
            requestRebuild: jest.fn(async () => ({
                ok: false,
                code: 'rebuildRateLimited',
                retryAfterMinutes: 17,
            })),
        });
        const { status, body } = await refusalOf(
            controller('owner', { builds }).subject.request(USER, WORK_ID, {}),
        );
        expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);
        expect(body).toMatchObject({ code: 'rebuildRateLimited', retryAfterMinutes: 17 });
    });

    it.each([
        ['nothingToBuild', HttpStatus.UNPROCESSABLE_ENTITY],
        ['commitNotReachable', HttpStatus.UNPROCESSABLE_ENTITY],
        // Live e2e 2026-10-18 — no App spec on the tracked branch yet.
        ['specMissing', HttpStatus.UNPROCESSABLE_ENTITY],
        ['buildProviderUnavailable', HttpStatus.SERVICE_UNAVAILABLE],
    ])('%s answers %d', async (code, expected) => {
        const builds = buildsService({
            requestRebuild: jest.fn(async () => ({ ok: false, code })),
        });
        const { status, body } = await refusalOf(
            controller('owner', { builds }).subject.request(USER, WORK_ID, {}),
        );
        expect(status).toBe(expected);
        expect(body.code).toBe(code);
    });
});

describe('AppBuildsController — Cancel (ACC-05-09)', () => {
    it('answers { build } for a running Build', async () => {
        const answer = await controller('owner').subject.cancel(USER, WORK_ID, BUILD_ID);
        expect(answer).toEqual({ build: { id: BUILD_ID, number: 4, status: 'cancelled' } });
    });

    it('409 notCancellable for a terminal or blocked Build', async () => {
        const builds = buildsService({
            cancel: jest.fn(async () => ({ ok: false, code: 'notCancellable' })),
        });
        const { status, body } = await refusalOf(
            controller('owner', { builds }).subject.cancel(USER, WORK_ID, BUILD_ID),
        );
        expect(status).toBe(HttpStatus.CONFLICT);
        expect(body.code).toBe('notCancellable');
    });

    it('404 buildNotFound for an id the Work does not own', async () => {
        const builds = buildsService({
            cancel: jest.fn(async () => ({ ok: false, code: 'buildNotFound' })),
        });
        const { status, body } = await refusalOf(
            controller('owner', { builds }).subject.cancel(USER, WORK_ID, BUILD_ID),
        );
        expect(status).toBe(HttpStatus.NOT_FOUND);
        expect(body.code).toBe('buildNotFound');
    });
});

describe('AppBuildsController — pull token (ACC-05-21)', () => {
    it('answers the pull access facts and never the token', async () => {
        const { subject, pullTokens } = controller('owner');
        const answer = await subject.savePullToken(USER, WORK_ID, { token: SECRET_TOKEN });
        expect(answer).toEqual({
            pullAccess: { visibility: 'private', tokenSet: true, tokenExpiresAt: null },
            expiresInDays: null,
        });
        expect(JSON.stringify(answer)).not.toContain(SECRET_TOKEN);
        expect(pullTokens.save).toHaveBeenCalledWith(
            WORK_ID,
            (USER as { userId: string }).userId,
            SECRET_TOKEN,
        );
    });

    it.each([
        ['pullTokenTooBroad', 422],
        ['pullTokenFineGrained', 422],
        ['pullTokenCannotRead', 422],
        ['pullTokenPublicImage', 422],
        ['pullTokenNoImageYet', 409],
        ['pullTokenUnavailable', 503],
    ])('a %s refusal answers %d with its code and no token', async (code, httpStatus) => {
        const pullTokens = pullTokenService({
            save: jest.fn(async () => ({ ok: false, status: httpStatus, code })),
        });
        const { status, body } = await refusalOf(
            controller('owner', { pullTokens }).subject.savePullToken(USER, WORK_ID, {
                token: SECRET_TOKEN,
            }),
        );
        expect(status).toBe(httpStatus);
        expect(body.code).toBe(code);
        expect(JSON.stringify(body)).not.toContain(SECRET_TOKEN);
    });
});
