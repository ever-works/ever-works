jest.mock('@ever-works/agent/database', () => ({ WebhookSubscriptionRepository: class {} }));
jest.mock('@ever-works/agent/entities', () => ({ ApiKey: class ApiKey {} }));
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class {},
    effectiveIntegrationKeyPins: async () => [],
}));

import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/**
 * Review 2026-10-17 F47 / U8: Settings → Integrations → Ever Gauzy lists the subscriptions
 * of every integration key the viewer manages, wherever they are held (a key's
 * subscriptions sit in its creator's account, so the owner's own list missed an admin's).
 */
describe('GET /api/webhooks/integration-keys', () => {
    const view = (id: string, ownerId: string) => ({
        id,
        accountId: 'admin-1',
        workId: null,
        url: 'https://gauzy.example.com/hooks',
        status: 'active',
        consecutiveFailures: 0,
        lastDeliveryAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 2,
        ownerType: 'integration_key',
        ownerId,
        events: ['task.*'],
        organizationIds: ['org-1'],
        excludeOriginTags: [],
        description: null,
    });

    it('answers the subscriptions of the keys the caller manages, in any account', async () => {
        const repo = {
            listForOwner: jest.fn(async (_type: string, keyId: string) =>
                keyId === 'key-admin' ? [view('wh-1', 'key-admin')] : [],
            ),
        };
        const webhooks = new WebhooksService(repo as never, {} as never, {} as never);
        const keys = {
            list: jest.fn().mockResolvedValue([{ id: 'key-admin' }, { id: 'key-owner' }]),
        };
        const controller = new WebhooksController(webhooks, {} as never, keys as never);
        const { subscriptions } = await controller.listForIntegrationKeys({
            userId: 'owner-1',
        } as never);
        expect(keys.list).toHaveBeenCalledWith('owner-1');
        expect(repo.listForOwner).toHaveBeenCalledWith('integration_key', 'key-admin');
        expect(repo.listForOwner).toHaveBeenCalledWith('integration_key', 'key-owner');
        expect(subscriptions.map((sub) => [sub.id, sub.ownerId])).toEqual([['wh-1', 'key-admin']]);
    });

    it('answers nothing when the caller manages no key', async () => {
        const repo = { listForOwner: jest.fn() };
        const controller = new WebhooksController(
            new WebhooksService(repo as never, {} as never, {} as never),
            {} as never,
            { list: jest.fn().mockResolvedValue([]) } as never,
        );
        await expect(
            controller.listForIntegrationKeys({ userId: 'member-1' } as never),
        ).resolves.toEqual({ subscriptions: [] });
        expect(repo.listForOwner).not.toHaveBeenCalled();
    });
});
