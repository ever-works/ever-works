jest.mock('@ever-works/agent/database', () => ({
    WebhookSubscriptionRepository: class {},
}));
jest.mock('@ever-works/agent/entities', () => ({}));

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { WebhookSecretService } from './webhook-secret.service';

describe('WebhooksService', () => {
    let repo: {
        listActiveForAccount: jest.Mock;
        createForAccount: jest.Mock;
        findById: jest.Mock;
        pause: jest.Mock;
        updateSecret: jest.Mock;
        delete: jest.Mock;
    };
    let secrets: WebhookSecretService;
    let service: WebhooksService;
    const ACCOUNT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const SAVED_NODE_ENV = process.env.NODE_ENV;

    beforeEach(() => {
        repo = {
            listActiveForAccount: jest.fn().mockResolvedValue([]),
            createForAccount: jest.fn().mockImplementation(async (data) => ({
                id: 'wh-1',
                accountId: data.accountId,
                workId: data.workId,
                url: data.url,
                secretEncrypted: data.secretEncrypted,
                status: 'active',
                consecutiveFailures: 0,
                lastDeliveryAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
            })),
            findById: jest.fn(),
            pause: jest.fn().mockResolvedValue(undefined),
            updateSecret: jest.fn().mockResolvedValue(undefined),
            delete: jest.fn().mockResolvedValue(undefined),
        };
        // Use real secret service in passthrough mode so we can assert
        // the raw secret shape without an encryption key.
        delete process.env.PLATFORM_ENCRYPTION_KEY;
        secrets = new WebhookSecretService();
        service = new WebhooksService(repo as any, secrets);
    });

    afterEach(() => {
        process.env.NODE_ENV = SAVED_NODE_ENV;
        delete process.env.PLATFORM_ENCRYPTION_KEY;
    });

    describe('create — URL validation', () => {
        it('accepts https URLs and returns view + raw secret ONCE', async () => {
            const r = await service.create(ACCOUNT, { url: 'https://hooks.example/ingest' });
            expect(r.subscription.id).toBe('wh-1');
            expect(r.subscription.url).toBe('https://hooks.example/ingest');
            expect(r.subscription.status).toBe('active');
            // Raw secret matches the generator's shape.
            expect(r.signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
            // The persisted secret is NOT the raw value (in passthrough
            // mode they happen to be equal; in production they are not).
            expect(repo.createForAccount).toHaveBeenCalledWith(
                expect.objectContaining({
                    accountId: ACCOUNT,
                    url: 'https://hooks.example/ingest',
                    workId: null,
                }),
            );
        });

        it('accepts http URLs in non-production', async () => {
            await expect(
                service.create(ACCOUNT, { url: 'http://hooks.example/ingest' }),
            ).resolves.toBeDefined();
        });

        it('rejects non-http(s) schemes', async () => {
            await expect(service.create(ACCOUNT, { url: 'javascript:alert(1)' })).rejects.toThrow(
                BadRequestException,
            );
            await expect(service.create(ACCOUNT, { url: 'file:///etc/passwd' })).rejects.toThrow(
                BadRequestException,
            );
            await expect(service.create(ACCOUNT, { url: 'not-a-url' })).rejects.toThrow(
                BadRequestException,
            );
        });

        it('rejects loopback/private URLs in production (SSRF defense)', async () => {
            process.env.NODE_ENV = 'production';
            for (const url of [
                'http://localhost/ingest',
                'http://127.0.0.1/ingest',
                'http://10.0.0.1/ingest',
                'http://192.168.1.5/ingest',
                'http://172.16.0.1/ingest',
                'http://169.254.169.254/latest/meta-data/', // AWS metadata
            ]) {
                await expect(service.create(ACCOUNT, { url })).rejects.toThrow(ForbiddenException);
            }
        });

        it('allows loopback URLs in dev/test (so devs can use ngrok / webhook.site)', async () => {
            process.env.NODE_ENV = 'development';
            await expect(
                service.create(ACCOUNT, { url: 'http://localhost:4000/ingest' }),
            ).resolves.toBeDefined();
        });

        it('enforces per-account cap (25)', async () => {
            const rows = Array.from({ length: 25 }, (_, i) => ({ id: `wh-${i}` }));
            repo.listActiveForAccount.mockResolvedValueOnce(rows as any);
            await expect(
                service.create(ACCOUNT, { url: 'https://hooks.example/ingest' }),
            ).rejects.toThrow(/per-account limit of 25/);
        });
    });

    describe('listForAccount', () => {
        it('returns canonical views, never includes secretEncrypted', async () => {
            repo.listActiveForAccount.mockResolvedValueOnce([
                {
                    id: 'wh-1',
                    accountId: ACCOUNT,
                    workId: null,
                    url: 'https://x.test',
                    secretEncrypted: 'should-not-appear',
                    status: 'active',
                    consecutiveFailures: 0,
                    lastDeliveryAt: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                },
            ]);
            const rows = await service.listForAccount(ACCOUNT);
            expect(rows.length).toBe(1);
            const flat = JSON.stringify(rows[0]);
            expect(flat).not.toContain('should-not-appear');
            expect(flat).not.toContain('secretEncrypted');
        });
    });

    describe('cross-account access — pretend-404 (no enumeration)', () => {
        it("pause() on another account's row returns NotFound, not Forbidden", async () => {
            repo.findById.mockResolvedValueOnce({
                id: 'wh-other',
                accountId: 'someone-else',
                status: 'active',
            });
            await expect(service.pause(ACCOUNT, 'wh-other')).rejects.toThrow(NotFoundException);
            expect(repo.pause).not.toHaveBeenCalled();
        });

        it("remove() on another account's row returns NotFound, not Forbidden", async () => {
            repo.findById.mockResolvedValueOnce({
                id: 'wh-other',
                accountId: 'someone-else',
            });
            await expect(service.remove(ACCOUNT, 'wh-other')).rejects.toThrow(NotFoundException);
            expect(repo.delete).not.toHaveBeenCalled();
        });

        it("rotateSecret() on another account's row returns NotFound", async () => {
            repo.findById.mockResolvedValueOnce({
                id: 'wh-other',
                accountId: 'someone-else',
            });
            await expect(service.rotateSecret(ACCOUNT, 'wh-other')).rejects.toThrow(
                NotFoundException,
            );
            expect(repo.updateSecret).not.toHaveBeenCalled();
        });
    });

    describe('rotateSecret', () => {
        it('writes a new encrypted secret and returns the new RAW value ONCE', async () => {
            const original = {
                id: 'wh-1',
                accountId: ACCOUNT,
                workId: null,
                url: 'https://x.test',
                secretEncrypted: 'old-encrypted',
                status: 'active',
                consecutiveFailures: 0,
                lastDeliveryAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            repo.findById.mockResolvedValueOnce(original);
            repo.findById.mockResolvedValueOnce({ ...original, secretEncrypted: 'new-encrypted' });

            const result = await service.rotateSecret(ACCOUNT, 'wh-1');

            expect(result.signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(repo.updateSecret).toHaveBeenCalledWith('wh-1', expect.any(String));
            // The persisted encrypted value MUST be different from the
            // old one (we just rotated).
            const writtenEncrypted = repo.updateSecret.mock.calls[0][1] as string;
            expect(writtenEncrypted).not.toBe('old-encrypted');
        });
    });
});
