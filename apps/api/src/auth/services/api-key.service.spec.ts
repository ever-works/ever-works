jest.mock('@ever-works/agent/database', () => ({}));

import { BadRequestException } from '@nestjs/common';
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
            repo.create.mockImplementation(async (input) => ({
                id: 'key-1',
                name: input.name,
                hashedKey: input.hashedKey,
                prefix: input.prefix,
                expiresAt: input.expiresAt,
                createdAt: new Date('2026-05-07'),
                userId: input.userId,
            } as any));

            const result = await service.createKey('user-1', 'CI key');

            expect(repo.create).toHaveBeenCalledTimes(1);
            const createInput = repo.create.mock.calls[0][0];
            expect(createInput.userId).toBe('user-1');
            expect(createInput.name).toBe('CI key');
            expect(createInput.expiresAt).toBeNull();
            expect(createInput.prefix).toBe('ew_live_'.length === 8 ? 'ew_live_' + result.key.substring(8, 12) : '');
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
            repo.create.mockImplementation(async (input) => ({
                id: 'key-2',
                name: input.name,
                hashedKey: input.hashedKey,
                prefix: input.prefix,
                expiresAt: input.expiresAt,
                createdAt: new Date(),
                userId: input.userId,
            } as any));

            const result = await service.createKey('u', 'n', future);

            const createInput = repo.create.mock.calls[0][0];
            expect(createInput.expiresAt).toBeInstanceOf(Date);
            expect((createInput.expiresAt as Date).toISOString()).toBe(future);
            expect(result.expiresAt).toEqual(new Date(future));
        });

        it('generates unique keys across calls', async () => {
            repo.countByUserId.mockResolvedValue(0);
            repo.create.mockImplementation(async (input) => ({
                id: 'k',
                ...input,
                createdAt: new Date(),
            } as any));

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
                expiresAt: new Date(Date.now() - 1000),
            } as any);

            const result = await service.validateKey(RAW);

            expect(result).toBeNull();
            expect(repo.updateLastUsed).not.toHaveBeenCalled();
        });

        it('returns the key and triggers fire-and-forget updateLastUsed when valid', async () => {
            const apiKey = {
                id: 'k-1',
                expiresAt: new Date(Date.now() + 100000),
            };
            repo.findByHashedKey.mockResolvedValue(apiKey as any);

            const result = await service.validateKey(RAW);

            expect(result).toBe(apiKey);
            expect(repo.updateLastUsed).toHaveBeenCalledWith('k-1');
        });

        it('treats null expiresAt as never-expiring', async () => {
            const apiKey = { id: 'k-2', expiresAt: null };
            repo.findByHashedKey.mockResolvedValue(apiKey as any);

            const result = await service.validateKey(RAW);

            expect(result).toBe(apiKey);
            expect(repo.updateLastUsed).toHaveBeenCalledWith('k-2');
        });

        it('swallows updateLastUsed failure (fire-and-forget)', async () => {
            const apiKey = { id: 'k-3', expiresAt: null };
            repo.findByHashedKey.mockResolvedValue(apiKey as any);
            repo.updateLastUsed.mockRejectedValue(new Error('db down'));

            await expect(service.validateKey(RAW)).resolves.toBe(apiKey);
            // Allow microtasks to flush so the catch() runs without an unhandled rejection
            await new Promise((resolve) => setImmediate(resolve));
        });
    });
});
