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

const TELEGRAM_API_BASE = 'https://api.telegram.org';

interface TelegramTarget {
	botToken: string;
	chatId: string;
}

function getTarget(config: ChannelTargetConfig): TelegramTarget {
	const botToken = config.botToken;
	const chatId = config.chatId;
	if (typeof botToken !== 'string' || botToken.length === 0) {
		throw new Error('telegram-channel: targetConfig.botToken is required');
	}
	if (typeof chatId !== 'string' || chatId.length === 0) {
		throw new Error('telegram-channel: targetConfig.chatId is required');
	}
	return { botToken, chatId };
}

interface TelegramSendResponse {
	ok: boolean;
	result?: { message_id: number };
	description?: string;
	error_code?: number;
}

interface TelegramGetMeResponse {
	ok: boolean;
	result?: { id: number; username?: string; first_name?: string };
	description?: string;
}

/**
 * Telegram notification channel — sends via the Bot API `sendMessage`
 * method. `chatId` is the destination chat; discover it by having the
 * user message the bot then reading `getUpdates` (see README).
 *
 * MarkdownV2 is forwarded when the caller supplies the
 * `telegram-markdown` rich payload kind.
 */
export class TelegramChannelPlugin implements INotificationChannelPlugin {
	readonly id = 'telegram-channel';
	readonly name = 'Telegram';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'notification-channel';
	readonly capabilities = [
		PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL,
		PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL_TELEGRAM
	] as const;
	readonly shape: ChannelShape = 'direct';
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			disableNotification: { type: 'boolean' }
		}
	};

	async onLoad(): Promise<void> {
		// No-op — Telegram plugin has no warm-up resources.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
	}

	private readonly idempotencyCache = new Map<string, ChannelSendResult>();

	async verifyTarget(config: ChannelTargetConfig, _options: ChannelOptions): Promise<ChannelVerification> {
		const botToken = config.botToken;
		const chatId = config.chatId;
		if (typeof botToken !== 'string' || botToken.length === 0) {
			return { valid: false, message: 'botToken is required' };
		}
		if (typeof chatId !== 'string' || chatId.length === 0) {
			return { valid: false, message: 'chatId is required' };
		}
		try {
			const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/getMe`, {
				method: 'GET'
			});
			const data = (await response.json()) as TelegramGetMeResponse;
			if (!response.ok || !data.ok) {
				return {
					valid: false,
					message: `Telegram getMe failed: ${data.description ?? response.status}`
				};
			}
			return {
				valid: true,
				details: { botId: data.result?.id, username: data.result?.username }
			};
		} catch (err) {
			return { valid: false, message: err instanceof Error ? err.message : String(err) };
		}
	}

	async send(payload: ChannelSendInput, options: ChannelOptions): Promise<ChannelSendResult> {
		const cached = this.idempotencyCache.get(payload.messageRef);
		if (cached) return cached;

		const { botToken, chatId } = getTarget(payload.target ?? {});
		const disableNotification =
			typeof options.settings?.disableNotification === 'boolean'
				? options.settings.disableNotification
				: undefined;

		const body: Record<string, unknown> = {
			chat_id: chatId,
			text: payload.rich?.kind === 'telegram-markdown' ? payload.rich.payload : payload.text
		};
		if (payload.rich?.kind === 'telegram-markdown') {
			body.parse_mode = 'MarkdownV2';
		}
		if (disableNotification !== undefined) {
			body.disable_notification = disableNotification;
		}

		const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		const data = (await response.json()) as TelegramSendResponse;
		if (!response.ok || !data.ok) {
			throw new Error(
				`Telegram sendMessage failed (${response.status} / ${data.error_code ?? '?'}): ${data.description ?? 'unknown error'}`
			);
		}

		const result: ChannelSendResult = {
			provider: this.id,
			providerMessageId: String(data.result?.message_id ?? `telegram-${payload.messageRef}`),
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

export const telegramChannelPlugin = new TelegramChannelPlugin();
