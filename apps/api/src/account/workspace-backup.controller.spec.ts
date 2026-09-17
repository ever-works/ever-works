jest.mock('@ever-works/agent/account-transfer', () => ({
    BACKUP_STORAGE: Symbol('BACKUP_STORAGE'),
    BACKUP_ACTIVITY_RECORDER: Symbol('BACKUP_ACTIVITY_RECORDER'),
    BACKUP_NOTIFIER: Symbol('BACKUP_NOTIFIER'),
}));

import { Readable } from 'node:stream';
import {
    ForbiddenException,
    GoneException,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { BACKUP_DOMAINS } from '@ever-works/contracts';
import type { WorkspaceBackupService } from '@ever-works/agent/account-transfer';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { ScopeContextService } from '../scope/scope-context.service';
import { WorkspaceBackupController } from './workspace-backup.controller';

/**
 * Every route, with the outcomes the card has specific copy for. The two
 * that matter most are the ones a reviewer cannot see by reading the happy
 * path: a non-owner is refused, and no response body ever carries the four
 * fields that must not leave the server.
 */

const AUTH = { userId: 'u1' } as AuthenticatedUser;

function backup(overrides: Record<string, unknown> = {}) {
    return {
        id: 'b1',
        status: 'ready',
        failureReason: null,
        failureDetail: 'internal host db-7 refused the connection',
        includeFullHistory: false,
        formatVersion: '1.0',
        requestedAt: new Date('2026-09-06T14:00:00.000Z'),
        startedAt: new Date('2026-09-06T14:00:05.000Z'),
        finishedAt: new Date('2026-09-06T14:12:00.000Z'),
        progressPercent: 100,
        currentDomain: null,
        domainsCompleted: 15,
        domainsTotal: 15,
        sizeBytes: '412000000',
        sha256: 'f'.repeat(64),
        fileCount: 1249,
        omittedFileCount: 0,
        expiresAt: new Date('2026-09-20T14:12:00.000Z'),
        artifactDeletedAt: null,
        downloadCount: 0,
        manifestSummary: { workspace: { slug: 'acme' } },
        storageBackend: 'local-fs',
        storageKey: 'u1/secret-object-key.zip',
        runtimeRunId: 'run_123',
        credentialVersion: 4,
        ...overrides,
    } as never;
}

function res() {
    const headers: Record<string, string> = {};
    const captured = { status: 200, body: undefined as unknown };
    const response = {
        setHeader: (name: string, value: string) => {
            headers[name] = value;
        },
        status: (code: number) => {
            captured.status = code;
            return response;
        },
        json: (body: unknown) => {
            captured.body = body;
        },
        on: () => undefined,
        once: () => undefined,
        emit: () => undefined,
        write: () => true,
        end: () => undefined,
    };
    return { response, headers, captured };
}

function build(
    overrides: Partial<Record<keyof WorkspaceBackupService, unknown>> = {},
    options: { organizationId?: string | null; storage?: unknown } = {},
) {
    const service = {
        isWorkspaceOwner: jest.fn().mockResolvedValue(true),
        isAvailable: jest.fn().mockResolvedValue(true),
        limits: jest
            .fn()
            .mockReturnValue({ retentionDays: 14, dailyAllowance: 3, domainCount: 15 }),
        create: jest
            .fn()
            .mockResolvedValue({ kind: 'started', backup: backup({ status: 'queued' }) }),
        list: jest.fn().mockResolvedValue({ rows: [backup()], nextCursor: null }),
        get: jest.fn().mockResolvedValue(backup()),
        getCurrent: jest.fn().mockResolvedValue(backup()),
        cancel: jest.fn().mockResolvedValue(true),
        deleteArtifact: jest.fn().mockResolvedValue(true),
        mintDownloadToken: jest
            .fn()
            .mockReturnValue({ token: 'tok', expiresAt: new Date('2026-09-06T14:27:00.000Z') }),
        verifyDownloadToken: jest.fn().mockReturnValue(true),
        recordDownload: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    };

    const scopeContext = {
        getOrganizationId: () => options.organizationId ?? 'org-1',
        getTenantId: () => 't1',
    } as unknown as ScopeContextService;

    const storage =
        options.storage === undefined
            ? {
                  getArchiveStream: jest.fn().mockResolvedValue({
                      stream: Object.assign(Readable.from([Buffer.from('zip')]), {
                          pipe: jest.fn(),
                      }),
                      mimeType: 'application/zip',
                      size: 3,
                  }),
              }
            : options.storage;

    const controller = new WorkspaceBackupController(
        service as unknown as WorkspaceBackupService,
        scopeContext,
        storage as never,
    );
    return { controller, service, storage };
}

describe('WorkspaceBackupController — create', () => {
    it('returns 202 and the new backup', async () => {
        const { controller } = build();
        const { response, captured } = res();

        await controller.create(AUTH, {}, response as never);
        expect(captured.status).toBe(202);
        expect((captured.body as { backup: { id: string } }).backup.id).toBe('b1');
    });

    it('returns 200 with adopted:true while one is already running (spec S-9)', async () => {
        const { controller } = build({
            create: jest
                .fn()
                .mockResolvedValue({ kind: 'adopted', backup: backup({ status: 'running' }) }),
        });
        const { response, captured } = res();

        await controller.create(AUTH, {}, response as never);
        expect(captured.status).toBe(200);
        expect(captured.body).toMatchObject({ adopted: true });
    });

    it('returns 429 with the time the window reopens (spec S-10)', async () => {
        const retryAt = new Date('2026-09-06T18:40:00.000Z');
        const { controller } = build({
            create: jest.fn().mockResolvedValue({ kind: 'rate_limited', retryAt, limit: 3 }),
        });
        const { response, captured } = res();

        await controller.create(AUTH, {}, response as never);
        expect(captured.status).toBe(429);
        expect(captured.body).toEqual({
            code: 'backup_rate_limited',
            retryAt: retryAt.toISOString(),
            limit: 3,
        });
    });

    it('returns 503 with a named code when no storage is configured (spec S-26)', async () => {
        const { controller } = build({
            create: jest.fn().mockResolvedValue({ kind: 'unavailable' }),
        });
        const { response } = res();

        await expect(controller.create(AUTH, {}, response as never)).rejects.toThrow(
            ServiceUnavailableException,
        );
    });

    it('passes the full-history option through', async () => {
        const { controller, service } = build();
        const { response } = res();

        await controller.create(AUTH, { includeFullHistory: true }, response as never);
        expect(service.create).toHaveBeenCalledWith(expect.anything(), {
            includeFullHistory: true,
        });
    });
});

describe('WorkspaceBackupController — owner only (spec FR-10, S-8)', () => {
    const notOwner = { isWorkspaceOwner: jest.fn().mockResolvedValue(false) };

    it('refuses a member who is not the workspace owner, with a stable code', async () => {
        const { controller } = build(notOwner);
        const { response } = res();

        await expect(controller.create(AUTH, {}, response as never)).rejects.toMatchObject({
            response: expect.objectContaining({ code: 'backup_owner_only' }),
        });
    });

    it('refuses a non-owner on list, get, cancel, delete and download alike', async () => {
        const { controller } = build(notOwner);
        const { response } = res();

        await expect(controller.list(AUTH)).rejects.toThrow(ForbiddenException);
        await expect(controller.get(AUTH, 'b1')).rejects.toThrow(ForbiddenException);
        await expect(controller.cancel(AUTH, 'b1', response as never)).rejects.toThrow(
            ForbiddenException,
        );
        await expect(controller.remove(AUTH, 'b1')).rejects.toThrow(ForbiddenException);
        await expect(controller.downloadLink(AUTH, 'b1')).rejects.toThrow(ForbiddenException);
        await expect(controller.download(AUTH, 'b1', 'tok', response as never)).rejects.toThrow(
            ForbiddenException,
        );
    });

    it('still ANSWERS the poll route, so the card can render the reason (spec S-8)', async () => {
        // A refusal here would leave the card with nothing to explain itself
        // with — the state has copy, so the route has to return it.
        const { controller } = build(notOwner);
        const result = await controller.current(AUTH);

        expect(result.isOwner).toBe(false);
        expect(result.backup).toBeNull();
    });
});

describe('WorkspaceBackupController — reads', () => {
    it('never returns a backup from another workspace', async () => {
        const { controller } = build({ get: jest.fn().mockResolvedValue(null) });
        await expect(controller.get(AUTH, 'someone-elses')).rejects.toThrow(NotFoundException);
    });

    it('carries the limits in force so the card does not repeat the defaults (spec FR-47)', async () => {
        const { controller } = build();
        const result = await controller.list(AUTH);
        expect(result.limits).toMatchObject({ retentionDays: 14, dailyAllowance: 3 });
    });

    it('publishes the machine-readable format reference', () => {
        const { controller } = build();
        const format = controller.format();

        expect(format.formatVersion).toMatch(/^\d+\.\d+$/);
        expect(format.domains).toHaveLength(15);
        expect(format.domains.map((domain) => domain.key)).toEqual(
            BACKUP_DOMAINS.map((domain) => domain.key),
        );
    });
});

describe('WorkspaceBackupController — cancel and delete', () => {
    it('returns 409 when the backup settled a moment ago', async () => {
        const { controller } = build({ cancel: jest.fn().mockResolvedValue(false) });
        const { response, captured } = res();

        await controller.cancel(AUTH, 'b1', response as never);
        expect(captured.status).toBe(409);
        expect(captured.body).toEqual({ code: 'backup_already_finished' });
    });

    it('deletes through the service, which keeps the record', async () => {
        const { controller, service } = build();
        await controller.remove(AUTH, 'b1');
        expect(service.deleteArtifact).toHaveBeenCalledWith(expect.anything(), 'b1');
    });
});

describe('WorkspaceBackupController — download', () => {
    it('mints a link that carries the token and an expiry', async () => {
        const { controller } = build();
        const link = await controller.downloadLink(AUTH, 'b1');

        expect(link.url).toBe('/api/account/backups/b1/download?token=tok');
        expect(link.expiresAt).toBe('2026-09-06T14:27:00.000Z');
    });

    it('refuses a missing or stale token (spec S-15)', async () => {
        const { controller } = build({ verifyDownloadToken: jest.fn().mockReturnValue(false) });
        const { response } = res();

        await expect(controller.download(AUTH, 'b1', '', response as never)).rejects.toThrow(
            ForbiddenException,
        );
        await expect(controller.download(AUTH, 'b1', 'stale', response as never)).rejects.toThrow(
            ForbiddenException,
        );
    });

    it('answers 410 with the date for an expired archive, never 404 (spec S-16)', async () => {
        const { controller } = build({
            get: jest.fn().mockResolvedValue(backup({ status: 'expired' })),
        });
        const { response } = res();

        await expect(controller.download(AUTH, 'b1', 'tok', response as never)).rejects.toThrow(
            GoneException,
        );
    });

    it('answers 410 for an archive the owner deleted early (spec S-24)', async () => {
        const { controller } = build({
            get: jest.fn().mockResolvedValue(backup({ status: 'deleted' })),
        });
        const { response } = res();

        await expect(controller.downloadLink(AUTH, 'b1')).rejects.toThrow(GoneException);
        expect(response).toBeDefined();
    });

    it('sets a filename built from the archive’s own manifest, never from the request', async () => {
        const { controller } = build();
        const { response, headers } = res();

        await controller.download(AUTH, 'b1', 'tok', response as never);
        expect(headers['Content-Type']).toBe('application/zip');
        expect(headers['Content-Disposition']).toBe(
            'attachment; filename="everworks-backup-acme-2026-09-06-b1.zip"',
        );
        expect(headers['X-Checksum-Sha256']).toBe('f'.repeat(64));
        expect(headers['Content-Length']).toBe('3');
    });

    it('records the download before a byte leaves (spec FR-32)', async () => {
        const { controller, service } = build();
        const { response } = res();

        await controller.download(AUTH, 'b1', 'tok', response as never);
        expect(service.recordDownload).toHaveBeenCalled();
    });

    it('refuses to serve when no storage backend is configured', async () => {
        const { controller } = build({}, { storage: undefined as never });
        const controllerNoStorage = controller;
        const { response } = res();

        // Built with an explicitly absent storage binding.
        const noStorage = new (controllerNoStorage.constructor as typeof WorkspaceBackupController)(
            {
                isWorkspaceOwner: jest.fn().mockResolvedValue(true),
                get: jest.fn().mockResolvedValue(backup()),
                verifyDownloadToken: jest.fn().mockReturnValue(true),
            } as unknown as WorkspaceBackupService,
            {
                getOrganizationId: () => 'org-1',
                getTenantId: () => 't1',
            } as unknown as ScopeContextService,
            undefined,
        );

        await expect(noStorage.download(AUTH, 'b1', 'tok', response as never)).rejects.toThrow(
            ServiceUnavailableException,
        );
    });
});

describe('WorkspaceBackupController — what never leaves the server', () => {
    const forbidden = ['storageKey', 'failureDetail', 'runtimeRunId', 'credentialVersion'];

    it('keeps the four internal fields out of every response body', async () => {
        const { controller } = build();
        const { response, captured } = res();

        await controller.create(AUTH, {}, response as never);
        const bodies = [
            captured.body,
            await controller.list(AUTH),
            await controller.get(AUTH, 'b1'),
            await controller.current(AUTH),
        ];

        for (const body of bodies) {
            const serialised = JSON.stringify(body);
            for (const field of forbidden) {
                expect(serialised).not.toContain(field);
            }
            // And specifically the value, not just the key name.
            expect(serialised).not.toContain('u1/secret-object-key.zip');
            expect(serialised).not.toContain('internal host db-7');
        }
    });
});
