import { Test } from '@nestjs/testing';
import {
    NotificationChannelFacadeService,
    NotificationChannelFacadeError,
} from '../notification-channel.facade';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { NotificationChannelRepository } from '../../database/repositories/notification-channel.repository';

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
});

/**
 * Codex P2 (PR #1085) — scoping the channel lookup to the caller.
 *
 * Without this, an authenticated user could pass a leaked channel UUID owned
 * by another user and have their text fan out to that user's webhook.
 */
describe('NotificationChannelFacadeService channel-ownership scoping', () => {
    let registry: jest.Mocked<PluginRegistryService>;
    let settings: jest.Mocked<PluginSettingsService>;
    let channels: jest.Mocked<NotificationChannelRepository>;
    let facade: NotificationChannelFacadeService;

    beforeEach(async () => {
        registry = {
            getByCapability: jest.fn().mockReturnValue([]),
        } as unknown as jest.Mocked<PluginRegistryService>;
        settings = {
            getResolvedSettings: jest.fn().mockResolvedValue({}),
        } as unknown as jest.Mocked<PluginSettingsService>;
        channels = {
            findById: jest.fn(),
            findByIdForUser: jest.fn(),
        } as unknown as jest.Mocked<NotificationChannelRepository>;

        const moduleRef = await Test.createTestingModule({
            providers: [
                NotificationChannelFacadeService,
                { provide: PluginRegistryService, useValue: registry },
                { provide: PluginSettingsService, useValue: settings },
                { provide: NotificationChannelRepository, useValue: channels },
            ],
        }).compile();

        facade = moduleRef.get(NotificationChannelFacadeService);
    });

    it('uses findByIdForUser when options.userId is set', async () => {
        channels.findByIdForUser.mockResolvedValue(null);

        const result = await facade.sendDirect(
            'channel-foreign',
            { text: 'pwned', messageRef: 'ref-1' },
            { userId: 'user-1' },
        );

        expect(channels.findByIdForUser).toHaveBeenCalledWith('channel-foreign', 'user-1');
        expect(channels.findById).not.toHaveBeenCalled();
        // Foreign / missing channel is reported as failed without leaking which.
        expect(result.status).toBe('failed');
        expect(result.error).toContain('not found');
    });

    it('returns "not found" failure when the channel exists but belongs to another user', async () => {
        // The user-scoped repo method returns null for "exists but foreign" — the
        // facade must NOT fall back to an unscoped lookup in that case.
        channels.findByIdForUser.mockResolvedValue(null);

        const result = await facade.sendDirect(
            'channel-foreign',
            { text: 'pwned', messageRef: 'ref-1' },
            { userId: 'user-1' },
        );

        expect(result.status).toBe('failed');
        expect(channels.findById).not.toHaveBeenCalled();
    });
});
