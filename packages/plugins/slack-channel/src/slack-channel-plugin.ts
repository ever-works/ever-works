import { IncomingWebhook } from '@slack/webhook';
import type {
	INotificationChannelPlugin,
	ChannelSendInput,
	ChannelSendResult,
	ChannelOptions,
	ChannelTargetConfig,
	ChannelVerification,
	ChannelShape,
	PluginCategory,
	JsonSchema
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';

const SLACK_WEBHOOK_PREFIX = 'https://hooks.slack.com/';

function getWebhookUrl(config: ChannelTargetConfig): string {
	const url = config.webhookUrl;
	if (typeof url !== 'string' || url.length === 0) {
		throw new Error('slack-channel: targetConfig.webhookUrl is required');
	}
	return url;
}

/**
 * Slack notification channel — posts messages to a Slack incoming
 * webhook URL. Block Kit blocks are forwarded when the caller supplies
 * the `slack-blocks` rich payload kind.
 *
 * Built on the official `@slack/webhook` SDK (`IncomingWebhook`) — the
 * vendor SDK for the incoming-webhook mechanism this channel uses
 * (`@slack/web-api` is the bot-token `chat.postMessage` path, a
 * different config contract). Incoming webhooks return the literal
 * string `ok` on success (no message id), so `providerMessageId` is
 * synthesized from the idempotency `messageRef`.
 */
export class SlackChannelPlugin implements INotificationChannelPlugin {
	readonly id = 'slack-channel';
	readonly name = 'Slack';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'notification-channel';
	readonly capabilities = [
		PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL,
		PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL_SLACK
	] as const;
	readonly shape: ChannelShape = 'broadcast';
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			defaultUsername: { type: 'string' },
			defaultIconEmoji: { type: 'string' }
		}
	};

	async onLoad(): Promise<void> {
		// No-op — Slack plugin has no warm-up resources.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
	}

	private readonly idempotencyCache = new Map<string, ChannelSendResult>();

	async verifyTarget(config: ChannelTargetConfig, _options: ChannelOptions): Promise<ChannelVerification> {
		const url = config.webhookUrl;
		if (typeof url !== 'string' || url.length === 0) {
			return { valid: false, message: 'webhookUrl is required' };
		}
		// Slack incoming webhooks reject GET (400) and a POST would post a
		// message, so verification is a URL-shape check. A real round-trip
		// happens on the first "Test" send.
		if (!url.startsWith(SLACK_WEBHOOK_PREFIX)) {
			return {
				valid: false,
				message: `Slack webhook URL must start with ${SLACK_WEBHOOK_PREFIX}`
			};
		}
		return { valid: true, details: { kind: 'incoming-webhook' } };
	}

	async send(payload: ChannelSendInput, options: ChannelOptions): Promise<ChannelSendResult> {
		const cached = this.idempotencyCache.get(payload.messageRef);
		if (cached) return cached;

		const config = payload.target ?? {};
		const webhookUrl = getWebhookUrl(config);
		const username =
			(typeof options.settings?.defaultUsername === 'string' ? options.settings.defaultUsername : undefined) ??
			(typeof config.username === 'string' ? (config.username as string) : undefined);
		const iconEmoji =
			(typeof options.settings?.defaultIconEmoji === 'string' ? options.settings.defaultIconEmoji : undefined) ??
			(typeof config.iconEmoji === 'string' ? (config.iconEmoji as string) : undefined);

		const message: Record<string, unknown> = { text: payload.text };
		if (username) message.username = username;
		if (iconEmoji) message.icon_emoji = iconEmoji;
		if (payload.rich?.kind === 'slack-blocks') {
			message.blocks = payload.rich.payload;
		}

		try {
			await new IncomingWebhook(webhookUrl).send(message);
		} catch (err) {
			const e = err as { message?: string; original?: { response?: { status?: number } } };
			const status = e.original?.response?.status ?? 'error';
			throw new Error(`Slack webhook failed (${status}): ${e.message ?? 'unknown error'}`);
		}
		// Success body is the literal "ok"; no id to capture.
		const result: ChannelSendResult = {
			provider: this.id,
			providerMessageId: `slack-${payload.messageRef}`,
			deliveredAt: new Date()
		};
		this.idempotencyCache.set(payload.messageRef, result);
		if (this.idempotencyCache.size > 500) {
			const firstKey = this.idempotencyCache.keys().next().value;
			if (firstKey) this.idempotencyCache.delete(firstKey);
		}
		return result;
	}
}

export const slackChannelPlugin = new SlackChannelPlugin();
