// The services barrel is large; this suite only needs the class as a DI token.
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));
// The App env barrel: the service token and the two refusal guards the controller maps.
jest.mock('@ever-works/agent/app-env', () => ({
    AppEnvEditorService: class AppEnvEditorService {},
    isAppEnvEditorRefusal: (value: { name?: string }) => value?.name === 'AppEnvEditorRefusal',
    isAppEnvRefusalError: (value: { name?: string }) => value?.name === 'AppEnvRefusalError',
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
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import { config } from '@ever-works/agent/config';
import type { AppEnvEditorService } from '@ever-works/agent/app-env';
import type { WorkOwnershipService } from '@ever-works/agent/services';

import { WorkAppEnvController } from './work-app-env.controller';

/**
 * APW-07 T24 (lane aw-env-smtp) — `GET`/`PUT /api/works/:id/app-env`.
 *
 * The controller decides who may ask, what it passes on and which status answers; the merge patch
 * and the write are `AppEnvEditorService` / `AppEnvService`'s and have their own specs.
 */

const WORK_ID = '5a07fa3f-367a-444e-9d1e-311d03cc1327';
const USER = { userId: '22222222-2222-4222-8222-222222222222' } as never;

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

function editor(overrides: Partial<Record<'describe' | 'patch', jest.Mock>> = {}) {
    return {
        describe: jest.fn(async (workId: string, viewer: { canEdit: boolean }) => ({
            workId,
            secureStorage: true,
            canEdit: viewer.canEdit,
            summary: { total: 0, set: 0, missingRequired: 0, missingRequiredBuild: 0 },
            entries: [],
        })),
        patch: jest.fn(async (workId: string) => ({
            workId,
            changed: ['FIXTURE_MARKER'],
            results: [],
            warnings: [],
            activityRecorded: true,
            entries: [],
        })),
        ...overrides,
    } as unknown as AppEnvEditorService & { describe: jest.Mock; patch: jest.Mock };
}

async function statusOf(
    promise: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof HttpException) {
            return {
                status: error.getStatus(),
                body: error.getResponse() as Record<string, unknown>,
            };
        }
        throw error;
    }
    throw new Error('expected a refusal');
}

describe('WorkAppEnvController', () => {
    beforeEach(() => worksEnabled.mockReturnValue(true));

    it('serves GET and PUT at :id/app-env', () => {
        const list = WorkAppEnvController.prototype.list;
        const patch = WorkAppEnvController.prototype.patch;
        expect(Reflect.getMetadata(PATH_METADATA, list)).toBe(':id/app-env');
        expect(Reflect.getMetadata(METHOD_METADATA, list)).toBe(RequestMethod.GET);
        expect(Reflect.getMetadata(PATH_METADATA, patch)).toBe(':id/app-env');
        expect(Reflect.getMetadata(METHOD_METADATA, patch)).toBe(RequestMethod.PUT);
    });

    it('GET answers the table with the caller’s own edit access', async () => {
        const service = editor();
        const owner = new WorkAppEnvController(ownership('owner'), service);
        await expect(owner.list(USER, WORK_ID)).resolves.toMatchObject({
            workId: WORK_ID,
            canEdit: true,
        });

        const viewer = new WorkAppEnvController(ownership('viewer'), service);
        await expect(viewer.list(USER, WORK_ID)).resolves.toMatchObject({ canEdit: false });
    });

    it('answers 404 for a missing, foreign or non-App Work, and when App Works is off', async () => {
        for (const role of ['missing', 'foreign'] as const) {
            const answer = await statusOf(
                new WorkAppEnvController(ownership(role), editor()).list(USER, WORK_ID),
            );
            expect(answer.status).toBe(HttpStatus.NOT_FOUND);
            expect(answer.body.code).toBe('notAppWork');
        }
        const website = await statusOf(
            new WorkAppEnvController(ownership('owner', 'website'), editor()).list(USER, WORK_ID),
        );
        expect(website).toMatchObject({ status: 404, body: { code: 'notAppWork' } });

        worksEnabled.mockReturnValue(false);
        const off = await statusOf(
            new WorkAppEnvController(ownership('owner'), editor()).list(USER, WORK_ID),
        );
        expect(off).toMatchObject({ status: 404, body: { code: 'appWorksDisabled' } });
    });

    it('PUT needs edit access (403 for a viewer) and passes the body through as the caller', async () => {
        const service = editor();
        const viewer = await statusOf(
            new WorkAppEnvController(ownership('viewer'), service).patch(USER, WORK_ID, {
                values: {},
            }),
        );
        expect(viewer).toMatchObject({ status: 403, body: { code: 'editAccessRequired' } });
        expect(service.patch).not.toHaveBeenCalled();

        const body = { values: { FIXTURE_MARKER: 'run-1', FIXTURE_MAIL_TO: null } };
        await new WorkAppEnvController(ownership('owner'), service).patch(USER, WORK_ID, body);
        expect(service.patch).toHaveBeenCalledWith(
            WORK_ID,
            { userId: '22222222-2222-4222-8222-222222222222', canEdit: true },
            body,
        );
    });

    it('maps the editor’s whole-request refusals, with the undeclared names', async () => {
        const refusal = Object.assign(new Error('The App spec does not declare NOPE.'), {
            name: 'AppEnvEditorRefusal',
            code: 'undeclaredName',
            status: 400,
            names: ['NOPE'],
        });
        const service = editor({ patch: jest.fn().mockRejectedValue(refusal) });
        const answer = await statusOf(
            new WorkAppEnvController(ownership('owner'), service).patch(USER, WORK_ID, {
                values: { NOPE: 'x' },
            }),
        );
        expect(answer).toEqual({
            status: 400,
            body: {
                status: 'error',
                code: 'undeclaredName',
                message: 'The App spec does not declare NOPE.',
                names: ['NOPE'],
            },
        });
    });

    it('maps the 503 secureStorageUnavailable refusal of the write', async () => {
        const refusal = Object.assign(
            new Error("Secure storage isn't configured on this installation."),
            {
                name: 'AppEnvRefusalError',
                code: 'secureStorageUnavailable',
                status: 503,
            },
        );
        const service = editor({ patch: jest.fn().mockRejectedValue(refusal) });
        const answer = await statusOf(
            new WorkAppEnvController(ownership('owner'), service).patch(USER, WORK_ID, {
                values: { A: 'x' },
            }),
        );
        expect(answer).toMatchObject({ status: 503, body: { code: 'secureStorageUnavailable' } });
    });
});
