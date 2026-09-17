import { Test } from '@nestjs/testing';
import {
    BUILT_IN_EMAIL_CHANNEL_ID,
    NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER,
    NotificationChannelFacadeError,
    NotificationChannelFacadeService,
} from '../notification-channel.facade';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { NotificationChannelRepository } from '../../database/repositories/notification-channel.repository';
import { NotificationChannelDeliveryLogRepository } from '../../database/repositories/notification-channel-delivery-log.repository';
import {
    NOTIFICATION_EMAIL_SENDER,
    type NotificationEmailSender,
} from '../../notifications/notification-email-sender.port';

/**
 * Attention controls (AW-13) — the built-in `email` delivery target.
 *
 * Email to the account's own address is a sentinel like `in-app`: it never
 * touches `notification_channels`, it records every attempt in the same
 * delivery log as chat channels, and it fails loudly (never a silent success)
 * when it cannot send.
 */
describe('NotificationChannelFacadeService — built-in email target', () => {
    const payload = {
        text: 'Agent needs a decision: pick a database',
        messageRef: 'agent_run_escalated-user-1-1',
        content: {
            title: 'Agent needs a decision',
            message: 'Pick a database',
            actionUrl: '/tasks/t-1',
            actionLabel: 'Review',
        },
    };

    let channels: { findByIdForUser: jest.Mock; findById: jest.Mock };
    let deliveryLog: { save: jest.Mock };
    let sender: { deliver: jest.Mock };

    async function build(
        extra: Array<{ provide: unknown; useValue: unknown }> = [],
        withSender = true,
    ) {
        const providers: any[] = [
            NotificationChannelFacadeService,
            {
                provide: PluginRegistryService,
                useValue: { getByCapability: jest.fn().mockReturnValue([]) },
            },
            { provide: PluginSettingsService, useValue: { getSettings: jest.fn() } },
            { provide: NotificationChannelRepository, useValue: channels },
            { provide: NotificationChannelDeliveryLogRepository, useValue: deliveryLog },
            ...extra,
        ];
        if (withSender) {
            providers.push({ provide: NOTIFICATION_EMAIL_SENDER, useValue: sender });
        }
        const moduleRef = await Test.createTestingModule({ providers }).compile();
        return moduleRef.get(NotificationChannelFacadeService);
    }

    beforeEach(() => {
        channels = { findByIdForUser: jest.fn(), findById: jest.fn() };
        deliveryLog = { save: jest.fn().mockResolvedValue(undefined) };
        sender = {
            deliver: jest
                .fn<ReturnType<NotificationEmailSender['deliver']>, any>()
                .mockResolvedValue({
                    status: 'delivered',
                    providerMessageId: 'mail-1',
                }),
        };
    });

    it('delivers through the sender with the structured content and never reads a channel row', async () => {
        const facade = await build();
        const results = await facade.send(
            'user-1',
            'agent_run_escalated',
            payload,
            async () => [BUILT_IN_EMAIL_CHANNEL_ID],
            { userId: 'user-1' },
        );

        expect(results).toEqual([
            {
                channelId: 'email',
                pluginId: 'email',
                status: 'delivered',
                providerMessageId: 'mail-1',
            },
        ]);
        expect(sender.deliver).toHaveBeenCalledWith({
            userId: 'user-1',
            eventKey: 'agent_run_escalated',
            title: 'Agent needs a decision',
            message: 'Pick a database',
            actionUrl: '/tasks/t-1',
            actionLabel: 'Review',
        });
        expect(channels.findByIdForUser).not.toHaveBeenCalled();
        expect(channels.findById).not.toHaveBeenCalled();
    });

    it('records the attempt as a built-in row: no channel, the owning user, the built-in name', async () => {
        const facade = await build();
        await facade.send('user-1', 'agent_run_escalated', payload, async () => ['email'], {
            userId: 'user-1',
        });

        expect(deliveryLog.save).toHaveBeenCalledTimes(1);
        expect(deliveryLog.save.mock.calls[0][0]).toMatchObject({
            channelId: null,
            builtInChannel: 'email',
            userId: 'user-1',
            messageRef: payload.messageRef,
            eventType: 'agent_run_escalated',
            status: 'delivered',
            providerMessageId: 'mail-1',
        });
    });

    it('falls back to the plain text when a caller sends no structured content', async () => {
        const facade = await build();
        await facade.send(
            'user-1',
            'inbox_notice',
            { text: 'Inbox notice: hello', messageRef: 'r' },
            async () => ['email'],
            { userId: 'user-1' },
        );
        expect(sender.deliver.mock.calls[0][0]).toMatchObject({
            title: 'Inbox notice: hello',
            message: 'Inbox notice: hello',
        });
    });

    it('fails with a stated reason, and logs the failure, when no sender is bound', async () => {
        const facade = await build([], false);
        const [result] = await facade.send(
            'user-1',
            'agent_run_escalated',
            payload,
            async () => ['email'],
            { userId: 'user-1' },
        );
        expect(result).toEqual({
            channelId: 'email',
            pluginId: 'email',
            status: 'failed',
            error: 'email sender not configured',
        });
        expect(deliveryLog.save.mock.calls[0][0]).toMatchObject({
            builtInChannel: 'email',
            status: 'failed',
            errorMessage: 'email sender not configured',
        });
    });

    it('turns a transport exception into a failed result with a redacted, bounded error', async () => {
        sender.deliver.mockRejectedValue(new Error('SMTP 421 ' + 'x'.repeat(900)));
        const facade = await build();
        const [result] = await facade.send(
            'user-1',
            'agent_run_escalated',
            payload,
            async () => ['email'],
            { userId: 'user-1' },
        );
        expect(result.status).toBe('failed');
        expect(result.error?.length).toBeLessThan(600);
        expect(result.error).toContain('[truncated]');
    });

    it('throws from the retry primitive on a transient failure so the delivery task retries it', async () => {
        sender.deliver.mockResolvedValue({ status: 'failed', error: 'connection reset' });
        const facade = await build();
        await expect(
            facade.deliverToChannelOrThrow(
                'email',
                payload,
                { userId: 'user-1' },
                'agent_run_escalated',
            ),
        ).rejects.toBeInstanceOf(NotificationChannelFacadeError);
    });

    it.each(['not-configured', 'address-unverified', 'no-address'])(
        'does not retry a terminal %s failure, but still reports it as failed',
        async (reason) => {
            sender.deliver.mockResolvedValue(
                reason === 'not-configured'
                    ? { status: 'not-configured', error: reason }
                    : { status: 'failed', error: reason },
            );
            const facade = await build();
            await expect(
                facade.deliverToChannelOrThrow(
                    'email',
                    payload,
                    { userId: 'user-1' },
                    'agent_run_escalated',
                ),
            ).resolves.toMatchObject({ channelId: 'email', status: 'failed', error: reason });
        },
    );

    it('refuses to email without a user to address it to', async () => {
        const facade = await build();
        await expect(
            facade.deliverToChannelOrThrow('email', payload, {} as any, 'agent_run_escalated'),
        ).rejects.toBeInstanceOf(NotificationChannelFacadeError);
        expect(sender.deliver).not.toHaveBeenCalled();
    });

    it('hands email to the delivery dispatcher with its content when one is bound', async () => {
        const enqueue = jest.fn().mockResolvedValue({ runId: 'run-9' });
        const facade = await build([
            { provide: NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER, useValue: { enqueue } },
        ]);
        const [result] = await facade.send(
            'user-1',
            'agent_run_escalated',
            payload,
            async () => [{ channelId: 'email', deferUntil: '2026-09-15T07:00:00.000Z' }],
            { userId: 'user-1' },
        );
        expect(result).toMatchObject({ channelId: 'email', status: 'queued' });
        expect(enqueue.mock.calls[0][0]).toMatchObject({
            channelId: 'email',
            content: payload.content,
            deferUntil: '2026-09-15T07:00:00.000Z',
            options: { userId: 'user-1' },
        });
        expect(sender.deliver).not.toHaveBeenCalled();
    });

    it('stamps the owning user on chat channel delivery rows too', async () => {
        channels.findByIdForUser.mockResolvedValue({
            id: 'ch-1',
            userId: 'user-1',
            pluginId: 'discord-channel',
            disabledAt: null,
            targetConfig: {},
        });
        const facade = await build();
        await facade.send('user-1', 'generation_error', payload, async () => ['ch-1'], {
            userId: 'user-1',
        });
        // The plugin is not registered here, so the attempt fails — and the
        // failure row still carries the channel and the user.
        expect(deliveryLog.save.mock.calls[0][0]).toMatchObject({
            channelId: 'ch-1',
            builtInChannel: null,
            userId: 'user-1',
            status: 'failed',
        });
    });
});
