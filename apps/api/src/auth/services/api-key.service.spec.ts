jest.mock('@ever-works/agent/database', () => ({}));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'crypto';
import { ApiKeyService } from './api-key.service';
import type { ApiKeyRepository } from '@ever-works/agent/database';

describe('ApiKeyService', () => {
    let service: ApiKeyService;
    let repo: jest.Mocked<
        Pick<
            ApiKeyRepository,
            | 'countByUserId'
            | 'create'
            | 'findByUserId'
            | 'deleteByIdAndUserId'
            | 'findByHashedKey'
            | 'updateLastUsed'
            | 'findByPreviousHashedKey'
            | 'findByIdAndUserId'
            | 'applyRotation'
        >
    >;

    beforeEach(() => {
        repo = {
            countByUserId: jest.fn(),
            create: jest.fn(),
            findByUserId: jest.fn(),
            deleteByIdAndUserId: jest.fn(),
            findByHashedKey: jest.fn(),
            updateLastUsed: jest.fn().mockResolvedValue(undefined),
            // EW-P1-2 — rotation grace lookup + in-place rotation.
            findByPreviousHashedKey: jest.fn().mockResolvedValue(null),
            findByIdAndUserId: jest.fn(),
            applyRotation: jest.fn().mockResolvedValue(true),
        } as any;
        service = new ApiKeyService(repo as unknown as ApiKeyRepository);
    });

    describe('createKey', () => {
        it('rejects when user already has 10 keys', async () => {
            repo.countByUserId.mockResolvedValue(10);

            await expect(service.createKey('user-1', 'name')).rejects.toThrow(BadRequestException);
            await expect(service.createKey('user-1', 'name')).rejects.toThrow(
                'Maximum of 10 API keys allowed per user',
            );
            expect(repo.create).not.toHaveBeenCalled();
        });

        it('rejects expiresAt in the past', async () => {
            repo.countByUserId.mockResolvedValue(0);
            const past = new Date(Date.now() - 1000).toISOString();

            await expect(service.createKey('user-1', 'name', past)).rejects.toThrow(
                'Expiration date must be in the future',
            );
            expect(repo.create).not.toHaveBeenCalled();
        });

        it('rejects expiresAt equal to now', async () => {
            repo.countByUserId.mockResolvedValue(0);
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-05-07T12:00:00.000Z'));

            try {
                await expect(
                    service.createKey('user-1', 'name', '2026-05-07T12:00:00.000Z'),
                ).rejects.toThrow('Expiration date must be in the future');
                expect(repo.create).not.toHaveBeenCalled();
            } finally {
                jest.useRealTimers();
            }
        });

        it('creates a key with ew_live_ prefix and returns the raw key once', async () => {
            repo.countByUserId.mockResolvedValue(3);
            repo.create.mockImplementation(
                async (input) =>
                    ({
                        id: 'key-1',
                        name: input.name,
                        hashedKey: input.hashedKey,
                        prefix: input.prefix,
                        expiresAt: input.expiresAt,
                        createdAt: new Date('2026-05-07'),
                        userId: input.userId,
                    }) as any,
            );

            const result = await service.createKey('user-1', 'CI key');

            expect(repo.create).toHaveBeenCalledTimes(1);
            const createInput = repo.create.mock.calls[0][0];
            expect(createInput.userId).toBe('user-1');
            expect(createInput.name).toBe('CI key');
            expect(createInput.expiresAt).toBeNull();
            expect(createInput.prefix).toBe(
                'ew_live_'.length === 8 ? 'ew_live_' + result.key.substring(8, 12) : '',
            );
            // 12-char prefix is "ew_live_" (8 chars) + 4 hex chars
            expect(result.key.startsWith('ew_live_')).toBe(true);
            expect(result.key).toHaveLength('ew_live_'.length + 64); // 8 + 32 bytes hex
            expect(result.prefix).toBe(result.key.substring(0, 12));
            // Hashed key should be sha256 of raw key
            expect(createInput.hashedKey).toBe(
                createHash('sha256').update(result.key).digest('hex'),
            );
            expect(result.id).toBe('key-1');
            expect(result.name).toBe('CI key');
            expect(result.expiresAt).toBeNull();
        });

        it('creates a key with a future expiresAt', async () => {
            repo.countByUserId.mockResolvedValue(0);
            const future = new Date(Date.now() + 86400000).toISOString();
            repo.create.mockImplementation(
                async (input) =>
                    ({
                        id: 'key-2',
                        name: input.name,
                        hashedKey: input.hashedKey,
                        prefix: input.prefix,
                        expiresAt: input.expiresAt,
                        createdAt: new Date(),
                        userId: input.userId,
                    }) as any,
            );

            const result = await service.createKey('u', 'n', future);

            const createInput = repo.create.mock.calls[0][0];
            expect(createInput.expiresAt).toBeInstanceOf(Date);
            expect((createInput.expiresAt as Date).toISOString()).toBe(future);
            expect(result.expiresAt).toEqual(new Date(future));
        });

        it('generates unique keys across calls', async () => {
            repo.countByUserId.mockResolvedValue(0);
            repo.create.mockImplementation(
                async (input) =>
                    ({
                        id: 'k',
                        ...input,
                        createdAt: new Date(),
                    }) as any,
            );

            const r1 = await service.createKey('u', 'a');
            const r2 = await service.createKey('u', 'b');

            expect(r1.key).not.toBe(r2.key);
            expect(r1.prefix).not.toBe(r2.prefix);
        });
    });

    describe('listKeys', () => {
        it('returns the repository result for the user', async () => {
            const keys = [{ id: 'k1' }, { id: 'k2' }];
            repo.findByUserId.mockResolvedValue(keys as any);

            const result = await service.listKeys('user-1');

            expect(repo.findByUserId).toHaveBeenCalledWith('user-1');
            expect(result).toBe(keys);
        });
    });

    describe('revokeKey', () => {
        it('returns true on successful deletion', async () => {
            repo.deleteByIdAndUserId.mockResolvedValue(true);

            const result = await service.revokeKey('k-1', 'user-1');

            expect(repo.deleteByIdAndUserId).toHaveBeenCalledWith('k-1', 'user-1');
            expect(result).toBe(true);
        });

        it('returns false when no row was deleted', async () => {
            repo.deleteByIdAndUserId.mockResolvedValue(false);

            const result = await service.revokeKey('missing', 'user-1');

            expect(result).toBe(false);
        });
    });

    describe('validateKey', () => {
        const RAW = 'ew_live_' + 'a'.repeat(64);
        const HASHED = createHash('sha256').update(RAW).digest('hex');

        it('hashes the raw key with sha256 before lookup', async () => {
            repo.findByHashedKey.mockResolvedValue(null);

            await service.validateKey(RAW);

            expect(repo.findByHashedKey).toHaveBeenCalledWith(HASHED);
        });

        it('returns null when no record matches', async () => {
            repo.findByHashedKey.mockResolvedValue(null);

            const result = await service.validateKey(RAW);

            expect(result).toBeNull();
            expect(repo.updateLastUsed).not.toHaveBeenCalled();
        });

        it('returns null when key is expired', async () => {
            repo.findByHashedKey.mockResolvedValue({
                id: 'k-1',
                kind: 'personal',
                expiresAt: new Date(Date.now() - 1000),
            } as any);

            const result = await service.validateKey(RAW);

            expect(result).toBeNull();
            expect(repo.updateLastUsed).not.toHaveBeenCalled();
        });

        it('returns the key and triggers fire-and-forget updateLastUsed when valid', async () => {
            const apiKey = {
                id: 'k-1',
                kind: 'personal',
                expiresAt: new Date(Date.now() + 100000),
            };
            repo.findByHashedKey.mockResolvedValue(apiKey as any);

            const result = await service.validateKey(RAW);

            expect(result).toBe(apiKey);
            expect(repo.updateLastUsed).toHaveBeenCalledWith('k-1');
        });

        it('treats null expiresAt as never-expiring', async () => {
            const apiKey = { id: 'k-2', kind: 'personal', expiresAt: null };
            repo.findByHashedKey.mockResolvedValue(apiKey as any);

            const result = await service.validateKey(RAW);

            expect(result).toBe(apiKey);
            expect(repo.updateLastUsed).toHaveBeenCalledWith('k-2');
        });

        // ── Self-build slice Z (EW-796) — kind discrimination ──────────
        //
        // `api_keys` holds two kinds of row since the MCP bridge landed.
        // A `fleet-run` row is only safe because
        // `FleetRunCredentialService.authenticate` gates it on a route
        // allowlist, on the bound job still being held by the bound node,
        // and on an Organization pin. `validateKey` applies NONE of those,
        // so it must refuse such a row outright — otherwise every caller
        // that reaches it (the `ew_live_` guard branch, and the @Public()
        // uploads controller, which forwards ANY `x-api-key` value it is
        // handed) would authenticate a run token as the plain owner with
        // the whole API surface open to it.
        it('refuses a fleet-run row — a run token is never a personal key', async () => {
            const runToken = 'ew_run_' + 'b'.repeat(64);
            repo.findByHashedKey.mockResolvedValue({
                id: 'run-1',
                userId: 'user-1',
                kind: 'fleet-run',
                boundJobId: 'job-1',
                expiresAt: new Date(Date.now() + 100000),
            } as any);

            const result = await service.validateKey(runToken);

            expect(result).toBeNull();
            // Not even a `lastUsedAt` write: nothing about this row was
            // accepted, so nothing about it may be recorded as used.
            expect(repo.updateLastUsed).not.toHaveBeenCalled();
        });

        it('refuses an unrecognised kind — deny by omission, not by enumeration', async () => {
            repo.findByHashedKey.mockResolvedValue({
                id: 'k-9',
                kind: 'some-future-kind',
                expiresAt: null,
            } as any);

            await expect(service.validateKey(RAW)).resolves.toBeNull();
            expect(repo.updateLastUsed).not.toHaveBeenCalled();
        });

        it('swallows updateLastUsed failure (fire-and-forget)', async () => {
            const apiKey = { id: 'k-3', kind: 'personal', expiresAt: null };
            repo.findByHashedKey.mockResolvedValue(apiKey as any);
            repo.updateLastUsed.mockRejectedValue(new Error('db down'));

            await expect(service.validateKey(RAW)).resolves.toBe(apiKey);
            // Allow microtasks to flush so the catch() runs without an unhandled rejection
            await new Promise((resolve) => setImmediate(resolve));
        });
    });
    // ── EW-P1-2 — integration keys and in-place rotation ───────────────
    describe('validateIntegrationKey', () => {
        const RAW = 'ew_int_' + 'c'.repeat(64);
        const live = (over: Record<string, unknown> = {}) => ({
            id: 'int-1',
            kind: 'integration',
            expiresAt: null,
            organizationIds: ['org-1'],
            ...over,
        });

        it('accepts an active integration row and stamps lastUsedAt', async () => {
            const row = live();
            repo.findByHashedKey.mockResolvedValue(row as any);
            await expect(service.validateIntegrationKey(RAW)).resolves.toBe(row);
            expect(repo.findByHashedKey).toHaveBeenCalledWith(
                createHash('sha256').update(RAW).digest('hex'),
            );
            expect(repo.updateLastUsed).toHaveBeenCalledWith('int-1');
        });

        it('refuses a non-ew_int_ secret without a lookup', async () => {
            await expect(
                service.validateIntegrationKey('ew_live_' + 'c'.repeat(64)),
            ).resolves.toBeNull();
            expect(repo.findByHashedKey).not.toHaveBeenCalled();
        });

        it('refuses personal and fleet-run rows (inverse kind gate)', async () => {
            for (const kind of ['personal', 'fleet-run']) {
                repo.findByHashedKey.mockResolvedValue(live({ kind }) as any);
                await expect(service.validateIntegrationKey(RAW)).resolves.toBeNull();
            }
        });

        it('refuses an expired key and a key with no pin', async () => {
            repo.findByHashedKey.mockResolvedValue(
                live({ expiresAt: new Date(Date.now() - 1) }) as any,
            );
            await expect(service.validateIntegrationKey(RAW)).resolves.toBeNull();
            repo.findByHashedKey.mockResolvedValue(live({ organizationIds: [] }) as any);
            await expect(service.validateIntegrationKey(RAW)).resolves.toBeNull();
        });

        it('an integration secret is never accepted as a personal key', async () => {
            repo.findByHashedKey.mockResolvedValue(live() as any);
            await expect(service.validateKey(RAW)).resolves.toBeNull();
        });
    });

    describe('rotation grace period', () => {
        const RAW = 'ew_live_' + 'd'.repeat(64);

        it('accepts the previous secret until previousKeyGraceUntil, then refuses it', async () => {
            repo.findByHashedKey.mockResolvedValue(null);
            const row = {
                id: 'k-r',
                kind: 'personal',
                expiresAt: null,
                previousKeyGraceUntil: new Date(Date.now() + 60_000),
            };
            repo.findByPreviousHashedKey.mockResolvedValue(row as any);
            await expect(service.validateKey(RAW)).resolves.toBe(row);

            row.previousKeyGraceUntil = new Date(Date.now() - 1);
            await expect(service.validateKey(RAW)).resolves.toBeNull();
        });
    });

    describe('rotateKey', () => {
        it('rotates in place: same id, new secret of the same kind, old digest kept for the grace period', async () => {
            repo.findByIdAndUserId.mockResolvedValue({
                id: 'k-1',
                name: 'Gauzy',
                kind: 'integration',
                isActive: true,
                expiresAt: null,
                hashedKey: 'old-digest',
            } as any);
            const before = Date.now();
            const out = await service.rotateKey('k-1', 'user-1', 24);

            expect(out.id).toBe('k-1');
            expect(out.key).toMatch(/^ew_int_[0-9a-f]{64}$/);
            expect(out.prefix).toBe(out.key.slice(0, 12));
            expect(repo.applyRotation.mock.calls[0][1]).toBe('old-digest');
            const patch = repo.applyRotation.mock.calls[0][2];
            expect(patch.hashedKey).toBe(createHash('sha256').update(out.key).digest('hex'));
            expect(patch.previousHashedKey).toBe('old-digest');
            const grace = new Date(patch.previousKeyGraceUntil as Date).getTime();
            expect(grace).toBeGreaterThanOrEqual(before + 24 * 3_600_000);
        });

        it('refuses with 409 when another rotation landed first (compare-and-set lost)', async () => {
            repo.findByIdAndUserId.mockResolvedValue({
                id: 'k-1',
                name: 'Gauzy',
                kind: 'integration',
                isActive: true,
                expiresAt: null,
                hashedKey: 'old-digest',
            } as any);
            repo.applyRotation.mockResolvedValueOnce(false);
            await expect(service.rotateKey('k-1', 'user-1')).rejects.toThrow(ConflictException);
        });

        it('rotates a personal key with the ew_live_ prefix', async () => {
            repo.findByIdAndUserId.mockResolvedValue({
                id: 'k-2',
                name: 'cli',
                kind: 'personal',
                isActive: true,
                expiresAt: null,
                hashedKey: 'h',
            } as any);
            const out = await service.rotateKey('k-2', 'user-1');
            expect(out.key).toMatch(/^ew_live_/);
        });

        it('404s a missing, revoked or fleet-run key, and 400s an out-of-range grace or an expired key', async () => {
            repo.findByIdAndUserId.mockResolvedValue(null);
            await expect(service.rotateKey('x', 'user-1')).rejects.toThrow('API key not found');
            repo.findByIdAndUserId.mockResolvedValue({
                id: 'x',
                kind: 'fleet-run',
                isActive: true,
            } as any);
            await expect(service.rotateKey('x', 'user-1')).rejects.toThrow('API key not found');
            repo.findByIdAndUserId.mockResolvedValue({
                id: 'x',
                kind: 'personal',
                isActive: false,
            } as any);
            await expect(service.rotateKey('x', 'user-1')).rejects.toThrow('API key not found');
            await expect(service.rotateKey('x', 'user-1', 169)).rejects.toThrow(
                BadRequestException,
            );
            await expect(service.rotateKey('x', 'user-1', -1)).rejects.toThrow(BadRequestException);
            repo.findByIdAndUserId.mockResolvedValue({
                id: 'x',
                kind: 'personal',
                isActive: true,
                expiresAt: new Date(Date.now() - 1),
            } as any);
            await expect(service.rotateKey('x', 'user-1')).rejects.toThrow(BadRequestException);
            expect(repo.applyRotation).not.toHaveBeenCalled();
        });
    });
});
