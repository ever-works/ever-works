// The barrels the three controllers import pull ESM-only packages (and `better-auth`), exactly as
// in `work-app-runtime.controller.spec.ts` / `work-app-deploy.controller.spec.ts`: every
// collaborator below is a double, so only DI tokens are stubbed.
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));
jest.mock('@ever-works/agent/app-runtime', () => ({
    AppTargetService: class AppTargetService {},
    AppDeployRequestService: class AppDeployRequestService {},
}));
jest.mock('@ever-works/agent/app-dependencies', () => ({
    AppDependenciesService: class AppDependenciesService {},
    AppDependencySpecSourceAdapter: class AppDependencySpecSourceAdapter {},
}));
jest.mock('@ever-works/agent/app-env', () => ({
    isAppEnvEncryptionUnavailableError: () => false,
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class ActivityLogService {},
}));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: { APP_DEPENDENCY: 'app_dependency' },
    ActivityStatus: { COMPLETED: 'completed' },
}));
jest.mock('@ever-works/agent/config', () => ({
    config: { everWorks: { apps: { worksEnabled: jest.fn(() => true) } } },
}));
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import { ForbiddenException, HttpException } from '@nestjs/common';
import { IntegrationHttpException } from '../auth/integration/integration-http.exception';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { WorkAppRuntimeController } from './work-app-runtime.controller';
import { WorkAppDeployController } from './work-app-deploy.controller';
import { WorkAppDependenciesController } from './work-app-dependencies.controller';
import {
    appDataDeleteOwnerOnly,
    appLicenseAttestSessionOnly,
    appTargetChangeRequiresOwner,
    carriesValue,
} from './app-owner-gate';

/**
 * Works-security (2026-10-18) — the App Works actions that need the Work OWNER in a signed-in
 * session, behind `APP_TARGET_CHANGE_REQUIRES_OWNER` and `APP_DATA_DELETE_OWNER_ONLY` (both default
 * on). For every gate: an editor is refused, the owner in a session passes, the owner's own API key
 * is refused, a fleet run (an `api-key` stamp) and an integration key are refused, and the switch
 * off restores the previous behaviour.
 */

const WORK_ID = '00000000-0000-4000-8000-000000000001';
const OWNER = 'owner-1';
const EDITOR = 'editor-1';

const ownerSession = { userId: OWNER, authMethod: 'session' } as AuthenticatedUser;
const ownerKey = { userId: OWNER, authMethod: 'api-key' } as AuthenticatedUser;
const editorSession = { userId: EDITOR, authMethod: 'session' } as AuthenticatedUser;
const editorKey = { userId: EDITOR, authMethod: 'api-key' } as AuthenticatedUser;
// A fleet-run token is stamped `api-key` by `AuthSessionGuard` (it acts AS the owner).
const fleetRun = { userId: OWNER, authMethod: 'api-key' } as AuthenticatedUser;
const integration = {
    userId: OWNER,
    authMethod: 'integration',
    integration: { keyId: 'k-1', scopes: ['works:write'] },
} as unknown as AuthenticatedUser;

const SWITCHES = [
    'APP_TARGET_CHANGE_REQUIRES_OWNER',
    'APP_DATA_DELETE_OWNER_ONLY',
    'APP_LICENSE_ATTEST_SESSION_ONLY',
] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
    for (const name of SWITCHES) saved[name] = process.env[name];
});
afterEach(() => {
    for (const name of SWITCHES) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
    }
});

function ownership() {
    const roleOf = (userId: string) => (userId === OWNER ? 'owner' : 'editor');
    return {
        ensureCanView: jest.fn(async (_id: string, userId: string) => ({
            work: { id: WORK_ID, kind: 'app', slug: 'acme', userId: OWNER },
            role: roleOf(userId),
        })),
        ensureCanEdit: jest.fn(async (_id: string, userId: string) => ({
            work: { id: WORK_ID, kind: 'app', slug: 'acme', userId: OWNER },
            role: roleOf(userId),
        })),
        ensureIsOwner: jest.fn(async (_id: string, userId: string) => {
            if (userId !== OWNER) {
                throw new ForbiddenException({
                    status: 'error',
                    message: 'You do not have the required permission level for this action',
                });
            }
            return { work: { id: WORK_ID, kind: 'app' }, role: 'owner' };
        }),
    };
}

function targets(overrides: Record<string, unknown> = {}) {
    return {
        putTarget: jest.fn(async () => ({ ok: true, body: { target: 'your-cluster' } })),
        check: jest.fn(async () => ({ ok: true, httpStatus: 202, requestId: 'r', dispatched: true })),
        rollback: jest.fn(async () => ({
            ok: true,
            result: { status: 'accepted', httpStatus: 202, unmet: [], advisory: [], warnings: [] },
        })),
        lifecycle: jest.fn(async () => ({
            ok: true,
            httpStatus: 202,
            requestId: 'r',
            dispatched: true,
            action: 'remove',
        })),
        pendingTargetChange: jest.fn(async () => ({ targetChanges: true, namespaceChanges: false })),
        clusterCredentialNeedsOwnerConfirmation: jest.fn(async () => false),
        confirmClusterCredential: jest.fn(async () => true),
        ...overrides,
    };
}

const response = () => ({ status: jest.fn() });

/** The refusal a call ends in: `ownerRequired`, `session`, `integration` — or `allowed`. */
async function outcome(call: () => Promise<unknown>): Promise<string> {
    try {
        await call();
        return 'allowed';
    } catch (error) {
        if (error instanceof IntegrationHttpException) return 'integration';
        if (error instanceof HttpException) {
            const body = error.getResponse() as { code?: string; message?: string } | string;
            if (typeof body === 'object' && body?.code === 'ownerRequired') return 'ownerRequired';
            const message = typeof body === 'string' ? body : String(body?.message ?? '');
            if (message.startsWith('Only a person signed in to Ever Works')) return 'session';
            return `http-${error.getStatus()}`;
        }
        throw error;
    }
}

describe('app-owner-gate switches', () => {
    it('are ON unless exactly false', () => {
        expect(appTargetChangeRequiresOwner({})).toBe(true);
        expect(appDataDeleteOwnerOnly({ APP_DATA_DELETE_OWNER_ONLY: 'no' })).toBe(true);
        expect(appLicenseAttestSessionOnly({ APP_LICENSE_ATTEST_SESSION_ONLY: ' False ' })).toBe(false);
        expect(appTargetChangeRequiresOwner({ APP_TARGET_CHANGE_REQUIRES_OWNER: 'false' })).toBe(false);
    });

    it('carriesValue: absent, null and blank text carry nothing', () => {
        expect(carriesValue(undefined)).toBe(false);
        expect(carriesValue(null)).toBe(false);
        expect(carriesValue('   ')).toBe(false);
        expect(carriesValue('apiVersion: v1')).toBe(true);
        expect(carriesValue({})).toBe(true);
    });
});

describe('POST app-target/check — saving a cluster credential is the owner’s', () => {
    function build() {
        const own = ownership();
        const svc = targets();
        return { controller: new WorkAppRuntimeController(own as never, svc as never), own, svc };
    }

    it.each([
        ['an editor (session)', editorSession, 'ownerRequired'],
        ["an editor's personal key", editorKey, 'ownerRequired'],
        ['the owner in a session', ownerSession, 'allowed'],
        ["the owner's personal key", ownerKey, 'session'],
        ['a fleet run', fleetRun, 'session'],
        ['an integration key', integration, 'integration'],
    ])('with a kubeconfig: %s → %s', async (_who, auth, expected) => {
        const { controller, svc } = build();
        const result = await outcome(() =>
            controller.checkAppTarget(auth, WORK_ID, { kubeconfig: 'apiVersion: v1' }, response()),
        );
        expect(result).toBe(expected);
        if (expected === 'allowed') {
            expect(svc.check).toHaveBeenCalledWith(
                WORK_ID,
                OWNER,
                { kubeconfig: 'apiVersion: v1' },
                { isOwner: true },
            );
        } else {
            expect(svc.check).not.toHaveBeenCalled();
        }
    });

    it('a kube context alone is gated too; a plain re-check stays an editor action', async () => {
        const { controller, svc } = build();
        expect(
            await outcome(() =>
                controller.checkAppTarget(editorSession, WORK_ID, { kubeContext: 'prod' }, response()),
            ),
        ).toBe('ownerRequired');
        expect(
            await outcome(() => controller.checkAppTarget(editorSession, WORK_ID, {}, response())),
        ).toBe('allowed');
        expect(svc.check).toHaveBeenCalledWith(WORK_ID, EDITOR, {}, { isOwner: false });
    });

    it('switch off: an editor may save a kubeconfig again (recorded as not the owner)', async () => {
        process.env.APP_TARGET_CHANGE_REQUIRES_OWNER = 'false';
        const { controller, svc } = build();
        expect(
            await outcome(() =>
                controller.checkAppTarget(editorSession, WORK_ID, { kubeconfig: 'x' }, response()),
            ),
        ).toBe('allowed');
        expect(svc.check).toHaveBeenCalledWith(WORK_ID, EDITOR, { kubeconfig: 'x' }, { isOwner: false });
    });
});

describe('PUT app-target — the target and namespace are the owner’s', () => {
    it('refuses an editor a target or namespace change, allows the owner in a session', async () => {
        const own = ownership();
        const svc = targets();
        const controller = new WorkAppRuntimeController(own as never, svc as never);

        expect(await outcome(() => controller.putAppTarget(editorSession, WORK_ID, { target: 'none' }))).toBe(
            'ownerRequired',
        );
        svc.pendingTargetChange.mockResolvedValueOnce({ targetChanges: false, namespaceChanges: true });
        expect(
            await outcome(() =>
                controller.putAppTarget(editorSession, WORK_ID, {
                    target: 'your-cluster',
                    settings: { namespaceOverride: 'x' },
                }),
            ),
        ).toBe('ownerRequired');
        expect(svc.putTarget).not.toHaveBeenCalled();

        expect(await outcome(() => controller.putAppTarget(ownerKey, WORK_ID, { target: 'none' }))).toBe(
            'session',
        );
        expect(await outcome(() => controller.putAppTarget(integration, WORK_ID, { target: 'none' }))).toBe(
            'integration',
        );
        expect(await outcome(() => controller.putAppTarget(ownerSession, WORK_ID, { target: 'none' }))).toBe(
            'allowed',
        );
    });

    it('other settings stay an editor action, and the switch off restores today', async () => {
        const own = ownership();
        const svc = targets({
            pendingTargetChange: jest.fn(async () => ({ targetChanges: false, namespaceChanges: false })),
        });
        const controller = new WorkAppRuntimeController(own as never, svc as never);
        expect(
            await outcome(() =>
                controller.putAppTarget(editorSession, WORK_ID, {
                    target: 'your-cluster',
                    settings: { tls: 'none' },
                }),
            ),
        ).toBe('allowed');

        process.env.APP_TARGET_CHANGE_REQUIRES_OWNER = 'false';
        const off = targets();
        const offController = new WorkAppRuntimeController(ownership() as never, off as never);
        expect(await outcome(() => offController.putAppTarget(editorSession, WORK_ID, { target: 'none' }))).toBe(
            'allowed',
        );
        expect(off.pendingTargetChange).not.toHaveBeenCalled();
    });
});

describe('POST deploy — confirming a cluster change, or first use of a non-owner credential', () => {
    function build(needsConfirmation = false) {
        const own = ownership();
        const svc = targets({
            clusterCredentialNeedsOwnerConfirmation: jest.fn(async () => needsConfirmation),
        });
        const request = jest.fn(async () => ({
            status: 'accepted',
            httpStatus: 202,
            code: null,
            deploymentId: 'd-1',
            unmet: [],
            advisory: [],
            warnings: [],
        }));
        const controller = new WorkAppDeployController(
            own as never,
            { request } as never,
            undefined,
            undefined,
            svc as never,
        );
        return { controller, svc, request };
    }

    it.each([
        ['an editor', editorSession, 'ownerRequired'],
        ['the owner in a session', ownerSession, 'allowed'],
        ["the owner's personal key", ownerKey, 'session'],
        ['a fleet run', fleetRun, 'session'],
        ['an integration key', integration, 'integration'],
    ])('confirmClusterChange: %s → %s', async (_who, auth, expected) => {
        const { controller, request } = build();
        const result = await outcome(() =>
            controller.deploy(auth, WORK_ID, { confirmClusterChange: true } as never, response()),
        );
        expect(result).toBe(expected);
        expect(request).toHaveBeenCalledTimes(expected === 'allowed' ? 1 : 0);
    });

    it('an ordinary deploy stays an editor action and says whether a person asked', async () => {
        const { controller, request } = build();
        expect(await outcome(() => controller.deploy(editorSession, WORK_ID, {} as never, response()))).toBe(
            'allowed',
        );
        expect(request).toHaveBeenLastCalledWith(
            expect.objectContaining({ userId: EDITOR, requestedByHumanSession: true }),
        );
        await controller.deploy(editorKey, WORK_ID, {} as never, response());
        expect(
            (request.mock.calls.at(-1) as unknown as [Record<string, unknown>])[0]
                .requestedByHumanSession,
        ).toBeUndefined();
    });

    it("the first use of a credential a non-owner saved needs the owner's session, which confirms it", async () => {
        const editorCase = build(true);
        expect(
            await outcome(() => editorCase.controller.deploy(editorSession, WORK_ID, {} as never, response())),
        ).toBe('ownerRequired');
        expect(editorCase.svc.confirmClusterCredential).not.toHaveBeenCalled();
        expect(editorCase.request).not.toHaveBeenCalled();

        const keyCase = build(true);
        expect(
            await outcome(() => keyCase.controller.deploy(ownerKey, WORK_ID, {} as never, response())),
        ).toBe('session');
        expect(keyCase.svc.confirmClusterCredential).not.toHaveBeenCalled();

        const ownerCase = build(true);
        expect(
            await outcome(() => ownerCase.controller.deploy(ownerSession, WORK_ID, {} as never, response())),
        ).toBe('allowed');
        expect(ownerCase.svc.confirmClusterCredential).toHaveBeenCalledWith(WORK_ID, OWNER);
        // Confirmed BEFORE the request, so the preconditions see it.
        expect(ownerCase.svc.confirmClusterCredential.mock.invocationCallOrder[0]).toBeLessThan(
            ownerCase.request.mock.invocationCallOrder[0],
        );
    });

    it('switch off restores today: an editor may confirm a cluster change', async () => {
        process.env.APP_TARGET_CHANGE_REQUIRES_OWNER = 'false';
        const { controller, request, svc } = build(true);
        expect(
            await outcome(() =>
                controller.deploy(editorSession, WORK_ID, { confirmClusterChange: true } as never, response()),
            ),
        ).toBe('allowed');
        expect(request).toHaveBeenCalledWith(expect.objectContaining({ confirmClusterChange: true }));
        expect(svc.clusterCredentialNeedsOwnerConfirmation).not.toHaveBeenCalled();
    });
});

describe('POST app-rollback — the same cluster rule as deploy', () => {
    it('gates confirmClusterChange and an unconfirmed credential; plain rollbacks stay an editor action', async () => {
        const svc = targets();
        const controller = new WorkAppRuntimeController(ownership() as never, svc as never);
        expect(
            await outcome(() =>
                controller.rollbackApp(
                    editorSession,
                    WORK_ID,
                    { deploymentId: 'd-0', confirmClusterChange: true },
                    response(),
                ),
            ),
        ).toBe('ownerRequired');
        expect(
            await outcome(() =>
                controller.rollbackApp(editorSession, WORK_ID, { deploymentId: 'd-0' }, response()),
            ),
        ).toBe('allowed');
        expect(svc.rollback).toHaveBeenLastCalledWith(
            WORK_ID,
            EDITOR,
            { deploymentId: 'd-0' },
            { requestedByHumanSession: true },
        );

        svc.clusterCredentialNeedsOwnerConfirmation.mockResolvedValue(true);
        expect(
            await outcome(() =>
                controller.rollbackApp(editorSession, WORK_ID, { deploymentId: 'd-0' }, response()),
            ),
        ).toBe('ownerRequired');
        expect(
            await outcome(() =>
                controller.rollbackApp(fleetRun, WORK_ID, { deploymentId: 'd-0' }, response()),
            ),
        ).toBe('session');
        expect(
            await outcome(() =>
                controller.rollbackApp(ownerSession, WORK_ID, { deploymentId: 'd-0' }, response()),
            ),
        ).toBe('allowed');
        expect(svc.confirmClusterCredential).toHaveBeenCalledWith(WORK_ID, OWNER);
    });
});

describe('POST app-lifecycle — removing with the data is the owner’s', () => {
    const removeWithData = { action: 'remove', deleteData: true, confirmSlug: 'acme' };

    it.each([
        ['an editor', editorSession, 'ownerRequired'],
        ['the owner in a session', ownerSession, 'allowed'],
        ["the owner's personal key", ownerKey, 'session'],
        ['a fleet run', fleetRun, 'session'],
        ['an integration key', integration, 'integration'],
    ])('remove + deleteData: %s → %s', async (_who, auth, expected) => {
        const svc = targets();
        const controller = new WorkAppRuntimeController(ownership() as never, svc as never);
        expect(await outcome(() => controller.lifecycleApp(auth, WORK_ID, removeWithData, response()))).toBe(
            expected,
        );
        expect(svc.lifecycle).toHaveBeenCalledTimes(expected === 'allowed' ? 1 : 0);
    });

    it('pause, resume, remove-without-data and cancel stay editor actions; switch off restores today', async () => {
        const svc = targets();
        const controller = new WorkAppRuntimeController(ownership() as never, svc as never);
        for (const body of [
            { action: 'pause' },
            { action: 'resume' },
            { action: 'remove' },
            { action: 'remove', deleteData: false },
            { action: 'cancel-deploy' },
        ]) {
            expect(await outcome(() => controller.lifecycleApp(editorSession, WORK_ID, body, response()))).toBe(
                'allowed',
            );
        }
        process.env.APP_DATA_DELETE_OWNER_ONLY = 'false';
        expect(
            await outcome(() => controller.lifecycleApp(editorSession, WORK_ID, removeWithData, response())),
        ).toBe('allowed');
    });
});

describe('DELETE app-dependencies/:kind — Delete data is the owner’s', () => {
    function build() {
        const own = ownership();
        const dependencies = {
            list: jest.fn(async () => []),
            requestDataDeletion: jest.fn(async () => null),
        };
        const controller = new WorkAppDependenciesController(own as never, dependencies as never);
        return { controller, dependencies };
    }

    it.each([
        ['an editor', editorSession, 'ownerRequired'],
        ['the owner in a session', ownerSession, 'allowed'],
        ["the owner's personal key", ownerKey, 'session'],
        ['a fleet run', fleetRun, 'session'],
        ['an integration key', integration, 'integration'],
    ])('%s → %s', async (_who, auth, expected) => {
        const { controller, dependencies } = build();
        expect(
            await outcome(() =>
                controller.deleteData(auth, WORK_ID, 'postgres', { confirmSlug: 'acme' }, response()),
            ),
        ).toBe(expected);
        expect(dependencies.requestDataDeletion).toHaveBeenCalledTimes(expected === 'allowed' ? 1 : 0);
    });

    it('the list tells the card who may delete data, and the switch off restores today', async () => {
        const { controller } = build();
        await expect(controller.list(editorSession, WORK_ID)).resolves.toMatchObject({
            canEdit: true,
            canDeleteData: false,
        });
        await expect(controller.list(ownerSession, WORK_ID)).resolves.toMatchObject({
            canDeleteData: true,
        });

        process.env.APP_DATA_DELETE_OWNER_ONLY = 'false';
        await expect(controller.list(editorSession, WORK_ID)).resolves.toMatchObject({
            canDeleteData: true,
        });
        const off = build();
        expect(
            await outcome(() =>
                off.controller.deleteData(editorSession, WORK_ID, 'postgres', { confirmSlug: 'acme' }, response()),
            ),
        ).toBe('allowed');
    });
});
