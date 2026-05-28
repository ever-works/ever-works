import { Test } from '@nestjs/testing';
import {
    NotificationChannelFacadeService,
    NotificationChannelFacadeError,
    NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER,
} from '../notification-channel.facade';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';

/**
 * EW-672 / T11 — NotificationChannelFacadeService construction + fan-out
 * coverage. Per-plugin behaviour (Discord/Slack/Telegram/…) lives in
 * each plugin package's Vitest suite.
 */
describe('NotificationChannelFacadeService', () => {
    let registry: jest.Mocked<PluginRegistryService>;
    let settings: jest.Mocked<PluginSettingsService>;
    let facade: NotificationChannelFacadeService;

    beforeEach(async () => {
        registry = {
            getByCapability: jest.fn().mockReturnValue([]),
        } as unknown as jest.Mocked<PluginRegistryService>;
        settings = {
            getResolvedSettings: jest.fn().mockResolvedValue({}),
        } as unknown as jest.Mocked<PluginSettingsService>;

        const moduleRef = await Test.createTestingModule({
            providers: [
                NotificationChannelFacadeService,
                { provide: PluginRegistryService, useValue: registry },
                { provide: PluginSettingsService, useValue: settings },
            ],
        }).compile();

        facade = moduleRef.get(NotificationChannelFacadeService);
    });

    it('constructs with required deps only', () => {
        expect(facade).toBeInstanceOf(NotificationChannelFacadeService);
    });

    it('reports unconfigured when no channel providers are registered', () => {
        expect(facade.isConfigured()).toBe(false);
        expect(registry.getByCapability).toHaveBeenCalledWith('notification-channel');
    });

    it('returns empty array when no channels resolve for the user', async () => {
        const results = await facade.send(
            'user-1',
            'work_generation_finished',
            { text: 'done', messageRef: 'ref-1' },
            async () => [],
            { userId: 'user-1' },
        );
        expect(results).toEqual([]);
    });

    it('treats the in-app sentinel channel as a no-op delivered', async () => {
        const results = await facade.send(
            'user-1',
            'work_generation_finished',
            { text: 'done', messageRef: 'ref-1' },
            async () => ['in-app'],
            { userId: 'user-1' },
        );
        expect(results).toEqual([{ channelId: 'in-app', pluginId: 'in-app', status: 'delivered' }]);
    });

    it('fails verifyTarget when no plugin matches', async () => {
        await expect(
            facade.verifyTarget(
                'discord-channel',
                { webhookUrl: 'https://x' },
                { userId: 'user-1' },
            ),
        ).rejects.toBeInstanceOf(NotificationChannelFacadeError);
    });

    it('deliverToChannelOrThrow resolves for the in-app sentinel and throws on failure', async () => {
        // 'in-app' is a no-op delivered sentinel — resolves.
        await expect(
            facade.deliverToChannelOrThrow(
                'in-app',
                { text: 'x', messageRef: 'r' },
                { userId: 'u' },
            ),
        ).resolves.toMatchObject({ status: 'delivered' });

        // No channels repo wired here → sendOne yields a failed result →
        // the throwing variant surfaces it (so Trigger.dev retries).
        await expect(
            facade.deliverToChannelOrThrow(
                'missing',
                { text: 'x', messageRef: 'r' },
                { userId: 'u' },
            ),
        ).rejects.toBeInstanceOf(NotificationChannelFacadeError);
    });

    it('routes event fanout through the delivery dispatcher when bound (returns queued)', async () => {
        const enqueue = jest.fn().mockResolvedValue({ runId: 'run-1' });
        const moduleRef = await Test.createTestingModule({
            providers: [
                NotificationChannelFacadeService,
                { provide: PluginRegistryService, useValue: registry },
                { provide: PluginSettingsService, useValue: settings },
                { provide: NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER, useValue: { enqueue } },
            ],
        }).compile();
        const f = moduleRef.get(NotificationChannelFacadeService);

        const results = await f.send(
            'user-1',
            'work_generation_finished',
            { text: 'done', messageRef: 'ref-1' },
            async () => ['ch-1', 'in-app'],
            { userId: 'user-1' },
        );

        // ch-1 → enqueued (Trigger handles delivery + retry); in-app stays
        // inline as a no-op delivered sentinel.
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(results.find((r) => r.channelId === 'ch-1')).toMatchObject({
            status: 'queued',
            providerMessageId: 'run-1',
        });
        expect(results.find((r) => r.channelId === 'in-app')).toMatchObject({
            status: 'delivered',
        });
    });
});
