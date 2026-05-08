jest.mock('@ever-works/agent/database', () => ({}));

import { NotFoundException } from '@nestjs/common';
import { ApiKeysController } from './api-keys.controller';
import type { ApiKeyService } from '../services/api-key.service';

describe('ApiKeysController', () => {
    let controller: ApiKeysController;
    let service: jest.Mocked<Pick<ApiKeyService, 'createKey' | 'listKeys' | 'revokeKey'>>;

    beforeEach(() => {
        service = {
            createKey: jest.fn(),
            listKeys: jest.fn(),
            revokeKey: jest.fn(),
        } as any;
        controller = new ApiKeysController(service as unknown as ApiKeyService);
    });

    describe('create (POST /api/auth/api-keys)', () => {
        it('forwards userId, name, expiresAt and returns service result', async () => {
            const created = { id: 'k1', key: 'ew_live_abc', name: 'My key' };
            service.createKey.mockResolvedValue(created as any);
            const req = { user: { userId: 'u1' } };

            const result = await controller.create(req, {
                name: 'My key',
                expiresAt: '2099-01-01T00:00:00.000Z',
            } as any);

            expect(service.createKey).toHaveBeenCalledWith(
                'u1',
                'My key',
                '2099-01-01T00:00:00.000Z',
            );
            expect(result).toBe(created);
        });

        it('passes undefined expiresAt when not in dto', async () => {
            service.createKey.mockResolvedValue({} as any);
            const req = { user: { userId: 'u1' } };

            await controller.create(req, { name: 'no-expiry' } as any);

            expect(service.createKey).toHaveBeenCalledWith('u1', 'no-expiry', undefined);
        });

        it('propagates service errors (e.g. 10-key cap BadRequest)', async () => {
            const err = new Error('Maximum of 10 API keys allowed per user');
            service.createKey.mockRejectedValue(err);

            await expect(
                controller.create({ user: { userId: 'u1' } }, { name: 'n' } as any),
            ).rejects.toBe(err);
        });
    });

    describe('list (GET /api/auth/api-keys)', () => {
        it('forwards userId and returns the array', async () => {
            const keys = [{ id: 'k1' }, { id: 'k2' }];
            service.listKeys.mockResolvedValue(keys as any);

            const result = await controller.list({ user: { userId: 'u1' } });

            expect(service.listKeys).toHaveBeenCalledWith('u1');
            expect(result).toBe(keys);
        });

        it('returns empty array verbatim from service', async () => {
            service.listKeys.mockResolvedValue([] as any);

            const result = await controller.list({ user: { userId: 'u1' } });

            expect(result).toEqual([]);
        });

        it('propagates service errors', async () => {
            service.listKeys.mockRejectedValue(new Error('db down'));

            await expect(controller.list({ user: { userId: 'u1' } })).rejects.toThrow('db down');
        });
    });

    describe('revoke (DELETE /api/auth/api-keys/:id)', () => {
        it('returns success message when service deletes the key', async () => {
            service.revokeKey.mockResolvedValue(true as any);

            const result = await controller.revoke({ user: { userId: 'u1' } }, 'k1');

            expect(service.revokeKey).toHaveBeenCalledWith('k1', 'u1');
            expect(result).toEqual({ message: 'API key revoked successfully' });
        });

        it('throws NotFoundException when service returns false', async () => {
            service.revokeKey.mockResolvedValue(false as any);

            await expect(controller.revoke({ user: { userId: 'u1' } }, 'missing')).rejects.toThrow(
                new NotFoundException('API key not found'),
            );
        });

        it('forwards positional args (id BEFORE userId — owner check happens server-side)', async () => {
            service.revokeKey.mockResolvedValue(true as any);

            await controller.revoke({ user: { userId: 'owner-user' } }, 'key-id');

            // Important: revokeKey signature is (keyId, userId), NOT (userId, keyId).
            // The controller must NOT swap them — that would let any user revoke any key.
            expect(service.revokeKey).toHaveBeenCalledWith('key-id', 'owner-user');
        });

        it('propagates non-NotFound service errors verbatim', async () => {
            const err = new Error('connection lost');
            service.revokeKey.mockRejectedValue(err);

            await expect(controller.revoke({ user: { userId: 'u1' } }, 'k1')).rejects.toBe(err);
        });
    });
});
