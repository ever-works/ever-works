import { CredentialVersionService } from '../credential-version.service';
import type { TenantCredentialSnapshot } from '../../entities/tenant-credential-snapshot.entity';
import type { TenantJobRuntimeConfig } from '../../entities/tenant-job-runtime-config.entity';

/**
 * EW-742 P1 T11 follow-up — coverage for the snapshot-history side of
 * `CredentialVersionService`. The base service contract (bumpVersion +
 * resolveSnapshot for `version == current`) is already covered by
 * `apps/api/src/works/__tests__/tenant-job-runtime-config.repository.spec.ts`;
 * this file pins the **history** behaviours that the original P1 stopgap
 * deferred:
 *
 *   1. `captureSnapshot` inserts a row through the snapshot repository.
 *   2. `captureSnapshot` is idempotent on the natural key — re-inserting
 *      the same `(tenantId, providerId, credentialVersion)` triple is a
 *      no-op (the migration's UNIQUE index + `orIgnore()` swallow the
 *      conflict; defensive try/catch swallows it on drivers that ignore
 *      the directive).
 *   3. `resolveSnapshot(tenantId, current)` returns the live overlay row
 *      directly (no history-table read at all).
 *   4. `resolveSnapshot(tenantId, current - 1)` synthesises a config-shaped
 *      row from the historical bag.
 *   5. `resolveSnapshot(tenantId, unknown-version)` returns null when no
 *      history row exists either.
 *   6. `bumpVersion` extension — when the caller passes credentials, the
 *      post-bump snapshot is captured AND `current()` advances.
 *
 * Repository mocks mirror the pattern from
 * `packages/agent/src/database/repositories/*.repository.spec.ts` —
 * shallow duck-typed objects with `jest.fn()` per method, satisfying
 * only the surface the service touches.
 */

type RepoMock = {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
    increment: jest.Mock;
    createQueryBuilder: jest.Mock;
};

function makeRepo(): RepoMock {
    return {
        create: jest.fn((data) => data),
        save: jest.fn(async (row) => row),
        findOne: jest.fn(),
        find: jest.fn(),
        update: jest.fn(),
        increment: jest.fn(),
        createQueryBuilder: jest.fn(),
    };
}

/**
 * Build a fake `createQueryBuilder` chain that mirrors the shape
 * `CredentialVersionService.captureSnapshot` uses:
 *
 *   .createQueryBuilder().insert().into(...).values(...).orIgnore().execute()
 *
 * The terminal `execute` is the only step that actually does work; the
 * intermediate links just return the next builder. `executeImpl` controls
 * what `execute()` resolves to (or throws) — defaults to a resolved
 * `undefined`, the no-op success case.
 *
 * Tests inspect `valuesMock` (returned alongside the chain) to assert
 * the payload the service passed in.
 */
function makeInsertChain(executeImpl: () => Promise<unknown>) {
    const execute = jest.fn(executeImpl);
    const orIgnore = jest.fn(() => ({ execute }));
    const values = jest.fn(() => ({ orIgnore }));
    const into = jest.fn(() => ({ values }));
    const insert = jest.fn(() => ({ into }));
    return {
        chain: { insert },
        values,
        orIgnore,
        execute,
        insert,
        into,
    };
}

describe('CredentialVersionService — snapshot history (EW-742 P1 T11 follow-up)', () => {
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

    describe('captureSnapshot', () => {
        it('inserts a row into the snapshot history table', async () => {
            const insertChain = makeInsertChain(async () => undefined);
            snapshotRepo.createQueryBuilder.mockReturnValueOnce(insertChain.chain);

            await service.captureSnapshot('tenant-a', 'trigger', 5, {
                token: 'enc:abc',
            });

            expect(snapshotRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
            expect(insertChain.values).toHaveBeenCalledWith({
                tenantId: 'tenant-a',
                providerId: 'trigger',
                credentialVersion: 5,
                credentialsEncrypted: { token: 'enc:abc' },
            });
            expect(insertChain.orIgnore).toHaveBeenCalledTimes(1);
            expect(insertChain.execute).toHaveBeenCalledTimes(1);
        });

        it('is idempotent on the natural key when the driver swallows via orIgnore (no throw)', async () => {
            // Postgres path: `ON CONFLICT DO NOTHING` makes execute() resolve
            // cleanly even on a duplicate insert. Two back-to-back captures
            // of the same triple must both succeed without surfacing.
            const first = makeInsertChain(async () => undefined);
            const second = makeInsertChain(async () => undefined);
            snapshotRepo.createQueryBuilder
                .mockReturnValueOnce(first.chain)
                .mockReturnValueOnce(second.chain);

            await service.captureSnapshot('tenant-a', 'trigger', 5, { token: 'enc:abc' });
            await service.captureSnapshot('tenant-a', 'trigger', 5, { token: 'enc:abc' });

            expect(snapshotRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
            expect(first.execute).toHaveBeenCalledTimes(1);
            expect(second.execute).toHaveBeenCalledTimes(1);
        });

        it('is idempotent on the natural key when the driver throws a unique-violation', async () => {
            // Defensive path — some drivers / TypeORM versions surface
            // the conflict as a thrown error even with `.orIgnore()`. The
            // service must detect the unique-violation signature and
            // treat it as a no-op (still no throw to the caller).
            const insertChain = makeInsertChain(async () => {
                throw new Error('duplicate key value violates unique constraint "uq_…"');
            });
            snapshotRepo.createQueryBuilder.mockReturnValueOnce(insertChain.chain);

            await expect(
                service.captureSnapshot('tenant-a', 'trigger', 5, { token: 'enc:abc' }),
            ).resolves.toBeUndefined();
        });

        it('propagates non-unique-violation errors', async () => {
            // A connection drop or schema error MUST NOT be silently
            // swallowed — that would mask real outages behind the
            // idempotency story.
            const insertChain = makeInsertChain(async () => {
                throw new Error('connection terminated');
            });
            snapshotRepo.createQueryBuilder.mockReturnValueOnce(insertChain.chain);

            await expect(
                service.captureSnapshot('tenant-a', 'trigger', 5, { token: 'enc:abc' }),
            ).rejects.toThrow(/connection terminated/);
        });
    });

    describe('resolveSnapshot', () => {
        it('returns the current overlay row when version === current (no history read)', async () => {
            const row = {
                tenantId: 'tenant-a',
                providerId: 'trigger',
                credentialsSecretRef: 'vault:cur',
                credentialVersion: 5,
                mode: 'byo',
                enabled: true,
                createdBy: null,
                createdAt: new Date('2026-01-01T00:00:00Z'),
                updatedAt: new Date('2026-01-02T00:00:00Z'),
            } as TenantJobRuntimeConfig;
            configRepo.findOne.mockResolvedValueOnce(row);

            const snap = await service.resolveSnapshot('tenant-a', 5);

            expect(snap).toBe(row);
            // Fast path — history table is never consulted when the
            // requested version is the current one.
            expect(snapshotRepo.findOne).not.toHaveBeenCalled();
        });

        it('synthesises a config row from the snapshot when version === current - 1', async () => {
            const currentRow = {
                tenantId: 'tenant-a',
                providerId: 'trigger',
                credentialsSecretRef: 'vault:cur',
                credentialVersion: 6,
                mode: 'byo',
                enabled: true,
                createdBy: 'user-1',
                createdAt: new Date('2026-01-01T00:00:00Z'),
                updatedAt: new Date('2026-01-02T00:00:00Z'),
            } as TenantJobRuntimeConfig;
            const historyRow = {
                id: 'snap-uuid',
                tenantId: 'tenant-a',
                providerId: 'trigger',
                credentialVersion: 5,
                credentialsEncrypted: { token: 'enc:prev' },
                capturedAt: new Date('2026-01-01T12:00:00Z'),
            } as TenantCredentialSnapshot;

            configRepo.findOne.mockResolvedValueOnce(currentRow);
            snapshotRepo.findOne.mockResolvedValueOnce(historyRow);

            const snap = await service.resolveSnapshot('tenant-a', 5);

            expect(snap).not.toBeNull();
            // Tenant-level metadata inherited from the current row.
            expect(snap?.mode).toBe('byo');
            expect(snap?.enabled).toBe(true);
            expect(snap?.createdBy).toBe('user-1');
            // Version-pinned fields restored from history.
            expect(snap?.credentialVersion).toBe(5);
            expect(snap?.providerId).toBe('trigger');
            // The historical bag is re-issued as an `inline:` pointer so
            // the existing secret-store resolver chain dereferences it
            // through its existing path. Decoding the base64 round-trips
            // back to the original bag.
            expect(snap?.credentialsSecretRef).toMatch(/^inline:/);
            const encoded = snap!.credentialsSecretRef!.slice('inline:'.length);
            const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
            expect(decoded).toEqual({ token: 'enc:prev' });
            // History lookup scoped by the natural key.
            expect(snapshotRepo.findOne).toHaveBeenCalledWith({
                where: {
                    tenantId: 'tenant-a',
                    providerId: 'trigger',
                    credentialVersion: 5,
                },
            });
        });

        it('returns null for an unknown historical version (drained)', async () => {
            const currentRow = {
                tenantId: 'tenant-a',
                providerId: 'trigger',
                credentialVersion: 6,
                mode: 'byo',
                enabled: true,
            } as TenantJobRuntimeConfig;
            configRepo.findOne.mockResolvedValueOnce(currentRow);
            snapshotRepo.findOne.mockResolvedValueOnce(null);

            const snap = await service.resolveSnapshot('tenant-a', 99);

            expect(snap).toBeNull();
        });

        it('returns null when the tenant has no overlay row at all', async () => {
            configRepo.findOne.mockResolvedValueOnce(null);

            const snap = await service.resolveSnapshot('tenant-missing', 1);

            expect(snap).toBeNull();
            // No tenant overlay → no point asking history.
            expect(snapshotRepo.findOne).not.toHaveBeenCalled();
        });
    });

    describe('bumpVersion (extended)', () => {
        it('captures the new version snapshot AND advances current()', async () => {
            // Stage 1 — bumpVersion with credentials.
            configRepo.increment.mockResolvedValueOnce({ affected: 1 } as never);
            configRepo.findOne.mockResolvedValueOnce({
                tenantId: 'tenant-a',
                providerId: 'trigger',
                credentialVersion: 3,
            } as TenantJobRuntimeConfig);
            const insertChain = makeInsertChain(async () => undefined);
            snapshotRepo.createQueryBuilder.mockReturnValueOnce(insertChain.chain);

            const newVersion = await service.bumpVersion('tenant-a', 'trigger', {
                token: 'enc:new',
            });

            expect(newVersion).toBe(3);
            // The new bag was captured under the new version.
            expect(insertChain.values).toHaveBeenCalledWith({
                tenantId: 'tenant-a',
                providerId: 'trigger',
                credentialVersion: 3,
                credentialsEncrypted: { token: 'enc:new' },
            });

            // Stage 2 — getCurrentVersion reflects the bump.
            configRepo.findOne.mockResolvedValueOnce({
                tenantId: 'tenant-a',
                credentialVersion: 3,
            } as TenantJobRuntimeConfig);
            expect(await service.getCurrentVersion('tenant-a')).toBe(3);
        });

        it('falls back to the row providerId when caller omits it but supplies credentials', async () => {
            configRepo.increment.mockResolvedValueOnce({ affected: 1 } as never);
            configRepo.findOne.mockResolvedValueOnce({
                tenantId: 'tenant-a',
                providerId: 'temporal',
                credentialVersion: 4,
            } as TenantJobRuntimeConfig);
            const insertChain = makeInsertChain(async () => undefined);
            snapshotRepo.createQueryBuilder.mockReturnValueOnce(insertChain.chain);

            await service.bumpVersion('tenant-a', undefined, { token: 'enc:y' });

            expect(insertChain.values).toHaveBeenCalledWith({
                tenantId: 'tenant-a',
                providerId: 'temporal',
                credentialVersion: 4,
                credentialsEncrypted: { token: 'enc:y' },
            });
        });

        it('skips snapshot capture when no credentials are supplied (legacy 1-arg call)', async () => {
            // The legacy bumpVersion(tenantId) signature stays a pure
            // version pointer rotation — call sites that don't have the
            // bag in hand (force-invalidate, the audit-only path) MUST
            // NOT trigger a half-empty snapshot row.
            configRepo.increment.mockResolvedValueOnce({ affected: 1 } as never);
            configRepo.findOne.mockResolvedValueOnce({
                tenantId: 'tenant-a',
                providerId: 'trigger',
                credentialVersion: 7,
            } as TenantJobRuntimeConfig);

            const newVersion = await service.bumpVersion('tenant-a');

            expect(newVersion).toBe(7);
            expect(snapshotRepo.createQueryBuilder).not.toHaveBeenCalled();
        });

        it('returns null and skips snapshot capture when no overlay row exists', async () => {
            configRepo.increment.mockResolvedValueOnce({ affected: 0 } as never);

            const result = await service.bumpVersion('tenant-missing', 'trigger', {
                token: 'enc:x',
            });

            expect(result).toBeNull();
            expect(snapshotRepo.createQueryBuilder).not.toHaveBeenCalled();
        });
    });
});
