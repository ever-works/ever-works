import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PLUGIN_CAPABILITIES, type FacadeOptions } from '@ever-works/plugin';
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
import { redactSecrets } from '../utils/secret-scan';
import { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';
import { BaseFacadeService, FacadeError } from './base.facade';

export class NotificationChannelFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'NotificationChannelFacadeError';
    }
}

/**
 * Security: upper bound on the channel-send error message we log, persist to
 * the delivery_log, and return to callers. Channel plugins can fold an
 * attacker-controlled webhook error-response body into the thrown message, so
 * we truncate to keep stored/returned content bounded.
 */
const MAX_DELIVERY_ERROR_MESSAGE_LENGTH = 500;

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
    /** `queued` = handed to the Trigger.dev delivery task (async outcome). */
    readonly status: 'delivered' | 'failed' | 'queued';
    readonly providerMessageId?: string;
    readonly error?: string;
}

/**
 * Payload handed to the Trigger.dev `notification-channel-delivery`
 * dispatcher. The Trigger task calls back into
 * `deliverToChannelOrThrow` (via the trigger-internal RPC) to perform
 * the actual single attempt under the task's retry policy.
 */
export interface NotificationChannelDeliveryPayload {
    readonly channelId: string;
    readonly text: string;
    readonly rich?: ChannelRichPayload;
    readonly messageRef: string;
    readonly eventType?: string;
    readonly options: FacadeOptions;
    /**
     * ISO-8601 timestamp. When set, the dispatcher schedules the run
     * with a Trigger.dev `delay` so it fires then (quiet-hours deferral).
     */
    readonly deferUntil?: string;
}

/**
 * Producer-side hand-off to Trigger.dev. Bound in apps/api to an
 * adapter over `TriggerService.dispatchNotificationChannelDelivery`;
 * left UNBOUND in dev / when Trigger is disabled, in which case the
 * facade delivers in-process (synchronous fallback).
 */
export interface NotificationChannelDeliveryDispatcher {
    enqueue(payload: NotificationChannelDeliveryPayload): Promise<{ runId: string | null }>;
}

export const NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER =
    'NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER' as const;

/**
 * A channel to fan out to, optionally deferred. `deferUntil` (ISO-8601)
 * is set for channels held by quiet hours — the facade enqueues them on
 * the Trigger.dev delivery task with that `delay`. Plain strings (no
 * deferral) are accepted too for back-compat with simple resolvers.
 */
export interface ResolvedChannelTarget {
    channelId: string;
    deferUntil?: string;
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
 * Per-channel retry uses the Trigger.dev `notification-channel-delivery`
 * task (exponential-backoff `retry` policy; quiet-hours deferral via the
 * run `delay`). Event fanout enqueues through the optional
 * {@link NotificationChannelDeliveryDispatcher}; when it's unbound
 * (dev / Trigger disabled) the facade delivers in-process as a fallback.
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
        @Optional()
        @Inject(NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER)
        private readonly deliveryDispatcher?: NotificationChannelDeliveryDispatcher,
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
        ) => Promise<readonly (string | ResolvedChannelTarget)[]>,
        options: FacadeOptions,
    ): Promise<readonly NotificationChannelFanoutResult[]> {
        const resolved = await resolveChannelIds(userId, eventType);
        if (resolved.length === 0) {
            this.logger.debug(`No channels resolved for user=${userId} event=${eventType}`);
            return [];
        }
        const scopedOptions: FacadeOptions = { ...options, userId };
        const attempts = await Promise.all(
            resolved.map((target) => {
                const { channelId, deferUntil } =
                    typeof target === 'string'
                        ? { channelId: target, deferUntil: undefined }
                        : target;
                return this.dispatchOrSend(
                    channelId,
                    payload,
                    scopedOptions,
                    eventType,
                    deferUntil,
                );
            }),
        );
        return attempts;
    }

    /**
     * Route one channel to the Trigger.dev delivery task when a
     * dispatcher is bound (async, retry-backed); otherwise deliver
     * in-process (fallback). `in-app` always stays inline — it's a
     * no-op sentinel handled by notifications v1.
     */
    private async dispatchOrSend(
        channelId: string,
        payload: NotificationChannelFanoutInput,
        options: FacadeOptions,
        eventType?: string,
        deferUntil?: string,
    ): Promise<NotificationChannelFanoutResult> {
        if (channelId !== 'in-app' && this.deliveryDispatcher) {
            try {
                const { runId } = await this.deliveryDispatcher.enqueue({
                    channelId,
                    text: payload.text,
                    rich: payload.rich,
                    messageRef: payload.messageRef,
                    eventType,
                    options,
                    deferUntil,
                });
                // A null runId means Trigger.dev is disabled / didn't
                // enqueue — fall through to in-process delivery so the
                // notification isn't silently lost. Only a real run id
                // means the delivery is genuinely queued.
                if (runId) {
                    return {
                        channelId,
                        pluginId: 'queued',
                        status: 'queued',
                        providerMessageId: runId,
                    };
                }
            } catch (err) {
                // Enqueue failed — fall back to an in-process attempt so the
                // notification isn't silently lost.
                this.logger.warn(
                    `channel ${channelId} enqueue failed, delivering in-process: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }
        return this.sendOne(channelId, payload, options, eventType);
    }

    /**
     * Send to one specific channel row, bypassing the subscription
     * resolver. Used by the per-channel "Test" button.
     */
    async sendDirect(
        channelId: string,
        payload: NotificationChannelFanoutInput,
        options: FacadeOptions,
    ): Promise<NotificationChannelFanoutResult> {
        // Security: require a caller userId so the channel lookup in sendOne
        // stays owner-scoped (findByIdForUser). Without this, a caller that
        // omits userId falls through to the unscoped findById and could deliver
        // to a leaked/guessed channel UUID owned by another user (IDOR). All
        // legitimate callers already pass userId (FacadeOptions.userId is a
        // required field), so this only rejects malformed/abusive calls.
        if (!options.userId) {
            throw new NotificationChannelFacadeError(
                'sendDirect requires userId in options',
                'sendDirect',
            );
        }
        return this.sendOne(channelId, payload, options, payload.eventType ?? undefined);
    }

    /**
     * Verify a connection config without persisting anything (the
     * add-channel wizard step 3).
     */
    async verifyTarget(
        pluginId: string,
        config: ChannelTargetConfig,
        options: FacadeOptions,
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

    /**
     * Single delivery attempt that THROWS on failure. This is the
     * primitive the Trigger.dev `notification-channel-delivery` task
     * calls (via the trigger-internal RPC) so its `retry` policy re-runs
     * the attempt on failure — whereas `send()`'s parallel fanout uses
     * `sendOne` directly, which swallows per-channel failures so one bad
     * channel doesn't sink its siblings. On terminal retry-exhaustion
     * the delivery-log row left by `sendOne` is the dead-letter.
     */
    async deliverToChannelOrThrow(
        channelId: string,
        payload: NotificationChannelFanoutInput,
        options: FacadeOptions,
        eventType?: string,
    ): Promise<NotificationChannelFanoutResult> {
        // Security: this primitive is invoked by the Trigger.dev delivery task
        // with options deserialized from the enqueued payload. Require a userId
        // so the channel lookup in sendOne stays owner-scoped (findByIdForUser):
        // a payload that omits userId would otherwise fall through to the
        // unscoped findById and deliver to any channel by UUID (IDOR). The
        // producer (send()) always stamps userId onto the dispatched options,
        // so this only rejects a crafted/corrupted payload.
        if (!options.userId) {
            throw new NotificationChannelFacadeError(
                'deliverToChannelOrThrow requires userId in options',
                'deliverToChannelOrThrow',
            );
        }
        const result = await this.sendOne(channelId, payload, options, eventType);
        if (result.status === 'failed') {
            throw new NotificationChannelFacadeError(
                result.error ?? 'channel delivery failed',
                'deliverToChannelOrThrow',
                result.pluginId,
            );
        }
        return result;
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
        // Codex P2 (PR #1085): scope channel lookup to the caller when a userId is
        // available. Otherwise a caller could supply a leaked channel UUID owned by
        // another user and have their text fan out to that user's webhook. We
        // intentionally return the same "not found" shape for "doesn't exist" and
        // "belongs to someone else" so we don't leak channel existence across users.
        const channel = options.userId
            ? await this.channels.findByIdForUser(channelId, options.userId)
            : await this.channels.findById(channelId);
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
            // Security: a channel plugin's send() can wrap an attacker-controlled
            // HTTP error-response body (e.g. a hostile webhook endpoint) into the
            // thrown message. Redact credential-shaped tokens (provider error
            // bodies can echo back the API key / webhook secret that was used),
            // then cap the length before it is logged, persisted to the
            // delivery_log row, and returned in the fanout result to limit
            // log/store bloat and the exfiltration surface. Redaction runs FIRST
            // so truncation can never split a secret into a leaked prefix.
            // Legitimate errors are short and credential-free, so this is
            // behavior-preserving for normal failures.
            const rawErrorMessage = redactSecrets(
                err instanceof Error ? err.message : String(err),
            ).cleaned;
            const errorMessage =
                rawErrorMessage.length > MAX_DELIVERY_ERROR_MESSAGE_LENGTH
                    ? `${rawErrorMessage.slice(0, MAX_DELIVERY_ERROR_MESSAGE_LENGTH)}… [truncated]`
                    : rawErrorMessage;
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
        return this.settingsService.getSettings(pluginId, {
            userId: options.userId,
            workId: options.workId,
            includeSecrets: true,
        });
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
            await this.deliveryLog.save({
                channelId,
                messageRef,
                eventType: eventType ?? null,
                status,
                providerMessageId: result?.providerMessageId ?? null,
                errorMessage: errorMessage ?? null,
                attemptCount: 1,
                deliveredAt: result?.deliveredAt ?? null,
            } as Parameters<typeof this.deliveryLog.save>[0]);
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
            await this.pluginUsageService.record({
                userId: options.userId,
                workId: options.workId,
                agentId: options.agentId,
                taskId: options.taskId,
                pluginId,
                capability: PluginUsageCapability.NOTIFICATION_CHANNEL,
                units: 1,
                costCents: 0,
                metadata: { operation },
            });
        } catch (err) {
            this.logger.warn(`PluginUsageEvent emission failed for ${pluginId}: ${String(err)}`);
        }
    }
}
