import type { IPlugin } from '../plugin.interface.js';
import type { PluginPricing } from '../pricing.types.js';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * Notifications v2 — Notification Channels (sibling of EW-650).
 *
 * Plugins that fan notifications out to chat / messaging surfaces
 * (Discord, Slack, Telegram, WhatsApp, Novu, …) implement
 * `INotificationChannelPlugin` and declare the umbrella
 * `NOTIFICATION_CHANNEL` capability plus the channel-specific
 * `NOTIFICATION_CHANNEL_DISCORD` / `_SLACK` / etc. constant.
 *
 * See `docs/specs/features/notification-channels/spec.md` §3 for the
 * canonical contract description. The in-app channel is built in
 * to the platform (no separate plugin package) but implements this
 * same interface for symmetry.
 *
 * Email is a separate surface — it has tenant-owned addresses +
 * inbound webhooks and lives in `email-provider.interface.ts`.
 */

/**
 * Per-call attribution + facade-resolved settings handed to every
 * channel plugin call. Mirrors `EmailOptions`.
 */
export interface ChannelOptions {
	readonly userId?: string;
	readonly workId?: string;
	readonly agentId?: string;
	readonly taskId?: string;
	/**
	 * The notification-channels record id this call is bound to —
	 * the facade looks up `targetConfig` from this row before
	 * invoking `send`. Plugins MAY use it as a logging tag.
	 */
	readonly channelId?: string;
	/**
	 * Resolved settings handed in by `NotificationChannelFacadeService`.
	 * Plugins should use these instead of their stored defaults.
	 */
	readonly settings?: PluginSettings;
}

/**
 * Per-tenant connection config for a channel. Per-plugin shape —
 * `discord` uses `{ webhookUrl }` or `{ botToken, channelId }`,
 * `slack` uses `{ webhookUrl }` or `{ botToken, channelId }`, etc.
 * Stored opaquely on `notification_channels.targetConfig` and
 * handed back to the plugin on every send.
 */
export type ChannelTargetConfig = Readonly<Record<string, unknown>>;

/**
 * Outcome of a one-off connection-verification call (e.g. the
 * "Test" button on the channel settings row). Mirrors the
 * `ScreenshotValidationResult` shape — `valid` + optional message.
 */
export interface ChannelVerification {
	readonly valid: boolean;
	readonly message?: string;
	/** Provider-specific metadata returned by the verification probe. */
	readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Discriminated union for rich, channel-specific content. The text
 * fallback is always set; `rich` is opt-in for channels that
 * support it. Plugins MAY ignore `rich` if the shape doesn't match
 * their channel.
 */
export type ChannelRichPayload =
	| { readonly kind: 'discord-embeds'; readonly payload: unknown }
	| { readonly kind: 'slack-blocks'; readonly payload: unknown }
	| { readonly kind: 'telegram-markdown'; readonly payload: string }
	| { readonly kind: 'whatsapp-template'; readonly payload: unknown }
	| { readonly kind: 'novu-payload'; readonly payload: unknown };

/**
 * Canonical attribution sub-object on every send. Mirrors what
 * `PluginUsageEvent` ultimately persists.
 */
export interface ChannelSendAttribution {
	readonly userId: string;
	readonly agentId?: string;
	readonly taskId?: string;
	readonly workId?: string;
	/** From `event-subscriptions` — what event triggered this send. */
	readonly eventType?: string;
}

/**
 * Canonical send input — handed to every channel plugin.
 */
export interface ChannelSendInput {
	/** Plain-text fallback (always set). */
	readonly text: string;
	/** Optional channel-specific rich content. */
	readonly rich?: ChannelRichPayload;
	/**
	 * Idempotency key. Plugins MUST de-dupe on this value so a
	 * BullMQ retry doesn't double-post a Discord embed.
	 */
	readonly messageRef: string;
	readonly attribution: ChannelSendAttribution;
	/**
	 * Optional resolved target config (webhook URL, bot token, …)
	 * for the specific channel row. The facade fills this from
	 * `notification_channels.targetConfig` so plugins never load
	 * from the DB directly.
	 */
	readonly target?: ChannelTargetConfig;
}

export interface ChannelSendResult {
	readonly provider: string;
	readonly providerMessageId: string;
	readonly deliveredAt?: Date;
}

export interface ChannelDeliveryEvent {
	readonly provider: string;
	readonly providerMessageId: string;
	readonly type: 'delivered' | 'read' | 'clicked' | 'failed';
	readonly occurredAt: Date;
	readonly raw?: Readonly<Record<string, unknown>>;
}

export interface ChannelEventFilter {
	readonly providerMessageId?: string;
	readonly since?: Date;
	readonly until?: Date;
	readonly limit?: number;
}

/**
 * Channel-shape categorisation — drives UI hints (a "broadcast"
 * channel renders as a chip with channel name; a "direct" channel
 * shows the recipient). Workflow channels (Novu) delegate
 * routing to the external system.
 */
export type ChannelShape = 'broadcast' | 'direct' | 'workflow';

/**
 * Notification-channel plugin contract.
 *
 * Implementations declare `PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL`
 * (umbrella) plus the channel-specific constant
 * (`NOTIFICATION_CHANNEL_DISCORD` etc.).
 */
export interface INotificationChannelPlugin extends IPlugin {
	readonly shape: ChannelShape;

	/**
	 * Validate the per-tenant connection config (webhook URL is
	 * reachable, bot token has post permissions, novu workflow
	 * exists). Called by the "Test" button + the add-wizard step 3.
	 */
	verifyTarget(
		config: ChannelTargetConfig,
		options: ChannelOptions,
	): Promise<ChannelVerification>;

	/**
	 * Deliver one notification payload. MUST be idempotent on
	 * `payload.messageRef`.
	 */
	send(payload: ChannelSendInput, options: ChannelOptions): Promise<ChannelSendResult>;

	/**
	 * Optional: surface delivery events. Plugins that can't observe
	 * them (e.g. plain Discord webhook) MAY omit this.
	 */
	listDeliveryEvents?(
		filter: ChannelEventFilter,
		options: ChannelOptions,
	): AsyncGenerator<ChannelDeliveryEvent>;

	/**
	 * Optional per-send pricing for spend roll-ups. Most chat
	 * channels are free; WhatsApp Business is metered, Novu has
	 * its own pricing tiers.
	 */
	getPricing?(): PluginPricing | Promise<PluginPricing>;
}

/**
 * Type guard — narrow an `IPlugin` to `INotificationChannelPlugin`
 * via the umbrella capability declaration.
 */
export function isNotificationChannelPlugin(
	plugin: IPlugin,
): plugin is INotificationChannelPlugin {
	return plugin.capabilities.includes('notification-channel');
}
