import { REST } from 'discord.js';
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
 * Discord REST version pinned for the `discord.js` `REST` client. v10 is
 * the current stable Discord HTTP API.
 */
const DISCORD_API_VERSION = '10';

/** `GET /users/@me` — resolves the bot user for a bot token. */
const ROUTE_CURRENT_USER = '/users/@me' as const;

/**
 * `POST /channels/:id/messages` route path. Building the resource path is
 * not "hand-rolling REST": the `discord.js` `REST` client still owns the
 * base URL, the `Authorization: Bot <token>` header, rate-limit handling
 * and retries — this is the documented `@discordjs/rest` usage, the
 * lightweight stateless analogue of `slack-connector`'s `WebClient`.
 */
function channelMessagesRoute(channelId: string): `/${string}` {
	return `/channels/${channelId}/messages`;
}

/**
 * Resolve the bot token from a connector's target config. Discord bot
 * tokens are opaque strings; the `discord.js` `REST` client pins the host
 * to `discord.com`, so there is no SSRF surface (unlike the webhook-URL
 * `discord-channel` plugin).
 */
function getBotToken(config: ChannelTargetConfig): string {
	const token = config.botToken;
	if (typeof token !== 'string' || token.length === 0) {
		throw new Error('discord-connector: targetConfig.botToken is required');
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
	throw new Error('discord-connector: a channel id is required (targetConfig.defaultChannelId or channelId)');
}

/** Extract a readable message from a `discord.js` / `@discordjs/rest` error. */
function discordErrorMessage(err: unknown): string {
	const e = err as { message?: unknown; code?: unknown; rawError?: { message?: unknown } };
	if (e.rawError && typeof e.rawError.message === 'string') return e.rawError.message;
	if (typeof e.message === 'string') return e.message;
	if (typeof e.code === 'string' || typeof e.code === 'number') return String(e.code);
	return 'unknown error';
}

/**
 * Discord connector — a first-party BIDIRECTIONAL connector. This
 * increment implements the OUTBOUND leg: it posts messages to a Discord
 * channel with a bot token via `POST /channels/:id/messages` on the
 * official `discord.js` `REST` client (distinct from `discord-channel`'s
 * incoming-webhook `fetch` path — a connector is a superset of a channel).
 *
 * Inbound (Discord Interactions API: `verifyInbound` Ed25519 signature
 * verification over `X-Signature-Ed25519` + `X-Signature-Timestamp`,
 * `handleChallenge` for the `PING` handshake, `parseInbound` → route to an
 * Agent, `reply` into the channel) is a follow-up (P2) — the `publicKey`
 * setting is captured now so the connection is inbound-ready. Metadata
 * therefore declares `direction: 'outbound'` with `inbound`/`reply`/
 * `pairing` flags off until that runtime lands.
 *
 * See `docs/specs/features/connectors/spec.md` §7.5.1.
 */
export class DiscordConnectorPlugin implements IConnectorPlugin {
	readonly id = 'discord-connector';
	readonly name = 'Discord Connector';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'connector';
	readonly capabilities = [PLUGIN_CAPABILITIES.CONNECTOR, PLUGIN_CAPABILITIES.CONNECTOR_DISCORD] as const;

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
				title: 'Bot token',
				'x-secret': true,
				'x-envVar': 'DISCORD_BOT_TOKEN'
			},
			publicKey: {
				type: 'string',
				title: 'Application public key (for inbound Interactions API — used in a follow-up)',
				'x-secret': true,
				'x-envVar': 'DISCORD_PUBLIC_KEY'
			},
			applicationId: { type: 'string', title: 'Discord application (client) id' },
			guildId: { type: 'string', title: 'Default guild/server id' },
			defaultChannelId: { type: 'string', title: 'Default channel id (e.g. 123456789012345678)' }
		}
	};

	private readonly idempotencyCache = new Map<string, ChannelSendResult>();

	async onLoad(): Promise<void> {
		// No-op — no warm-up resources; a REST client is created per send.
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
			const rest = new REST({ version: DISCORD_API_VERSION }).setToken(token);
			const res = (await rest.get(ROUTE_CURRENT_USER)) as {
				id?: string;
				username?: string;
				discriminator?: string;
			};
			return {
				valid: true,
				details: {
					botUserId: res.id,
					username: res.username,
					discriminator: res.discriminator
				}
			};
		} catch (err) {
			return { valid: false, message: `Discord users/@me failed: ${discordErrorMessage(err)}` };
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
		// components can't collide (mirrors the slack-connector hardening).
		const cacheKey = `${options.connectorId ?? ''}\0${channel}\0${payload.messageRef}`;
		const cached = this.idempotencyCache.get(cacheKey);
		if (cached) return cached;

		const body: Record<string, unknown> = { content: payload.text };
		if (payload.rich?.kind === 'discord-embeds') {
			body.embeds = payload.rich.payload;
		}

		let res: { id?: string };
		try {
			const rest = new REST({ version: DISCORD_API_VERSION }).setToken(botToken);
			res = (await rest.post(channelMessagesRoute(channel), { body })) as { id?: string };
		} catch (err) {
			throw new Error(`Discord channel message failed: ${discordErrorMessage(err)}`);
		}

		const result: ChannelSendResult = {
			provider: this.id,
			providerMessageId: typeof res.id === 'string' ? res.id : `discord-${payload.messageRef}`,
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

export const discordConnectorPlugin = new DiscordConnectorPlugin();
