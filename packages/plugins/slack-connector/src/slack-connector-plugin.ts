import { WebClient } from '@slack/web-api';
import type { ChatPostMessageArguments, ChatPostMessageResponse } from '@slack/web-api';
import type {
	IConnectorPlugin,
	ConnectorMetadata,
	ConnectorCallOptions,
	ChannelSendInput,
	ChannelSendResult,
	ChannelTargetConfig,
	ChannelVerification,
	PluginCategory,
	JsonSchema
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';

/**
 * Resolve the bot token from a connector's target config. Slack bot
 * tokens are `xoxb-…`; the `@slack/web-api` `WebClient` pins the host
 * to `slack.com`, so there is no SSRF surface (unlike the webhook-URL
 * `slack-channel` plugin).
 */
function getBotToken(config: ChannelTargetConfig): string {
	const token = config.botToken;
	if (typeof token !== 'string' || token.length === 0) {
		throw new Error('slack-connector: targetConfig.botToken is required');
	}
	return token;
}

/**
 * Resolve the destination channel id. A per-send `channelId` overrides
 * the connection's `defaultChannelId`; the resolved plugin `settings`
 * default is the final fallback.
 */
function resolveChannel(config: ChannelTargetConfig, options: ConnectorCallOptions): string {
	const candidates = [config.channelId, config.defaultChannelId, options.settings?.defaultChannelId];
	for (const c of candidates) {
		if (typeof c === 'string' && c.length > 0) return c;
	}
	throw new Error('slack-connector: a channel id is required (targetConfig.defaultChannelId or channelId)');
}

/** Extract a readable message from a `@slack/web-api` error. */
function slackErrorMessage(err: unknown): string {
	const e = err as { code?: string; data?: { error?: string }; message?: string };
	return e.data?.error ?? e.code ?? e.message ?? 'unknown error';
}

/**
 * Slack connector — a first-party BIDIRECTIONAL connector. This
 * increment implements the OUTBOUND leg: it posts messages to a Slack
 * channel with a bot token via `chat.postMessage` on the official
 * `@slack/web-api` SDK (distinct from `slack-channel`'s incoming-webhook
 * `@slack/webhook` path — a connector is a superset of a channel).
 *
 * Inbound (Slack Events API: `verifyInbound` HMAC-SHA256 over
 * `v0:{ts}:{rawBody}`, `handleChallenge` for `url_verification`,
 * `parseInbound` → route to an Agent, `reply` into the thread) is a
 * follow-up (P2) — the `signingSecret` setting is captured now so the
 * connection is inbound-ready. Metadata therefore declares
 * `direction: 'outbound'` with `inbound`/`reply`/`pairing` flags off
 * until that runtime lands.
 *
 * See `docs/specs/features/connectors/spec.md` §7.5.1.
 */
export class SlackConnectorPlugin implements IConnectorPlugin {
	readonly id = 'slack-connector';
	readonly name = 'Slack Connector';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'connector';
	readonly capabilities = [PLUGIN_CAPABILITIES.CONNECTOR, PLUGIN_CAPABILITIES.CONNECTOR_SLACK] as const;

	readonly connector: ConnectorMetadata = {
		direction: 'outbound',
		transport: 'webhook',
		flags: {
			outboundMessage: true,
			outboundRecord: false,
			inbound: false,
			reply: false,
			pairing: false,
			richOutbound: true
		}
	};

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		required: ['botToken'],
		properties: {
			botToken: {
				type: 'string',
				title: 'Bot User OAuth token (xoxb-…)',
				'x-secret': true,
				'x-envVar': 'SLACK_BOT_TOKEN'
			},
			signingSecret: {
				type: 'string',
				title: 'Signing secret (for inbound Events API — used in a follow-up)',
				'x-secret': true,
				'x-envVar': 'SLACK_SIGNING_SECRET'
			},
			appId: { type: 'string', title: 'Slack app id' },
			defaultChannelId: { type: 'string', title: 'Default channel id (e.g. C0123456789)' }
		}
	};

	private readonly idempotencyCache = new Map<string, ChannelSendResult>();

	async onLoad(): Promise<void> {
		// No-op — no warm-up resources; a WebClient is created per send.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
	}

	async verifyConnection(config: ChannelTargetConfig, _options: ConnectorCallOptions): Promise<ChannelVerification> {
		const token = config.botToken;
		if (typeof token !== 'string' || token.length === 0) {
			return { valid: false, message: 'botToken is required' };
		}
		try {
			const res = await new WebClient(token).auth.test();
			return {
				valid: true,
				details: {
					teamId: res.team_id,
					team: res.team,
					botUserId: res.user_id,
					url: res.url
				}
			};
		} catch (err) {
			return { valid: false, message: `Slack auth.test failed: ${slackErrorMessage(err)}` };
		}
	}

	async send(payload: ChannelSendInput, options: ConnectorCallOptions): Promise<ChannelSendResult> {
		const config = payload.target ?? options.target ?? {};
		const botToken = getBotToken(config);
		const channel = resolveChannel(config, options);

		// Security: this plugin is a module-level singleton shared across all
		// tenants, so keying the idempotency cache on payload.messageRef alone
		// would let a second tenant reusing another tenant's messageRef get back
		// the first tenant's result and silently skip real delivery. Scope the
		// key to connectorId + channel + messageRef with a NUL separator so the
		// components can't collide (mirrors the slack-channel hardening).
		const cacheKey = `${options.connectorId ?? ''}\0${channel}\0${payload.messageRef}`;
		const cached = this.idempotencyCache.get(cacheKey);
		if (cached) return cached;

		const args: Record<string, unknown> = { channel, text: payload.text };
		if (payload.rich?.kind === 'slack-blocks') {
			args.blocks = payload.rich.payload;
		}

		let res: ChatPostMessageResponse;
		try {
			res = await new WebClient(botToken).chat.postMessage(args as unknown as ChatPostMessageArguments);
		} catch (err) {
			throw new Error(`Slack chat.postMessage failed: ${slackErrorMessage(err)}`);
		}

		const result: ChannelSendResult = {
			provider: this.id,
			providerMessageId: typeof res.ts === 'string' ? res.ts : `slack-${payload.messageRef}`,
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

export const slackConnectorPlugin = new SlackConnectorPlugin();
