import { Api } from 'grammy';
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

/** Telegram Bot API errors carry an error_code + description. */
function describeError(err: unknown): { code: number | string; message: string } {
	const e = err as { error_code?: number; description?: string; message?: string };
	return {
		code: e.error_code ?? 'error',
		message: e.description ?? e.message ?? 'unknown error'
	};
}

/**
 * Telegram notification channel — sends via the official `grammy`
 * SDK's lightweight `Api` client (typed Bot API calls, no bot/polling
 * framework). `chatId` is the destination chat; discover it by having
 * the user message the bot then reading `getUpdates` (see README).
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
			const me = await new Api(botToken).getMe();
			return { valid: true, details: { botId: me.id, username: me.username } };
		} catch (err) {
			return { valid: false, message: `Telegram getMe failed: ${describeError(err).message}` };
		}
	}

	async send(payload: ChannelSendInput, options: ChannelOptions): Promise<ChannelSendResult> {
		const cached = this.idempotencyCache.get(payload.messageRef);
		if (cached) return cached;

		const { botToken, chatId } = getTarget(payload.target ?? {});
		const isMarkdown = payload.rich?.kind === 'telegram-markdown';
		const text = isMarkdown ? String(payload.rich.payload) : payload.text;
		const other: { parse_mode?: 'MarkdownV2'; disable_notification?: boolean } = {};
		if (isMarkdown) other.parse_mode = 'MarkdownV2';
		if (typeof options.settings?.disableNotification === 'boolean') {
			other.disable_notification = options.settings.disableNotification;
		}

		let messageId: string;
		try {
			const message = await new Api(botToken).sendMessage(chatId, text, other);
			messageId = String(message.message_id);
		} catch (err) {
			const { code, message } = describeError(err);
			throw new Error(`Telegram sendMessage failed (${code}): ${message}`);
		}

		const result: ChannelSendResult = {
			provider: this.id,
			providerMessageId: messageId,
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
