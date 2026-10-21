jest.mock('@ever-works/agent/database', () => ({
    WebhookSubscriptionRepository: class {},
}));
jest.mock('@ever-works/agent/entities', () => ({ ApiKey: class ApiKey {} }));
// Security (EW-711 #14): the service now injects WorkOwnershipService to
// authorize work-scoped subscriptions; a class shell keeps the spec from
// pulling the real services barrel (TypeORM repos/entities). The key-pin rule
// (F46) is the real one, from its own file.
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class {},
    effectiveIntegrationKeyPins: jest.requireActual(
        '../../../../packages/agent/src/services/integration-key-pins',
    ).effectiveIntegrationKeyPins,
}));

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ApiKey } from '@ever-works/agent/entities';
import { Tenant } from '../../../../packages/agent/src/entities/tenant.entity';
import { User } from '../../../../packages/agent/src/entities/user.entity';
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
        listForAccount: jest.Mock;
        createV2: jest.Mock;
        updateV2: jest.Mock;
        resume: jest.Mock;
    };
    let secrets: WebhookSecretService;
    let workOwnership: { ensureCanView: jest.Mock };
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
            listForAccount: jest.fn().mockResolvedValue([]),
            createV2: jest.fn().mockImplementation(async (data) => ({
                id: 'wh-2',
                workId: null,
                status: 'active',
                consecutiveFailures: 0,
                lastDeliveryAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                version: 2,
                ...data,
            })),
            updateV2: jest.fn().mockResolvedValue(undefined),
            resume: jest.fn().mockResolvedValue(undefined),
        };
        // Use real secret service in passthrough mode so we can assert
        // the raw secret shape without an encryption key.
        delete process.env.PLATFORM_ENCRYPTION_KEY;
        secrets = new WebhookSecretService();
        // Security (EW-711 #14): ownership gate passes by default so the
        // existing (no-workId / own-workId) flows stay green.
        workOwnership = { ensureCanView: jest.fn().mockResolvedValue({}) };
        service = new WebhooksService(repo as any, secrets, workOwnership as any);
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

        it('rejects plaintext http in non-local envs (HMAC exposure)', async () => {
            // A public, non-private https host so the SSRF guard passes and we
            // isolate the https-only protocol check.
            process.env.NODE_ENV = 'production';
            await expect(
                service.create(ACCOUNT, { url: 'http://hooks.example.com/ingest' }),
            ).rejects.toThrow(BadRequestException);
            await expect(
                service.create(ACCOUNT, { url: 'http://hooks.example.com/ingest' }),
            ).rejects.toThrow(/https/);
        });

        it('accepts https in non-local envs', async () => {
            process.env.NODE_ENV = 'production';
            // Encryption-at-rest is mandatory in prod before a secret can be
            // minted; supply a valid 32-byte (hex) key so the https path
            // reaches a successful create instead of the secret-service guard.
            process.env.PLATFORM_ENCRYPTION_KEY = 'a'.repeat(64);
            service = new WebhooksService(
                repo as any,
                new WebhookSecretService(),
                workOwnership as any,
            );
            await expect(
                service.create(ACCOUNT, { url: 'https://hooks.example.com/ingest' }),
            ).resolves.toBeDefined();
        });

        it('still accepts http in local dev (tunnels)', async () => {
            process.env.NODE_ENV = 'development';
            await expect(
                service.create(ACCOUNT, { url: 'http://hooks.example.com/ingest' }),
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

    // Security (EW-711 #14): create() must authorize a supplied workId via
    // WorkOwnershipService.ensureCanView so a caller can't bind a
    // subscription to a foreign Work and exfiltrate its event stream.
    describe('create — workId ownership (EW-711 #14)', () => {
        const WORK = '11111111-2222-3333-4444-555555555555';

        it('skips the ownership gate when no workId is supplied', async () => {
            await service.create(ACCOUNT, { url: 'https://hooks.example/ingest' });
            expect(workOwnership.ensureCanView).not.toHaveBeenCalled();
        });

        it('authorizes the supplied workId for the caller before persisting', async () => {
            const r = await service.create(ACCOUNT, {
                url: 'https://hooks.example/ingest',
                workId: WORK,
            });
            expect(workOwnership.ensureCanView).toHaveBeenCalledWith(WORK, ACCOUNT);
            expect(r.subscription.workId).toBe(WORK);
        });

        it('masks a foreign workId (Forbidden) as NotFound — no enumeration', async () => {
            workOwnership.ensureCanView.mockRejectedValueOnce(
                new ForbiddenException('You do not have permission to access this work'),
            );
            await expect(
                service.create(ACCOUNT, {
                    url: 'https://hooks.example/ingest',
                    workId: WORK,
                }),
            ).rejects.toThrow(NotFoundException);
            expect(repo.createForAccount).not.toHaveBeenCalled();
        });

        it('propagates NotFound for a nonexistent workId (404-safe)', async () => {
            workOwnership.ensureCanView.mockRejectedValueOnce(
                new NotFoundException(`Work with id '${WORK}' not found`),
            );
            await expect(
                service.create(ACCOUNT, {
                    url: 'https://hooks.example/ingest',
                    workId: WORK,
                }),
            ).rejects.toThrow(NotFoundException);
            expect(repo.createForAccount).not.toHaveBeenCalled();
        });
    });

    describe('listForAccount', () => {
        it('returns canonical views, never includes secretEncrypted', async () => {
            repo.listForAccount.mockResolvedValueOnce([
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

    describe('webhooks v2 (EW-P1-5)', () => {
        const ORG = '11111111-2222-3333-4444-555555555555';
        const TENANT_ID = '99999999-8888-7777-6666-555555555555';
        let users: { findById: jest.Mock };
        let organizations: { findById: jest.Mock };
        const v2Row = (overrides: Record<string, unknown> = {}) => ({
            id: 'wh-2',
            accountId: ACCOUNT,
            workId: null,
            url: 'https://hooks.example.com/ever',
            secretEncrypted: 'enc-old',
            status: 'active',
            consecutiveFailures: 0,
            lastDeliveryAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            version: 2,
            ownerType: 'user',
            events: ['task.*'],
            organizationIds: [ORG],
            excludeOriginTags: [],
            description: null,
            ...overrides,
        });

        beforeEach(() => {
            users = { findById: jest.fn().mockResolvedValue({ id: ACCOUNT, tenantId: TENANT_ID }) };
            organizations = {
                findById: jest
                    .fn()
                    .mockImplementation(async (id: string) =>
                        id === ORG ? { id: ORG, tenantId: TENANT_ID } : null,
                    ),
            };
            service = new WebhooksService(
                repo as any,
                secrets,
                workOwnership as any,
                users as any,
                organizations as any,
            );
        });

        it('creates a user-owned v2 subscription for organizations of the caller tenant', async () => {
            const result = await service.createV2(ACCOUNT, {
                url: 'https://hooks.example.com/ever',
                events: ['task.*', 'team.created', 'task.runtime_updated'],
                organizationIds: [ORG],
                excludeOriginTags: [' gauzy:conn-1 '],
                description: ' Gauzy ',
            });
            expect(repo.createV2).toHaveBeenCalledWith(
                expect.objectContaining({
                    accountId: ACCOUNT,
                    ownerType: 'user',
                    ownerId: ACCOUNT,
                    events: ['task.*', 'team.created', 'task.runtime_updated'],
                    organizationIds: [ORG],
                    excludeOriginTags: ['gauzy:conn-1'],
                    description: 'Gauzy',
                    tenantId: TENANT_ID,
                    organizationId: ORG,
                }),
            );
            expect(result.subscription).toMatchObject({
                version: 2,
                events: ['task.*', 'team.created', 'task.runtime_updated'],
            });
            expect(result.signingSecret.length).toBeGreaterThanOrEqual(32);
        });

        it.each([['tasks.*'], ['task.nope'], ['task'], ['']])(
            'refuses the event filter %j',
            async (pattern) => {
                await expect(
                    service.createV2(ACCOUNT, {
                        url: 'https://hooks.example.com/ever',
                        events: [pattern],
                        organizationIds: [ORG],
                    }),
                ).rejects.toThrow(BadRequestException);
                expect(repo.createV2).not.toHaveBeenCalled();
            },
        );

        it('answers 404 for an organization outside the caller tenant (no enumeration)', async () => {
            await expect(
                service.createV2(ACCOUNT, {
                    url: 'https://hooks.example.com/ever',
                    events: ['*'],
                    organizationIds: ['00000000-0000-0000-0000-000000000001'],
                }),
            ).rejects.toThrow(NotFoundException);
            expect(repo.createV2).not.toHaveBeenCalled();
        });

        it('PATCH status active resumes a paused or failed subscription (v1 and v2)', async () => {
            repo.findById.mockResolvedValue(v2Row({ status: 'failed', consecutiveFailures: 10 }));
            await service.update(ACCOUNT, 'wh-2', { status: 'active' });
            expect(repo.resume).toHaveBeenCalledWith('wh-2');

            repo.findById.mockResolvedValue(v2Row({ version: 1, status: 'paused' }));
            await service.update(ACCOUNT, 'wh-2', { status: 'active' });
            expect(repo.resume).toHaveBeenCalledTimes(2);
        });

        it('refuses to resume a disabled subscription, and v2 fields on a v1 one', async () => {
            repo.findById.mockResolvedValue(v2Row({ status: 'disabled' }));
            await expect(service.update(ACCOUNT, 'wh-2', { status: 'active' })).rejects.toThrow(
                BadRequestException,
            );
            repo.findById.mockResolvedValue(v2Row({ version: 1 }));
            await expect(service.update(ACCOUNT, 'wh-2', { events: ['task.*'] })).rejects.toThrow(
                BadRequestException,
            );
            expect(repo.resume).not.toHaveBeenCalled();
            expect(repo.updateV2).not.toHaveBeenCalled();
        });

        it('refuses to pause a disabled subscription (pause then resume must not revive it)', async () => {
            repo.findById.mockResolvedValue(v2Row({ status: 'disabled' }));
            await expect(service.update(ACCOUNT, 'wh-2', { status: 'paused' })).rejects.toThrow(
                BadRequestException,
            );
            expect(repo.pause).not.toHaveBeenCalled();
        });

        it('resuming counts against the active-subscription limit', async () => {
            repo.findById.mockResolvedValue(v2Row({ status: 'paused' }));
            repo.listActiveForAccount.mockResolvedValueOnce(
                Array.from({ length: 25 }, (_, i) => v2Row({ id: `other-${i}` })),
            );
            await expect(service.update(ACCOUNT, 'wh-2', { status: 'active' })).rejects.toThrow(
                /limit of 25/,
            );
            expect(repo.resume).not.toHaveBeenCalled();
        });

        it('keeps the ownership stamp in step when organizationIds change', async () => {
            const ORG_2 = '22222222-3333-4444-5555-666666666666';
            organizations.findById.mockImplementation(async (id: string) =>
                id === ORG || id === ORG_2 ? { id, tenantId: TENANT_ID } : null,
            );
            repo.findById.mockResolvedValue(v2Row());
            await service.update(ACCOUNT, 'wh-2', { organizationIds: [ORG_2] });
            expect(repo.updateV2).toHaveBeenLastCalledWith('wh-2', {
                organizationIds: [ORG_2],
                organizationId: ORG_2,
                tenantId: TENANT_ID,
            });
            await service.update(ACCOUNT, 'wh-2', { organizationIds: [ORG, ORG_2] });
            expect(repo.updateV2).toHaveBeenLastCalledWith('wh-2', {
                organizationIds: [ORG, ORG_2],
                organizationId: null,
                tenantId: TENANT_ID,
            });
        });

        it('starts a new subscription after the current feed head', async () => {
            const feed = { head: jest.fn().mockResolvedValue('4242') };
            service = new WebhooksService(
                repo as any,
                secrets,
                workOwnership as any,
                users as any,
                organizations as any,
                feed as any,
            );
            await service.createV2(ACCOUNT, {
                url: 'https://hooks.example.com/ever',
                events: ['*'],
                organizationIds: [ORG],
            });
            expect(repo.createV2).toHaveBeenCalledWith(
                expect.objectContaining({ startAfterSeq: '4242' }),
            );
        });

        it('PATCH changes the filters of a v2 subscription', async () => {
            repo.findById.mockResolvedValue(v2Row());
            await service.update(ACCOUNT, 'wh-2', {
                events: ['task.updated'],
                excludeOriginTags: ['gauzy:conn-2'],
                description: null,
            });
            expect(repo.updateV2).toHaveBeenCalledWith('wh-2', {
                events: ['task.updated'],
                excludeOriginTags: ['gauzy:conn-2'],
                description: null,
            });
        });

        // Review 2026-10-17 F46: a key-owned subscription names only the key's pins, from
        // Settings too (contract: a subset of the key's pinned organizations).
        it('PATCH from Settings keeps a key-owned subscription inside the key pins', async () => {
            const OTHER = '22222222-3333-4444-5555-666666666666';
            organizations.findById.mockImplementation(async (id: string) =>
                id === ORG || id === OTHER ? { id, tenantId: TENANT_ID } : null,
            );
            const key = {
                id: 'key-1',
                userId: ACCOUNT,
                tenantId: TENANT_ID,
                organizationIds: [ORG],
            };
            const byEntity = new Map<unknown, unknown>([
                [ApiKey, { findOne: jest.fn().mockResolvedValue(key) }],
                [
                    Tenant,
                    {
                        findOne: jest
                            .fn()
                            .mockResolvedValue({ id: TENANT_ID, ownerUserId: ACCOUNT }),
                    },
                ],
                [
                    User,
                    {
                        findOne: jest.fn().mockResolvedValue({
                            id: ACCOUNT,
                            tenantId: TENANT_ID,
                            isActive: true,
                        }),
                    },
                ],
            ]);
            const manager = { getRepository: (entity: unknown) => byEntity.get(entity) };
            const keyed = new WebhooksService(
                repo as any,
                secrets,
                workOwnership as any,
                users as any,
                organizations as any,
                undefined,
                { ...manager, manager } as any,
            );
            repo.findById.mockResolvedValue(
                v2Row({ ownerType: 'integration_key', ownerId: 'key-1' }),
            );
            await expect(
                keyed.update(ACCOUNT, 'wh-2', { organizationIds: [ORG, OTHER] }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(repo.updateV2).not.toHaveBeenCalled();

            await keyed.update(ACCOUNT, 'wh-2', { organizationIds: [ORG] });
            expect(repo.updateV2).toHaveBeenCalledWith(
                'wh-2',
                expect.objectContaining({ organizationIds: [ORG] }),
            );
        });

        it('rotating a v2 secret keeps the previous one signing for the grace window', async () => {
            repo.findById.mockResolvedValue(v2Row());
            const before = Date.now();
            await service.rotateSecret(ACCOUNT, 'wh-2');
            const [, , previous] = repo.updateSecret.mock.calls[0];
            expect(previous.secretEncrypted).toBe('enc-old');
            expect(previous.expiresAt.getTime()).toBeGreaterThanOrEqual(
                before + 23 * 60 * 60 * 1000,
            );

            repo.updateSecret.mockClear();
            repo.findById.mockResolvedValue(v2Row({ version: 1 }));
            await service.rotateSecret(ACCOUNT, 'wh-2');
            expect(repo.updateSecret.mock.calls[0]).toHaveLength(2);
        });
    });
});
