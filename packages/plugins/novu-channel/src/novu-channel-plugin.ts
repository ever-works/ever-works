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
// Security (SSRF): `apiBase` is tenant-controlled plugin settings that flows
// verbatim into every outbound fetch (carrying the Novu API key in an
// `Authorization: ApiKey …` header). Validate the resolved URL with the shared
// lexical SSRF guard before fetching so a malicious base (e.g.
// http://169.254.169.254 IMDS, http://10.0.0.1, http://127.0.0.1:6379, or a
// non-HTTP(S) scheme) can't redirect the request — and the bearer key — at an
// internal endpoint and leak its response back through the error path. Mirrors
// the make-client / zapier tenant-baseUrl guards.
import { isSafeWebhookUrl } from '@ever-works/plugin/helpers/ssrf-guard';

const DEFAULT_NOVU_API_BASE = 'https://api.novu.co';

/**
 * Security (header injection): `messageRef` is the idempotency key set on the
 * outbound Novu `Idempotency-Key` request header. HTTP header values must not
 * contain CR/LF or other control characters — a value carrying a CRLF could
 * inject additional request headers on fetch implementations that don't reject
 * them. Legitimate idempotency keys are short ASCII tokens, so reject any value
 * containing a C0 control char (code points 0–31, which includes CR=13 / LF=10)
 * or DEL (127) before it reaches the header (and the in-memory cache key).
 *
 * Implemented as a code-point scan (not a regex with literal control chars) so
 * the check is unambiguous and avoids embedding raw control bytes in source.
 */
function assertSafeMessageRef(messageRef: string): string {
	if (typeof messageRef !== 'string') {
		throw new Error('novu-channel: messageRef must be a string');
	}
	for (let i = 0; i < messageRef.length; i++) {
		const code = messageRef.charCodeAt(i);
		if (code <= 31 || code === 127) {
			throw new Error(
				'novu-channel: messageRef contains control characters and cannot be used as an Idempotency-Key'
			);
		}
	}
	return messageRef;
}

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

	/**
	 * Security (SSRF): build the absolute Novu API URL from the
	 * tenant-controlled `apiBase` and reject it if the destination host is a
	 * literal private/loopback/link-local/cloud-metadata IP or a non-HTTP(S)
	 * scheme before any request (and the API key) leaves the process. Mirrors
	 * `MakeClient.buildUrl()`.
	 */
	private safeNovuUrl(options: ChannelOptions, path: string): string {
		const url = `${this.apiBase(options)}${path}`;
		if (!isSafeWebhookUrl(url)) {
			throw new Error('novu-channel: apiBase is not safe to call (SSRF guard blocked the destination host)');
		}
		return url;
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
			// Security (SSRF): `apiBase` is tenant-controlled — guard the destination
			// host before sending the key (see isSafeWebhookUrl import note).
			const response = await fetch(this.safeNovuUrl(options, '/v1/environments/me'), {
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
		// Security (header injection): reject control chars in the idempotency key
		// before it is used as a header value or cache key.
		const messageRef = assertSafeMessageRef(payload.messageRef);
		// Security (tenant isolation): scope the idempotency cache key by the
		// channel binding — a bare messageRef would let one tenant's send
		// short-circuit (and return the cached ChannelSendResult of) another
		// tenant's send that happened to reuse the same ref.
		const cacheKey = `${options.channelId ?? ''}:${messageRef}`;
		const cached = this.idempotencyCache.get(cacheKey);
		if (cached) return cached;

		const { apiKey, workflowId, subscriberId } = getTarget(payload.target ?? {});

		const triggerPayload: Record<string, unknown> = { text: payload.text };
		if (payload.rich?.kind === 'novu-payload' && payload.rich.payload) {
			Object.assign(triggerPayload, payload.rich.payload as Record<string, unknown>);
		}

		// Security (SSRF): `apiBase` is tenant-controlled — guard the destination
		// host before sending the key (see isSafeWebhookUrl import note).
		const response = await fetch(this.safeNovuUrl(options, '/v1/events/trigger'), {
			method: 'POST',
			headers: {
				Authorization: `ApiKey ${apiKey}`,
				'Content-Type': 'application/json',
				'Idempotency-Key': messageRef
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
		this.idempotencyCache.set(cacheKey, result);
		if (this.idempotencyCache.size > 500) {
			const firstKey = this.idempotencyCache.keys().next().value;
			if (firstKey) this.idempotencyCache.delete(firstKey);
		}
		return result;
	}
}

export const novuChannelPlugin = new NovuChannelPlugin();
