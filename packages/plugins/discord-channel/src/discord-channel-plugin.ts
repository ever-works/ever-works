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
// SSRF guard: the webhook URL is fully user-supplied. isSafeWebhookUrl rejects
// private/loopback/link-local/metadata hosts lexically; safeFetchWithDnsPin
// re-checks after DNS resolution to mitigate DNS rebinding. Mirrors
// WebhookDeliveryService and the content-extractor plugins.
import { isSafeWebhookUrl, safeFetchWithDnsPin } from '@ever-works/plugin/helpers/ssrf-guard';

// Discord webhooks always live on these hosts. Constraining to them turns the
// "any URL the user pastes" SSRF oracle (verifyTarget echoes the upstream JSON
// id/channel_id/name; send POSTs an attacker-controlled body) into a no-op for
// non-Discord targets, on top of the generic SSRF guard below.
const DISCORD_WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);

function isDiscordWebhookHost(host: string): boolean {
	const normalized = host.toLowerCase();
	if (DISCORD_WEBHOOK_HOSTS.has(normalized)) return true;
	// Accept regional/CDN-style subdomains of the canonical Discord domains.
	return normalized.endsWith('.discord.com') || normalized.endsWith('.discordapp.com');
}

function getWebhookUrl(config: ChannelTargetConfig): string {
	const url = config.webhookUrl;
	if (typeof url !== 'string' || url.length === 0) {
		throw new Error('discord-channel: targetConfig.webhookUrl is required');
	}
	// Reject SSRF-unsafe hosts (private/loopback/link-local/cloud-metadata) and
	// any non-Discord host before the URL ever reaches fetch.
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error('discord-channel: targetConfig.webhookUrl is not a valid URL');
	}
	if (!isSafeWebhookUrl(url) || !isDiscordWebhookHost(parsed.hostname)) {
		throw new Error('discord-channel: targetConfig.webhookUrl must be a Discord webhook URL');
	}
	return url;
}

/**
 * Discord notification channel — posts messages to a Discord webhook
 * URL. Bot-token mode (POST /channels/:id/messages) lands in a future
 * iteration; v1 is webhook-only since the operator UX is simpler
 * (paste a URL vs register a bot app).
 */
export class DiscordChannelPlugin implements INotificationChannelPlugin {
	readonly id = 'discord-channel';
	readonly name = 'Discord';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'notification-channel';
	readonly capabilities = [
		PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL,
		PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL_DISCORD
	] as const;
	readonly shape: ChannelShape = 'broadcast';
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			defaultUsername: { type: 'string' },
			defaultAvatarUrl: { type: 'string' }
		}
	};

	async onLoad(): Promise<void> {
		// No-op — Discord plugin has no warm-up resources.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
	}

	private readonly idempotencyCache = new Map<string, ChannelSendResult>();

	async verifyTarget(config: ChannelTargetConfig, _options: ChannelOptions): Promise<ChannelVerification> {
		try {
			const url = getWebhookUrl(config);
			// Discord webhook URLs return 200 with the webhook metadata on GET.
			// safeFetchWithDnsPin re-checks the SSRF guard and refuses any host
			// that resolves to a private/metadata IP before the socket connect.
			const response = await safeFetchWithDnsPin(url, { method: 'GET' });
			if (!response.ok) {
				return {
					valid: false,
					message: `Discord webhook returned ${response.status}`
				};
			}
			const data = (await response.json()) as { id?: string; channel_id?: string; name?: string };
			return {
				valid: true,
				details: { id: data.id, channelId: data.channel_id, name: data.name }
			};
		} catch (err) {
			return {
				valid: false,
				message: err instanceof Error ? err.message : String(err)
			};
		}
	}

	async send(payload: ChannelSendInput, options: ChannelOptions): Promise<ChannelSendResult> {
		const cached = this.idempotencyCache.get(payload.messageRef);
		if (cached) return cached;

		const config = payload.target ?? {};
		const webhookUrl = getWebhookUrl(config);
		const username =
			(typeof options.settings?.defaultUsername === 'string' ? options.settings.defaultUsername : undefined) ??
			(typeof config.username === 'string' ? (config.username as string) : undefined);
		const avatarUrl =
			(typeof options.settings?.defaultAvatarUrl === 'string' ? options.settings.defaultAvatarUrl : undefined) ??
			(typeof config.avatarUrl === 'string' ? (config.avatarUrl as string) : undefined);

		const body: Record<string, unknown> = {
			content: payload.text,
			username,
			avatar_url: avatarUrl
		};
		if (payload.rich?.kind === 'discord-embeds') {
			body.embeds = payload.rich.payload;
		}

		// Append wait=true so Discord returns the message id back.
		const url = `${webhookUrl}${webhookUrl.includes('?') ? '&' : '?'}wait=true`;
		// safeFetchWithDnsPin re-applies the SSRF guard (host already constrained
		// to Discord by getWebhookUrl) and pins against DNS-rebinding.
		const response = await safeFetchWithDnsPin(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`Discord webhook failed (${response.status}): ${text}`);
		}
		const data = (await response.json().catch(() => ({}))) as { id?: string };
		const result: ChannelSendResult = {
			provider: this.id,
			providerMessageId: data.id ?? `discord-${payload.messageRef}`,
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

export const discordChannelPlugin = new DiscordChannelPlugin();
