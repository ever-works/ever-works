import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    PLUGIN_CAPABILITIES,
    type FacadeOptions,
} from '@ever-works/plugin';
import {
    isNotificationChannelPlugin,
    type INotificationChannelPlugin,
    type ChannelSendInput,
    type ChannelSendResult,
    type ChannelOptions,
    type ChannelVerification,
    type ChannelTargetConfig,
    type ChannelRichPayload,
} from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { NotificationChannelRepository } from '../database/repositories/notification-channel.repository';
import { NotificationChannelDeliveryLogRepository } from '../database/repositories/notification-channel-delivery-log.repository';
import { PluginUsageService } from '../usage/plugin-usage.service';
import { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';
import { BaseFacadeService, FacadeError } from './base.facade';

export class NotificationChannelFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'NotificationChannelFacadeError';
    }
}

export interface NotificationChannelFanoutInput {
    readonly text: string;
    readonly rich?: ChannelRichPayload;
    readonly messageRef: string;
    /** From event-subscriptions resolver; NULL for ad-hoc / "Test" button sends. */
    readonly eventType?: string;
}

export interface NotificationChannelFanoutResult {
    readonly channelId: string;
    readonly pluginId: string;
    readonly status: 'delivered' | 'failed';
    readonly providerMessageId?: string;
    readonly error?: string;
}

/**
 * NotificationChannelFacadeService — fan-out point for multi-channel
 * notification delivery. Mirrors `EmailFacadeService` shape but for the
 * `NOTIFICATION_CHANNEL` umbrella capability.
 *
 * See [`docs/specs/features/notification-channels/spec.md`](../../../../docs/specs/features/notification-channels/spec.md) §3.3.
 *
 * Two entry points:
 * - `send(userId, eventType, payload)` — resolves the user's enabled
 *   channels for the event (via `event-subscriptions`, EW-664) and fans
 *   out in parallel. Failed channels do NOT block siblings.
 * - `sendDirect(channelId, payload)` — bypass the resolver, send to one
 *   specific channel. Used by the "Test" button on settings.
 *
 * Per-attempt side effects:
 * - Persists a `notification_channel_delivery_log` row (idempotent on `messageRef`).
 * - Emits a `PluginUsageEvent` with `capability='notification_channel'`.
 *
 * Per-channel retry uses BullMQ (queue `notification-channel-retry`, 3
 * attempts exp-backoff, 24h dead-letter) — wired in T12 with the
 * controller layer.
 */
@Injectable()
export class NotificationChannelFacadeService extends BaseFacadeService {
    protected readonly logger = new Logger(NotificationChannelFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() workPluginRepository?: WorkPluginRepository,
        @Optional() private readonly channels?: NotificationChannelRepository,
        @Optional() private readonly deliveryLog?: NotificationChannelDeliveryLogRepository,
        @Optional() private readonly pluginUsageService?: PluginUsageService,
    ) {
        super(registry, settingsService, workPluginRepository);
    }

    /**
     * Resolve the user's subscribed channels for `eventType` and fan
     * out the notification to each in parallel. The subscription
     * resolver (EW-664) is consumed via a lightweight callback so this
     * facade doesn't take a hard dep on the event-subscriptions module.
     */
    async send(
        userId: string,
        eventType: string,
        payload: NotificationChannelFanoutInput,
        resolveChannelIds: (
            userId: string,
            eventType: string,
        ) => Promise<readonly string[]>,
        options: FacadeOptions = {},
    ): Promise<readonly NotificationChannelFanoutResult[]> {
        const channelIds = await resolveChannelIds(userId, eventType);
        if (channelIds.length === 0) {
            this.logger.debug(`No channels resolved for user=${userId} event=${eventType}`);
            return [];
        }
        const attempts = await Promise.all(
            channelIds.map((channelId) =>
                this.sendOne(channelId, payload, { ...options, userId }, eventType),
            ),
        );
        return attempts;
    }

    /**
     * Send to one specific channel row, bypassing the subscription
     * resolver. Used by the per-channel "Test" button.
     */
    async sendDirect(
        channelId: string,
        payload: NotificationChannelFanoutInput,
        options: FacadeOptions = {},
    ): Promise<NotificationChannelFanoutResult> {
        return this.sendOne(channelId, payload, options, payload.eventType ?? undefined);
    }

    /**
     * Verify a connection config without persisting anything (the
     * add-channel wizard step 3).
     */
    async verifyTarget(
        pluginId: string,
        config: ChannelTargetConfig,
        options: FacadeOptions = {},
    ): Promise<ChannelVerification> {
        const plugin = this.getChannelPluginById(pluginId);
        const settings = await this.resolveSettings(pluginId, options);
        return plugin.verifyTarget(config, {
            userId: options.userId,
            workId: options.workId,
            agentId: options.agentId,
            taskId: options.taskId,
            settings,
        });
    }

    private async sendOne(
        channelId: string,
        payload: NotificationChannelFanoutInput,
        options: FacadeOptions,
        eventType?: string,
    ): Promise<NotificationChannelFanoutResult> {
        // 'in-app' is a sentinel — built-in channel, no row, no plugin call.
        if (channelId === 'in-app') {
            this.logger.debug(`in-app channel — handled by notifications v1, no-op here`);
            return { channelId, pluginId: 'in-app', status: 'delivered' };
        }
        if (!this.channels) {
            return {
                channelId,
                pluginId: 'unknown',
                status: 'failed',
                error: 'channels repository not injected',
            };
        }
        const channel = await this.channels.findOne({ where: { id: channelId } });
        if (!channel) {
            return {
                channelId,
                pluginId: 'unknown',
                status: 'failed',
                error: `channel ${channelId} not found`,
            };
        }
        if (channel.disabledAt) {
            return {
                channelId,
                pluginId: channel.pluginId,
                status: 'failed',
                error: 'channel disabled',
            };
        }

        try {
            const plugin = this.getChannelPluginById(channel.pluginId);
            const settings = await this.resolveSettings(channel.pluginId, options);
            const channelOpts: ChannelOptions = {
                userId: options.userId,
                workId: options.workId,
                agentId: options.agentId,
                taskId: options.taskId,
                channelId,
                settings,
            };
            const sendInput: ChannelSendInput = {
                text: payload.text,
                rich: payload.rich,
                messageRef: payload.messageRef,
                attribution: {
                    userId: options.userId ?? channel.userId,
                    agentId: options.agentId,
                    taskId: options.taskId,
                    workId: options.workId,
                    eventType,
                },
                target: channel.targetConfig as ChannelTargetConfig,
            };
            const result: ChannelSendResult = await plugin.send(sendInput, channelOpts);

            await this.logDelivery(channelId, payload.messageRef, eventType, 'delivered', result);
            await this.recordUsage(channel.pluginId, 'send', options);

            return {
                channelId,
                pluginId: channel.pluginId,
                status: 'delivered',
                providerMessageId: result.providerMessageId,
            };
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            this.logger.warn(`channel ${channelId} send failed: ${errorMessage}`);
            await this.logDelivery(
                channelId,
                payload.messageRef,
                eventType,
                'failed',
                undefined,
                errorMessage,
            );
            return {
                channelId,
                pluginId: channel.pluginId,
                status: 'failed',
                error: errorMessage,
            };
        }
    }

    private getChannelPluginById(pluginId: string): INotificationChannelPlugin {
        const registered = this.registry
            .getByCapability(this.CAPABILITY)
            .find((p) => p.plugin.id === pluginId && p.state === 'loaded');
        if (!registered || !isNotificationChannelPlugin(registered.plugin)) {
            throw new NotificationChannelFacadeError(
                `Notification channel plugin not found or disabled: ${pluginId}`,
                'send',
                pluginId,
            );
        }
        return registered.plugin;
    }

    private async resolveSettings(
        pluginId: string,
        options: FacadeOptions,
    ): Promise<Record<string, unknown> | undefined> {
        if (!this.settingsService) return undefined;
        return this.settingsService.getResolvedSettings(pluginId, options.userId, options.workId);
    }

    private async logDelivery(
        channelId: string,
        messageRef: string,
        eventType: string | undefined,
        status: 'delivered' | 'failed',
        result?: ChannelSendResult,
        errorMessage?: string,
    ): Promise<void> {
        if (!this.deliveryLog) return;
        try {
            await this.deliveryLog.save(
                this.deliveryLog.create({
                    channelId,
                    messageRef,
                    eventType: eventType ?? null,
                    status,
                    providerMessageId: result?.providerMessageId ?? null,
                    errorMessage: errorMessage ?? null,
                    attemptCount: 1,
                    deliveredAt: result?.deliveredAt ?? null,
                }),
            );
        } catch (err) {
            this.logger.warn(`delivery log persist failed: ${String(err)}`);
        }
    }

    private async recordUsage(
        pluginId: string,
        operation: string,
        options: FacadeOptions,
    ): Promise<void> {
        if (!this.pluginUsageService || !options.userId) return;
        try {
            await this.pluginUsageService.recordUsage({
                userId: options.userId,
                workId: options.workId,
                agentId: options.agentId,
                taskId: options.taskId,
                pluginId,
                capability: PluginUsageCapability.NOTIFICATION_CHANNEL,
                operation,
                units: 1,
                costCents: 0,
            });
        } catch (err) {
            this.logger.warn(`PluginUsageEvent emission failed for ${pluginId}: ${String(err)}`);
        }
    }
}
