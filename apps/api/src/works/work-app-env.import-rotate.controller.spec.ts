// The same stubs `work-app-env.controller.spec.ts` uses, for the same reasons.
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));
jest.mock('@ever-works/agent/app-env', () => ({
    AppEnvEditorService: class AppEnvEditorService {},
    isAppEnvEditorRefusal: (value: { name?: string }) => value?.name === 'AppEnvEditorRefusal',
    isAppEnvRefusalError: (value: { name?: string }) => value?.name === 'AppEnvRefusalError',
}));
jest.mock('@ever-works/agent/config', () => ({
    config: { everWorks: { apps: { worksEnabled: jest.fn(() => true) } } },
}));
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import { ForbiddenException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import type { AppEnvEditorService } from '@ever-works/agent/app-env';
import type { WorkOwnershipService } from '@ever-works/agent/services';

import { WorkAppEnvController } from './work-app-env.controller';

/**
 * Lane aw-ops (APW-07 T24/T28) — `POST app-env/import-preview` and `POST app-env/:name/rotate`.
 *
 * Pinned: both need EDIT (a viewer is 403 `editAccessRequired`, a stranger the 404 every App env
 * route answers) before the editor is reached; both answer 200; an editor or service refusal keeps
 * its status, code and names; and the paths are the ones the web client calls.
 */

const WORK_ID = '5a07fa3f-367a-444e-9d1e-311d03cc1327';
const USER = { userId: '22222222-2222-4222-8222-222222222222' } as never;

function ownership(role: 'owner' | 'viewer' | 'foreign'): WorkOwnershipService {
    const access = { work: { id: WORK_ID, kind: 'app' }, isCreator: role === 'owner' };
    return {
        ensureCanView: jest.fn(async () => {
            if (role === 'foreign') throw new ForbiddenException('No access');
            return access;
        }),
        ensureCanEdit: jest.fn(async () => {
            if (role !== 'owner') throw new ForbiddenException('Edit access required');
            return access;
        }),
    } as unknown as WorkOwnershipService;
}

function editor() {
    return {
        previewImport: jest.fn(async () => ({
            workId: WORK_ID,
            lines: [{ line: 1, name: 'A', action: 'add', code: null, message: null }],
            changes: { add: ['A'], replace: [], remove: [] },
            refused: 0,
            limits: null,
            undeclared: [],
        })),
        rotate: jest.fn(async () => ({ workId: WORK_ID, name: 'SESSION', version: 3, entries: [] })),
    };
}

async function statusOf(call: () => Promise<unknown>) {
    try {
        await call();
        return { status: 200, body: null as unknown };
    } catch (error) {
        const http = error as HttpException;
        return { status: http.getStatus(), body: http.getResponse() };
    }
}

describe('WorkAppEnvController — import preview and rotate (lane aw-ops)', () => {
    it('serves POST :id/app-env/import-preview and POST :id/app-env/:name/rotate', () => {
        const proto = WorkAppEnvController.prototype as unknown as Record<string, () => unknown>;
        expect(Reflect.getMetadata(PATH_METADATA, proto.previewImport)).toBe(':id/app-env/import-preview');
        expect(Reflect.getMetadata(METHOD_METADATA, proto.previewImport)).toBe(RequestMethod.POST);
        expect(Reflect.getMetadata(PATH_METADATA, proto.rotate)).toBe(':id/app-env/:name/rotate');
        expect(Reflect.getMetadata(METHOD_METADATA, proto.rotate)).toBe(RequestMethod.POST);
    });

    it('previews for an editor and passes the body through untouched', async () => {
        const e = editor();
        const controller = new WorkAppEnvController(ownership('owner'), e as unknown as AppEnvEditorService);
        const body = { import: { dotenv: 'A=1' } };
        await expect(controller.previewImport(USER, WORK_ID, body)).resolves.toMatchObject({
            changes: { add: ['A'] },
        });
        expect(e.previewImport).toHaveBeenCalledWith(WORK_ID, { userId: expect.any(String), canEdit: true }, body);
    });

    it('rotates for an editor with the name from the path', async () => {
        const e = editor();
        const controller = new WorkAppEnvController(ownership('owner'), e as unknown as AppEnvEditorService);
        await expect(controller.rotate(USER, WORK_ID, 'SESSION', { confirmName: 'SESSION' })).resolves.toEqual({
            workId: WORK_ID,
            name: 'SESSION',
            version: 3,
            entries: [],
        });
        expect(e.rotate).toHaveBeenCalledWith(
            WORK_ID,
            { userId: expect.any(String), canEdit: true },
            'SESSION',
            { confirmName: 'SESSION' },
        );
    });

    it('refuses a viewer 403 and a stranger 404 before the editor is reached', async () => {
        for (const [role, status] of [
            ['viewer', HttpStatus.FORBIDDEN],
            ['foreign', HttpStatus.NOT_FOUND],
        ] as const) {
            const e = editor();
            const controller = new WorkAppEnvController(ownership(role), e as unknown as AppEnvEditorService);
            expect((await statusOf(() => controller.previewImport(USER, WORK_ID, {}))).status).toBe(status);
            expect((await statusOf(() => controller.rotate(USER, WORK_ID, 'SESSION', {}))).status).toBe(status);
            expect(e.previewImport).not.toHaveBeenCalled();
            expect(e.rotate).not.toHaveBeenCalled();
        }
    });

    it('keeps an editor refusal’s status, code and names, and a service refusal’s status and code', async () => {
        const e = editor();
        e.previewImport.mockRejectedValueOnce(
            Object.assign(new Error('undeclared'), {
                name: 'AppEnvEditorRefusal',
                code: 'undeclaredName',
                status: 400,
                names: ['TYPO'],
            }),
        );
        e.rotate.mockRejectedValueOnce(
            Object.assign(new Error('mismatch'), {
                name: 'AppEnvRefusalError',
                code: 'rotateConfirmationMismatch',
                status: 422,
            }),
        );
        const controller = new WorkAppEnvController(ownership('owner'), e as unknown as AppEnvEditorService);

        await expect(statusOf(() => controller.previewImport(USER, WORK_ID, {}))).resolves.toEqual({
            status: 400,
            body: { status: 'error', code: 'undeclaredName', message: 'undeclared', names: ['TYPO'] },
        });
        await expect(statusOf(() => controller.rotate(USER, WORK_ID, 'SESSION', { confirmName: 'X' }))).resolves.toEqual(
            { status: 422, body: { status: 'error', code: 'rotateConfirmationMismatch', message: 'mismatch' } },
        );
    });

    it('lets an unexpected error through untouched', async () => {
        const e = editor();
        const boom = new Error('db down');
        e.rotate.mockRejectedValueOnce(boom);
        const controller = new WorkAppEnvController(ownership('owner'), e as unknown as AppEnvEditorService);
        await expect(controller.rotate(USER, WORK_ID, 'SESSION', { confirmName: 'SESSION' })).rejects.toBe(boom);
        void NotFoundException;
    });
});
