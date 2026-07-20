// EW-742 P1 (T11) + Trigger.dev BYO #1548 — integration tests for the
// CredentialVersionService surface that the tenant-job-runtime
// controller's rotate / force-invalidate endpoints depend on, plus the
// snapshot capture / resolveSnapshot path the worker host invokes.
//
// The agent package already has unit-grade coverage of the service in
// isolation (`packages/agent/src/tasks/__tests__/...`); these specs add
// the controller-touching flow: rotate via the controller observable
// behaviour (bumpVersion is called, returned version is reflected on the
// response) + snapshot capture + history resolver semantics across
// rotations.

import { randomUUID } from 'crypto';
import { CredentialVersionService } from '@ever-works/agent/tasks';
import type { TenantCredentialSnapshot, TenantJobRuntimeConfig } from '@ever-works/agent/entities';

type RepoMock = {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    increment: jest.Mock;
    createQueryBuilder: jest.Mock;
};

function makeRepo(): RepoMock {
    return {
        create: jest.fn((data) => data),
        save: jest.fn(async (row) => row),
        findOne: jest.fn(),
        increment: jest.fn(),
        createQueryBuilder: jest.fn(),
    };
}

/**
 * Builds the canonical no-op insert chain that `captureSnapshot` walks
 * through. The test asserts at the surface (the snapshot row that lands
 * in `values(...)` and whether `execute` runs) rather than the
 * intermediate builder shape.
 */
function buildQueryBuilder(execute: jest.Mock, captureValues?: jest.Mock) {
    const valuesMock = captureValues ?? jest.fn();
    return {
        insert: () => ({
            into: () => ({
                values: (row: Record<string, unknown>) => {
                    valuesMock(row);
                    return {
                        orIgnore: () => ({ execute }),
                    };
                },
            }),
        }),
    };
}

describe('CredentialVersionService (integration via controller-touching paths)', () => {
    let configRepo: RepoMock;
    let snapshotRepo: RepoMock;
    let service: CredentialVersionService;

    beforeEach(() => {
        configRepo = makeRepo();
        snapshotRepo = makeRepo();
        service = new CredentialVersionService(
            configRepo as unknown as never,
            snapshotRepo as unknown as never,
        );
    });

    describe('bumpVersion — controller rotate path', () => {
        it('returns the post-bump version when the increment affected exactly one row', async () => {
            const tenantId = randomUUID();
            configRepo.increment.mockResolvedValueOnce({ affected: 1 });
            configRepo.findOne.mockResolvedValueOnce({
                tenantId,
                credentialVersion: 11,
            } as TenantJobRuntimeConfig);
            const next = await service.bumpVersion(tenantId);
            expect(next).toBe(11);
            expect(configRepo.increment).toHaveBeenCalledWith({ tenantId }, 'credentialVersion', 1);
        });

        it('returns null when no overlay row exists (caller surfaces 404)', async () => {
            configRepo.increment.mockResolvedValueOnce({ affected: 0 });
            const result = await service.bumpVersion(randomUUID());
            expect(result).toBeNull();
            // No follow-up findOne when nothing was incremented.
            expect(configRepo.findOne).not.toHaveBeenCalled();
        });

        it('captures a snapshot when both providerId and newCredentials are supplied', async () => {
            const tenantId = randomUUID();
            const projectRef = `proj_${randomUUID().slice(0, 12)}`;
            const captured: Record<string, unknown>[] = [];
            const execute = jest.fn().mockResolvedValue(undefined);
            const values = jest.fn((row) => captured.push(row));
            snapshotRepo.createQueryBuilder.mockReturnValue(buildQueryBuilder(execute, values));
            configRepo.increment.mockResolvedValueOnce({ affected: 1 });
            configRepo.findOne.mockResolvedValueOnce({
                tenantId,
                credentialVersion: 2,
                providerId: 'trigger',
            } as TenantJobRuntimeConfig);

            const next = await service.bumpVersion(tenantId, 'trigger', {
                accessToken: 'tr_pat_xxx',
                secretKey: 'tr_secret_yyy',
                projectRef,
            });

            expect(next).toBe(2);
            expect(execute).toHaveBeenCalledTimes(1);
            expect(captured).toHaveLength(1);
            expect(captured[0]).toMatchObject({
                tenantId,
                providerId: 'trigger',
                credentialVersion: 2,
            });
        });

        it('falls back to the row providerId when caller omits providerId but supplies credentials', async () => {
            const tenantId = randomUUID();
            const captured: Record<string, unknown>[] = [];
            const execute = jest.fn().mockResolvedValue(undefined);
            const values = jest.fn((row) => captured.push(row));
            snapshotRepo.createQueryBuilder.mockReturnValue(buildQueryBuilder(execute, values));
            configRepo.increment.mockResolvedValueOnce({ affected: 1 });
            configRepo.findOne.mockResolvedValueOnce({
                tenantId,
                providerId: 'trigger',
                credentialVersion: 3,
            } as TenantJobRuntimeConfig);

            await service.bumpVersion(tenantId, undefined, { accessToken: 'x' });

            expect(captured[0].providerId).toBe('trigger');
        });

        it('skips snapshot capture when caller passes credentials but row has no providerId', async () => {
            const tenantId = randomUUID();
            const execute = jest.fn().mockResolvedValue(undefined);
            snapshotRepo.createQueryBuilder.mockReturnValue(buildQueryBuilder(execute));
            configRepo.increment.mockResolvedValueOnce({ affected: 1 });
            configRepo.findOne.mockResolvedValueOnce({
                tenantId,
                providerId: undefined,
                credentialVersion: 4,
            } as unknown as TenantJobRuntimeConfig);

            await service.bumpVersion(tenantId, undefined, { accessToken: 'x' });

            expect(execute).not.toHaveBeenCalled();
        });
    });

    describe('captureSnapshot — idempotent + driver fallback', () => {
        it('writes through the orIgnore() builder chain on the snapshot repo', async () => {
            const tenantId = randomUUID();
            const execute = jest.fn().mockResolvedValue(undefined);
            const values = jest.fn();
            snapshotRepo.createQueryBuilder.mockReturnValue(buildQueryBuilder(execute, values));

            await service.captureSnapshot(tenantId, 'trigger', 5, {
                accessToken: 'enc_blob',
                secretKey: 'enc_blob2',
                projectRef: 'proj_test',
            });

            expect(values).toHaveBeenCalledWith({
                tenantId,
                providerId: 'trigger',
                credentialVersion: 5,
                credentialsEncrypted: {
                    accessToken: 'enc_blob',
                    secretKey: 'enc_blob2',
                    projectRef: 'proj_test',
                },
            });
            expect(execute).toHaveBeenCalledTimes(1);
        });

        it('swallows duplicate-key violations as a no-op (idempotent contract)', async () => {
            const execute = jest
                .fn()
                .mockRejectedValue(new Error('duplicate key value violates unique constraint'));
            snapshotRepo.createQueryBuilder.mockReturnValue(buildQueryBuilder(execute));
            await expect(
                service.captureSnapshot(randomUUID(), 'trigger', 7, { x: 1 }),
            ).resolves.toBeUndefined();
        });

        it('re-throws non-unique-violation errors to the caller', async () => {
            const execute = jest.fn().mockRejectedValue(new Error('connection refused'));
            snapshotRepo.createQueryBuilder.mockReturnValue(buildQueryBuilder(execute));
            await expect(
                service.captureSnapshot(randomUUID(), 'trigger', 9, { x: 1 }),
            ).rejects.toThrow(/connection refused/);
        });
    });

    describe('resolveSnapshot — worker host historical path', () => {
        it('returns the live row when the requested version is current', async () => {
            const tenantId = randomUUID();
            const live = {
                tenantId,
                providerId: 'trigger',
                credentialsSecretRef: 'live-ref-xxxx',
                credentialVersion: 8,
                mode: 'byo',
                enabled: true,
            } as TenantJobRuntimeConfig;
            configRepo.findOne.mockResolvedValueOnce(live);
            const snap = await service.resolveSnapshot(tenantId, 8);
            expect(snap).toBe(live);
        });

        it('synthesises a historical TenantJobRuntimeConfig with an inline: pointer for stale versions', async () => {
            const tenantId = randomUUID();
            const now = new Date('2026-06-21T08:00:00.000Z');
            configRepo.findOne.mockResolvedValueOnce({
                tenantId,
                providerId: 'trigger',
                credentialsSecretRef: 'live-ref-zzzz',
                credentialVersion: 12,
                mode: 'override',
                enabled: false,
                createdBy: 'user-1',
                createdAt: now,
            } as TenantJobRuntimeConfig);
            snapshotRepo.findOne.mockResolvedValueOnce({
                id: 'snap-hist-1',
                tenantId,
                providerId: 'trigger',
                credentialVersion: 7,
                credentialsEncrypted: { accessToken: 'enc_historical' },
                capturedAt: new Date('2026-06-15T08:00:00.000Z'),
            } as TenantCredentialSnapshot);

            const snap = await service.resolveSnapshot(tenantId, 7);

            expect(snap).not.toBeNull();
            expect(snap?.credentialVersion).toBe(7);
            // The synthesised row carries the tenant's CURRENT mode/enabled
            // (those are tenant-level metadata, not version-pinned).
            expect(snap?.mode).toBe('override');
            expect(snap?.enabled).toBe(false);
            // The historical encrypted bag is re-issued as `inline:<base64>`
            // so the secret-store resolver chain dereferences it via the
            // existing inline path.
            expect(snap?.credentialsSecretRef?.startsWith('inline:')).toBe(true);
            const inlineBody = snap?.credentialsSecretRef?.slice('inline:'.length);
            expect(inlineBody).toBeTruthy();
            const decoded = JSON.parse(Buffer.from(inlineBody!, 'base64').toString('utf-8'));
            expect(decoded).toEqual({ accessToken: 'enc_historical' });
        });

        it('returns null for a stale version when the history table has no row (CREDENTIAL_DRAINED)', async () => {
            const tenantId = randomUUID();
            configRepo.findOne.mockResolvedValueOnce({
                tenantId,
                providerId: 'trigger',
                credentialVersion: 20,
            } as TenantJobRuntimeConfig);
            snapshotRepo.findOne.mockResolvedValueOnce(null);

            const snap = await service.resolveSnapshot(tenantId, 3);

            expect(snap).toBeNull();
        });

        it('returns null when the tenant has no overlay row at all', async () => {
            configRepo.findOne.mockResolvedValueOnce(null);
            const snap = await service.resolveSnapshot(randomUUID(), 1);
            expect(snap).toBeNull();
            // Should not bother querying the history table.
            expect(snapshotRepo.findOne).not.toHaveBeenCalled();
        });

        it('historical lookup is scoped by (tenantId, providerId, version) — provider switches are isolated', async () => {
            const tenantId = randomUUID();
            configRepo.findOne.mockResolvedValueOnce({
                tenantId,
                providerId: 'temporal',
                credentialVersion: 5,
            } as TenantJobRuntimeConfig);
            snapshotRepo.findOne.mockResolvedValueOnce(null);

            await service.resolveSnapshot(tenantId, 2);

            // The natural key uses the row's CURRENT providerId, so a
            // tenant that switched runtimes can't accidentally resolve
            // a snapshot from the wrong provider.
            expect(snapshotRepo.findOne).toHaveBeenCalledWith({
                where: { tenantId, providerId: 'temporal', credentialVersion: 2 },
            });
        });
    });

    describe('getCurrentVersion — read surface', () => {
        it('returns the row credentialVersion when the overlay exists', async () => {
            const tenantId = randomUUID();
            configRepo.findOne.mockResolvedValueOnce({
                tenantId,
                credentialVersion: 42,
            } as TenantJobRuntimeConfig);
            const result = await service.getCurrentVersion(tenantId);
            expect(result).toBe(42);
            expect(configRepo.findOne).toHaveBeenCalledWith({
                where: { tenantId },
                select: ['tenantId', 'credentialVersion'],
            });
        });

        it('returns null when no overlay row exists (inherit-mode default)', async () => {
            configRepo.findOne.mockResolvedValueOnce(null);
            const result = await service.getCurrentVersion(randomUUID());
            expect(result).toBeNull();
        });
    });
});
