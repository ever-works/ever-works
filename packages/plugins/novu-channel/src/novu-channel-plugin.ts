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

const DEFAULT_NOVU_API_BASE = 'https://api.novu.co';

interface NovuTarget {
	apiKey: string;
	workflowId: string;
	subscriberId: string;
}

function getTarget(config: ChannelTargetConfig): NovuTarget {
	const apiKey = config.apiKey;
	const workflowId = config.workflowId;
	const subscriberId = config.subscriberId;
	if (typeof apiKey !== 'string' || apiKey.length === 0) {
		throw new Error('novu-channel: targetConfig.apiKey is required');
	}
	if (typeof workflowId !== 'string' || workflowId.length === 0) {
		throw new Error('novu-channel: targetConfig.workflowId is required');
	}
	if (typeof subscriberId !== 'string' || subscriberId.length === 0) {
		throw new Error('novu-channel: targetConfig.subscriberId is required');
	}
	return { apiKey, workflowId, subscriberId };
}

interface NovuTriggerResponse {
	data?: { transactionId?: string; acknowledged?: boolean; status?: string };
	message?: string;
	statusCode?: number;
}

/**
 * Novu notification channel — delegates to a Novu workflow via the
 * Trigger API (raw fetch; no `@novu/node` runtime dep). Novu fans the
 * event out across its own configured channel steps (in-app, email,
 * SMS, push, chat), so this plugin's `shape` is `workflow`.
 *
 * The `text` plus any `novu-payload` rich content is merged into the
 * trigger `payload`, available to the workflow's step templates.
 */
export class NovuChannelPlugin implements INotificationChannelPlugin {
	readonly id = 'novu-channel';
	readonly name = 'Novu';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'notification-channel';
	readonly capabilities = [
		PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL,
		PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL_NOVU
	] as const;
	readonly shape: ChannelShape = 'workflow';
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiBase: { type: 'string' }
		}
	};

	async onLoad(): Promise<void> {
		// No-op — Novu plugin has no warm-up resources.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
	}

	private readonly idempotencyCache = new Map<string, ChannelSendResult>();

	private apiBase(options: ChannelOptions): string {
		const base = options.settings?.apiBase;
		return typeof base === 'string' && base.length > 0 ? base.replace(/\/+$/, '') : DEFAULT_NOVU_API_BASE;
	}

	async verifyTarget(config: ChannelTargetConfig, options: ChannelOptions): Promise<ChannelVerification> {
		const apiKey = config.apiKey;
		if (typeof apiKey !== 'string' || apiKey.length === 0) {
			return { valid: false, message: 'apiKey is required' };
		}
		if (typeof config.workflowId !== 'string' || config.workflowId.length === 0) {
			return { valid: false, message: 'workflowId is required' };
		}
		if (typeof config.subscriberId !== 'string' || config.subscriberId.length === 0) {
			return { valid: false, message: 'subscriberId is required' };
		}
		try {
			const response = await fetch(`${this.apiBase(options)}/v1/environments/me`, {
				method: 'GET',
				headers: { Authorization: `ApiKey ${apiKey}` }
			});
			if (!response.ok) {
				const data = (await response.json().catch(() => ({}))) as { message?: string };
				return {
					valid: false,
					message: `Novu API key check failed: ${data.message ?? response.status}`
				};
			}
			const data = (await response.json().catch(() => ({}))) as {
				data?: { name?: string; _id?: string };
			};
			return { valid: true, details: { environment: data.data?.name, envId: data.data?._id } };
		} catch (err) {
			return { valid: false, message: err instanceof Error ? err.message : String(err) };
		}
	}

	async send(payload: ChannelSendInput, options: ChannelOptions): Promise<ChannelSendResult> {
		const cached = this.idempotencyCache.get(payload.messageRef);
		if (cached) return cached;

		const { apiKey, workflowId, subscriberId } = getTarget(payload.target ?? {});

		const triggerPayload: Record<string, unknown> = { text: payload.text };
		if (payload.rich?.kind === 'novu-payload' && payload.rich.payload) {
			Object.assign(triggerPayload, payload.rich.payload as Record<string, unknown>);
		}

		const response = await fetch(`${this.apiBase(options)}/v1/events/trigger`, {
			method: 'POST',
			headers: {
				Authorization: `ApiKey ${apiKey}`,
				'Content-Type': 'application/json',
				'Idempotency-Key': payload.messageRef
			},
			body: JSON.stringify({
				name: workflowId,
				to: { subscriberId },
				payload: triggerPayload
			})
		});
		const data = (await response.json().catch(() => ({}))) as NovuTriggerResponse;
		if (!response.ok || !data.data?.transactionId) {
			throw new Error(`Novu trigger failed (${response.status}): ${data.message ?? 'no transactionId returned'}`);
		}

		const result: ChannelSendResult = {
			provider: this.id,
			providerMessageId: data.data.transactionId,
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

export const novuChannelPlugin = new NovuChannelPlugin();
