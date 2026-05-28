import type {
	INotificationChannelPlugin,
	ChannelSendInput,
	ChannelSendResult,
	ChannelOptions,
	ChannelTargetConfig,
	ChannelVerification,
	ChannelShape,
	PluginCategory,
	JsonSchema,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';

const GRAPH_API_BASE = 'https://graph.facebook.com';
const DEFAULT_API_VERSION = 'v21.0';

interface WhatsappTarget {
	accessToken: string;
	phoneNumberId: string;
	to: string;
}

function getTarget(config: ChannelTargetConfig): WhatsappTarget {
	const accessToken = config.accessToken;
	const phoneNumberId = config.phoneNumberId;
	const to = config.to;
	if (typeof accessToken !== 'string' || accessToken.length === 0) {
		throw new Error('whatsapp-channel: targetConfig.accessToken is required');
	}
	if (typeof phoneNumberId !== 'string' || phoneNumberId.length === 0) {
		throw new Error('whatsapp-channel: targetConfig.phoneNumberId is required');
	}
	if (typeof to !== 'string' || to.length === 0) {
		throw new Error('whatsapp-channel: targetConfig.to (recipient) is required');
	}
	return { accessToken, phoneNumberId, to };
}

interface WhatsappSendResponse {
	messages?: { id: string }[];
	error?: { message: string; code: number };
}

/**
 * WhatsApp notification channel — sends via the WhatsApp Business
 * Cloud API.
 *
 * WhatsApp enforces a 24-hour customer-service window: free-form `text`
 * messages are only deliverable within 24h of the user's last message.
 * Outside that window you MUST send a pre-approved `template`. Callers
 * that need guaranteed delivery should supply the `whatsapp-template`
 * rich payload kind; plain `text` is best-effort (in-window).
 */
export class WhatsappChannelPlugin implements INotificationChannelPlugin {
	readonly id = 'whatsapp-channel';
	readonly name = 'WhatsApp';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'notification-channel';
	readonly capabilities = [
		PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL,
		PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL_WHATSAPP,
	] as const;
	readonly shape: ChannelShape = 'direct';
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiVersion: { type: 'string' },
		},
	};

	async onLoad(): Promise<void> {
		// No-op — WhatsApp plugin has no warm-up resources.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
	}

	private readonly idempotencyCache = new Map<string, ChannelSendResult>();

	private apiVersion(options: ChannelOptions): string {
		const v = options.settings?.apiVersion;
		return typeof v === 'string' && v.length > 0 ? v : DEFAULT_API_VERSION;
	}

	async verifyTarget(
		config: ChannelTargetConfig,
		options: ChannelOptions,
	): Promise<ChannelVerification> {
		const accessToken = config.accessToken;
		const phoneNumberId = config.phoneNumberId;
		if (typeof accessToken !== 'string' || accessToken.length === 0) {
			return { valid: false, message: 'accessToken is required' };
		}
		if (typeof phoneNumberId !== 'string' || phoneNumberId.length === 0) {
			return { valid: false, message: 'phoneNumberId is required' };
		}
		if (typeof config.to !== 'string' || config.to.length === 0) {
			return { valid: false, message: 'to (recipient) is required' };
		}
		try {
			const response = await fetch(
				`${GRAPH_API_BASE}/${this.apiVersion(options)}/${phoneNumberId}`,
				{ method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
			);
			const data = (await response.json()) as {
				id?: string;
				display_phone_number?: string;
				error?: { message: string };
			};
			if (!response.ok || data.error) {
				return {
					valid: false,
					message: `WhatsApp number check failed: ${data.error?.message ?? response.status}`,
				};
			}
			return {
				valid: true,
				details: { phoneNumberId: data.id, displayPhoneNumber: data.display_phone_number },
			};
		} catch (err) {
			return { valid: false, message: err instanceof Error ? err.message : String(err) };
		}
	}

	async send(payload: ChannelSendInput, options: ChannelOptions): Promise<ChannelSendResult> {
		const cached = this.idempotencyCache.get(payload.messageRef);
		if (cached) return cached;

		const { accessToken, phoneNumberId, to } = getTarget(payload.target ?? {});

		const body: Record<string, unknown> =
			payload.rich?.kind === 'whatsapp-template'
				? {
						messaging_product: 'whatsapp',
						to,
						type: 'template',
						template: payload.rich.payload,
					}
				: {
						messaging_product: 'whatsapp',
						to,
						type: 'text',
						text: { body: payload.text },
					};

		const response = await fetch(
			`${GRAPH_API_BASE}/${this.apiVersion(options)}/${phoneNumberId}/messages`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${accessToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			},
		);
		const data = (await response.json()) as WhatsappSendResponse;
		if (!response.ok || data.error || !data.messages?.length) {
			throw new Error(
				`WhatsApp send failed (${response.status}): ${data.error?.message ?? 'no message id returned'}`,
			);
		}

		const result: ChannelSendResult = {
			provider: this.id,
			providerMessageId: data.messages[0].id,
			deliveredAt: new Date(),
		};
		this.idempotencyCache.set(payload.messageRef, result);
		if (this.idempotencyCache.size > 500) {
			const firstKey = this.idempotencyCache.keys().next().value;
			if (firstKey) this.idempotencyCache.delete(firstKey);
		}
		return result;
	}
}

export const whatsappChannelPlugin = new WhatsappChannelPlugin();
