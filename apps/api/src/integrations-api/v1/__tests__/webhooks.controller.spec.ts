// The real services pull the agent `services` barrel (ESM-only deps); the
// controller only needs their shapes, which the doubles below provide.
jest.mock('../../../webhooks/webhooks.service', () => ({
    WebhooksService: class WebhooksService {},
}));
jest.mock('../../../webhooks/webhooks-deliveries.service', () => ({
    WebhooksDeliveriesService: class WebhooksDeliveriesService {},
}));
jest.mock('../../../auth/services/integration-key.service', () => ({
    INTEGRATION_KEY_REVOKED_EVENT: 'integration-key.revoked',
}));

import 'reflect-metadata';
import { REQUIRE_SCOPES_KEY } from '../../../auth/integration/integration.decorators';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IntegrationWebhooksController, IntegrationUpdateWebhookDto } from '../webhooks.controller';
import { IntegrationKeyRevokedWebhooksListener } from '../../../webhooks/integration-key-revoked.listener';

/**
 * `/api/integrations/v1/webhooks` (EW-P1-5): subscriptions owned by the
 * integration key, limited to its pinned organizations, invisible to (and
 * from) the account's other webhooks; revoking the key disables them.
 */
describe('IntegrationWebhooksController', () => {
    const principal = {
        keyId: 'key-1',
        keyName: 'Gauzy',
        integrationKind: 'ever-gauzy',
        tenantId: 'tenant-1',
        allowedOrganizationIds: ['org-1', 'org-2'],
        scopes: ['webhooks:manage'],
        ownerUserId: 'owner-1',
        actAsUserId: null,
    };
    const user = { userId: 'owner-1', authMethod: 'integration', integration: principal } as never;
    const view = (overrides: Record<string, unknown> = {}) => ({
        id: 'wh-1',
        accountId: 'owner-1',
        workId: null,
        url: 'https://gauzy.example.com/hooks/ever',
        status: 'active',
        consecutiveFailures: 0,
        lastDeliveryAt: null,
        createdAt: new Date('2026-10-16T10:00:00Z'),
        updatedAt: new Date('2026-10-16T10:00:00Z'),
        version: 2,
        ownerType: 'integration_key',
        events: ['task.*'],
        organizationIds: ['org-1'],
        excludeOriginTags: ['gauzy:conn-1'],
        description: null,
        ...overrides,
    });
    const owner = { type: 'integration_key', id: 'key-1' };

    // Review 2026-10-17 F12: subscribing delivers the change feed, so it needs the
    // feed's scope too; reading, rotating, testing and deleting do not.
    it('requires events:read to create or change a subscription', () => {
        const proto = IntegrationWebhooksController.prototype as unknown as Record<string, object>;
        const scopes = (name: string) => Reflect.getMetadata(REQUIRE_SCOPES_KEY, proto[name]);
        expect(scopes('create')).toEqual(['webhooks:manage', 'events:read']);
        expect(scopes('update')).toEqual(['webhooks:manage', 'events:read']);
        for (const name of ['list', 'rotate', 'test', 'remove']) {
            expect(scopes(name)).toEqual(['webhooks:manage']);
        }
    });

    const setup = () => {
        const webhooks = {
            listForOwner: jest.fn().mockResolvedValue([view()]),
            createV2: jest
                .fn()
                .mockResolvedValue({ subscription: view(), signingSecret: 's'.repeat(40) }),
            findOwnedBy: jest.fn().mockResolvedValue(view()),
            update: jest.fn().mockResolvedValue(view({ status: 'paused' })),
            rotateSecret: jest
                .fn()
                .mockResolvedValue({ subscription: view(), signingSecret: 'n'.repeat(40) }),
            remove: jest.fn().mockResolvedValue(undefined),
        };
        const deliveries = { testFire: jest.fn().mockResolvedValue({ ok: true }) };
        const controller = new IntegrationWebhooksController(
            webhooks as never,
            deliveries as never,
        );
        return { controller, webhooks, deliveries };
    };

    it("lists only this key's subscriptions, as contract DTOs", async () => {
        const { controller, webhooks } = setup();
        const page = await controller.list(user);
        expect(webhooks.listForOwner).toHaveBeenCalledWith('owner-1', owner);
        expect(page.data).toEqual([
            {
                id: 'wh-1',
                url: 'https://gauzy.example.com/hooks/ever',
                description: null,
                events: ['task.*'],
                organizationIds: ['org-1'],
                excludeOriginTags: ['gauzy:conn-1'],
                status: 'active',
                version: 2,
                consecutiveFailures: 0,
                lastDeliveryAt: null,
                createdAt: '2026-10-16T10:00:00.000Z',
                updatedAt: '2026-10-16T10:00:00.000Z',
            },
        ]);
    });

    it('creates a key-owned subscription and returns the secret once', async () => {
        const { controller, webhooks } = setup();
        const dto = await controller.create(user, {
            url: 'https://gauzy.example.com/hooks/ever',
            events: ['task.*'],
            organizationIds: ['org-1'],
            excludeOriginTags: ['gauzy:conn-1'],
        });
        expect(webhooks.createV2).toHaveBeenCalledWith(
            'owner-1',
            expect.objectContaining({ organizationIds: ['org-1'], events: ['task.*'] }),
            owner,
        );
        expect(dto.secret).toHaveLength(40);
    });

    it('refuses an organization the key is not pinned to (403 org_not_pinned)', async () => {
        const { controller, webhooks } = setup();
        await expect(
            controller.create(user, {
                url: 'https://gauzy.example.com/hooks/ever',
                events: ['task.*'],
                organizationIds: ['org-9'],
            }),
        ).rejects.toMatchObject({ code: 'org_not_pinned' });
        await expect(
            controller.update(user, 'wh-1', { organizationIds: ['org-9'] }),
        ).rejects.toMatchObject({ code: 'org_not_pinned' });
        expect(webhooks.createV2).not.toHaveBeenCalled();
        expect(webhooks.update).not.toHaveBeenCalled();
    });

    it('checks ownership before PATCH, rotate, test and delete', async () => {
        const { controller, webhooks, deliveries } = setup();
        await controller.update(user, 'wh-1', { status: 'paused' });
        await controller.rotate(user, 'wh-1');
        await controller.test(user, 'wh-1');
        await controller.remove(user, 'wh-1');
        expect(webhooks.findOwnedBy).toHaveBeenCalledTimes(4);
        expect(webhooks.findOwnedBy).toHaveBeenCalledWith('owner-1', 'wh-1', owner);
        expect(webhooks.update).toHaveBeenCalledWith('owner-1', 'wh-1', { status: 'paused' });
        expect(deliveries.testFire).toHaveBeenCalledWith('owner-1', 'wh-1');
        expect(webhooks.remove).toHaveBeenCalledWith('owner-1', 'wh-1');

        webhooks.findOwnedBy.mockRejectedValueOnce(new Error('Webhook subscription not found'));
        await expect(controller.remove(user, 'wh-other')).rejects.toThrow('not found');
        expect(webhooks.remove).toHaveBeenCalledTimes(1);
    });

    it('PATCH needs at least one field', async () => {
        const { controller } = setup();
        await expect(controller.update(user, 'wh-1', {})).rejects.toMatchObject({
            code: 'validation_failed',
        });
    });
});

describe('IntegrationKeyRevokedWebhooksListener', () => {
    it("disables the revoked key's subscriptions and never throws", async () => {
        const subscriptions = { disableForOwner: jest.fn().mockResolvedValue(2) };
        const listener = new IntegrationKeyRevokedWebhooksListener(subscriptions as never);
        await listener.onRevoked({ keyId: 'key-1', tenantId: 't-1', revokedByUserId: 'u-1' });
        expect(subscriptions.disableForOwner).toHaveBeenCalledWith('integration_key', 'key-1');

        subscriptions.disableForOwner.mockRejectedValueOnce(new Error('db down'));
        await expect(
            listener.onRevoked({ keyId: 'key-2', tenantId: 't-1', revokedByUserId: 'u-1' }),
        ).resolves.toBeUndefined();
    });
});

// Review 2026-10-17 F39: `null` only where the contract allows it (else 400 validation_failed,
// not a NOT NULL write or a `.trim()` on null answering 500).
describe('IntegrationUpdateWebhookDto null fields', () => {
    const properties = async (body: Record<string, unknown>) =>
        (await validate(plainToInstance(IntegrationUpdateWebhookDto, body))).map(
            (error) => error.property,
        );

    it('refuses null on the fields the contract does not make nullable', async () => {
        for (const field of ['url', 'events', 'organizationIds', 'excludeOriginTags', 'status']) {
            expect(await properties({ [field]: null })).toContain(field);
        }
    });

    it('still takes null on the nullable ones, and never validates an absent field', async () => {
        for (const field of ['description']) {
            expect(await properties({ [field]: null })).not.toContain(field);
        }
        expect(await properties({})).toEqual([]);
    });
});
