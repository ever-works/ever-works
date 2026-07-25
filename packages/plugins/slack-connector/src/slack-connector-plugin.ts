import { randomUUID } from 'node:crypto';
import { WebClient } from '@slack/web-api';
import type { ChatPostMessageArguments, ChatPostMessageResponse } from '@slack/web-api';
import type {
	IConnectorPlugin,
	IEventSourcePlugin,
	ConnectorMetadata,
	ConnectorCallOptions,
	ConnectorInboundRequest,
	ConnectorInboundVerification,
	ConnectorChallengeResponse,
	ConnectorInboundEvent,
	ConnectorReply,
	ChannelSendInput,
	ChannelSendResult,
	ChannelTargetConfig,
	ChannelVerification,
	EventSourcePullInput,
	EventSourcePullResult,
	PluginCategory,
	PluginSettings,
	JsonSchema
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES, EventSourceNotConfiguredError } from '@ever-works/plugin';
import type { IngestedEventEnvelope } from '@ever-works/contracts';
import { verifySlackSignature } from './slack-signature.js';

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

/** Slack message ts (`"1700000000.000100"`, seconds.fraction) → ISO 8601. */
export function slackTsToIso(ts: string): string {
	const seconds = Number(ts);
	if (!Number.isFinite(seconds)) return new Date(0).toISOString();
	return new Date(seconds * 1000).toISOString();
}

/** ISO 8601 → Slack `oldest` watermark (unix seconds with fraction). */
export function isoToSlackTs(iso: string): string {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return '0';
	return (ms / 1000).toFixed(6);
}

/**
 * Payload text cap for ingested envelopes. Envelope payloads are
 * size-capped platform-side (32 KB serialized); a single long message
 * never needs more than this to be useful in Memory/Activities.
 */
export const SLACK_EVENT_TEXT_MAX_CHARS = 4000;

function truncateText(text: string): string {
	return text.length > SLACK_EVENT_TEXT_MAX_CHARS ? text.slice(0, SLACK_EVENT_TEXT_MAX_CHARS) : text;
}

/** Parse the pull channel list: `eventChannelIds` (comma/space separated) → `defaultChannelId`. */
function resolveEventChannels(settings: PluginSettings | undefined): string[] {
	const raw = settings?.eventChannelIds;
	if (typeof raw === 'string' && raw.trim().length > 0) {
		return raw
			.split(/[\s,]+/)
			.map((c) => c.trim())
			.filter((c) => c.length > 0);
	}
	const fallback = settings?.defaultChannelId;
	if (typeof fallback === 'string' && fallback.length > 0) return [fallback];
	return [];
}

/**
 * Opaque pull cursor: which channel we're on + Slack's own page cursor.
 * Serialized as JSON; malformed input restarts from the first channel
 * (safe — the ingest pipeline dedupes on `(source, sourceEventId)`).
 */
interface SlackPullCursor {
	c: string;
	n?: string;
}

function parsePullCursor(cursor: string | undefined): SlackPullCursor | undefined {
	if (!cursor) return undefined;
	try {
		const parsed = JSON.parse(cursor) as SlackPullCursor;
		if (parsed && typeof parsed.c === 'string') return parsed;
	} catch {
		// fall through — treat as no cursor
	}
	return undefined;
}

/** Minimal shape of a `conversations.history` message we consume. */
interface SlackHistoryMessage {
	type?: string;
	subtype?: string;
	user?: string;
	username?: string;
	bot_id?: string;
	text?: string;
	ts?: string;
	thread_ts?: string;
	team?: string;
}

/**
 * Slack connector — a first-party BIDIRECTIONAL connector.
 *
 * Outbound: posts messages to a Slack channel with a bot token via
 * `chat.postMessage` on the official `@slack/web-api` SDK (distinct
 * from `slack-channel`'s incoming-webhook `@slack/webhook` path — a
 * connector is a superset of a channel). `reply()` posts back into the
 * originating thread.
 *
 * Inbound (Wave 6): the full Events API leg — `verifyInbound` (HMAC v0
 * over `v0:{ts}:{rawBody}`, ±300s skew, constant-time compare,
 * fail-closed), `handleChallenge` for `url_verification`, and
 * `parseInbound` normalizing `app_mention` / `message` events.
 *
 * Event source (Wave 6): `pullEvents` pages `conversations.history`
 * over the configured channels since a watermark and normalizes each
 * human message into an `IngestedEventEnvelope` (`slack.message` /
 * `slack.mention`, permalink as `sourceUrl`) for the platform's
 * event-ingest spine.
 *
 * See `docs/specs/features/connectors/spec.md` §7.5.1.
 */
export class SlackConnectorPlugin implements IConnectorPlugin, IEventSourcePlugin {
	readonly id = 'slack-connector';
	readonly name = 'Slack Connector';
	readonly version = '1.1.0';
	readonly category: PluginCategory = 'connector';
	readonly capabilities = [
		PLUGIN_CAPABILITIES.CONNECTOR,
		PLUGIN_CAPABILITIES.CONNECTOR_SLACK,
		PLUGIN_CAPABILITIES.EVENT_SOURCE
	] as const;

	readonly providerName = 'slack';

	readonly connector: ConnectorMetadata = {
		direction: 'bidirectional',
		transport: 'webhook',
		flags: {
			outboundMessage: true,
			outboundRecord: false,
			inbound: true,
			reply: true,
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
				title: 'Signing secret (verifies inbound Events API deliveries)',
				'x-secret': true,
				'x-envVar': 'SLACK_SIGNING_SECRET'
			},
			appId: { type: 'string', title: 'Slack app id' },
			defaultChannelId: { type: 'string', title: 'Default channel id (e.g. C0123456789)' },
			eventChannelIds: {
				type: 'string',
				title: 'Channels to ingest events from (comma-separated ids; defaults to the default channel)'
			}
		}
	};

	private readonly idempotencyCache = new Map<string, ChannelSendResult>();

	/** Bot user id per token — one `auth.test` per token, then cached. */
	private readonly botUserIdCache = new Map<string, string>();

	async onLoad(): Promise<void> {
		// No-op — no warm-up resources; a WebClient is created per send.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
		this.botUserIdCache.clear();
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
		// Optional threaded delivery — a `threadTs` on the target config posts
		// into that thread instead of the channel root (used by replies).
		if (typeof config.threadTs === 'string' && config.threadTs.length > 0) {
			args.thread_ts = config.threadTs;
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

	// ── Inbound (Events API) ────────────────────────────────────────────

	/**
	 * Verify a signed Events API delivery. Fail-closed: no signing
	 * secret resolved → invalid. The secret comes from resolved settings
	 * (or the per-connection target config as a fallback).
	 */
	async verifyInbound(
		req: ConnectorInboundRequest,
		options: ConnectorCallOptions
	): Promise<ConnectorInboundVerification> {
		const secret = [options.settings?.signingSecret, options.target?.signingSecret].find(
			(s): s is string => typeof s === 'string' && s.length > 0
		);
		const result = verifySlackSignature({
			rawBody: req.rawBody,
			timestamp: req.headers['x-slack-request-timestamp'],
			signature: req.headers['x-slack-signature'],
			signingSecret: secret
		});
		return result.valid ? { valid: true } : { valid: false, reason: result.reason };
	}

	/** Short-circuit the Events API `url_verification` handshake. */
	handleChallenge(req: ConnectorInboundRequest): ConnectorChallengeResponse | null {
		try {
			const body = JSON.parse(req.rawBody) as { type?: string; challenge?: string };
			if (body?.type === 'url_verification' && typeof body.challenge === 'string') {
				return { status: 200, body: { challenge: body.challenge } };
			}
		} catch {
			// not JSON — not a challenge
		}
		return null;
	}

	/** Normalize a verified `event_callback` delivery into inbound events. */
	async parseInbound(
		req: ConnectorInboundRequest,
		_options: ConnectorCallOptions
	): Promise<readonly ConnectorInboundEvent[]> {
		let body: {
			type?: string;
			event_id?: string;
			event?: SlackHistoryMessage & { type?: string; channel?: string; event_ts?: string };
		};
		try {
			body = JSON.parse(req.rawBody);
		} catch {
			return [];
		}
		if (body?.type !== 'event_callback' || !body.event) return [];
		const event = body.event;
		if (event.type !== 'app_mention' && event.type !== 'message') return [];
		// Never route bot-authored messages (incl. our own replies) back in.
		if (event.bot_id || event.subtype) return [];
		const channel = event.channel ?? '';
		const ts = event.ts ?? event.event_ts ?? '';
		if (!channel || !ts) return [];
		return [
			{
				kind: 'message',
				externalConversationId: event.thread_ts ? `${channel}:${event.thread_ts}` : channel,
				externalUserId: event.user ?? '',
				text: truncateText(event.text ?? ''),
				providerEventId: body.event_id ?? `${channel}:${ts}`,
				receivedAt: new Date(),
				raw: { channel, ts, threadTs: event.thread_ts, eventType: event.type }
			}
		];
	}

	/** Reply into the originating conversation/thread (`channel[:thread_ts]`). */
	async reply(reply: ConnectorReply, options: ConnectorCallOptions): Promise<ChannelSendResult> {
		const separator = reply.externalConversationId.indexOf(':');
		const channel =
			separator === -1 ? reply.externalConversationId : reply.externalConversationId.slice(0, separator);
		const threadTs = separator === -1 ? undefined : reply.externalConversationId.slice(separator + 1);
		const target: ChannelTargetConfig = {
			...(options.target ?? {}),
			channelId: channel,
			...(threadTs ? { threadTs } : {})
		};
		return this.send(
			{
				text: reply.text,
				rich: reply.rich,
				messageRef: `reply-${reply.inReplyToProviderEventId ?? randomUUID()}`,
				// Attribution requires a userId; connector calls may be
				// system-initiated (no platform user resolved yet).
				attribution: { userId: options.userId ?? 'system' },
				target
			},
			options
		);
	}

	// ── Event source (pull) ─────────────────────────────────────────────

	/**
	 * Pull one page of `conversations.history` for the current channel
	 * in the configured channel list, normalized to envelopes. The
	 * returned cursor resumes the same channel (Slack page cursor) or
	 * advances to the next channel; no cursor means the sweep is done.
	 * Re-delivery across overlapping windows is fine — the ingest
	 * pipeline dedupes on `(source, sourceEventId)`.
	 */
	async pullEvents(input: EventSourcePullInput): Promise<EventSourcePullResult> {
		const token = input.settings?.botToken;
		if (typeof token !== 'string' || token.length === 0) {
			throw new EventSourceNotConfiguredError('slack-connector: settings.botToken is required to pull events');
		}
		const channels = resolveEventChannels(input.settings);
		if (channels.length === 0) {
			// Valid outbound-only configuration — nothing to pull.
			return { events: [] };
		}

		const cursor = parsePullCursor(input.cursor);
		let channelIndex = cursor ? channels.indexOf(cursor.c) : 0;
		if (channelIndex === -1) channelIndex = 0;
		const channel = channels[channelIndex];

		const client = new WebClient(token);
		const history = await client.conversations.history({
			channel,
			oldest: isoToSlackTs(input.since),
			limit: 100,
			...(cursor?.n ? { cursor: cursor.n } : {})
		});

		const botUserId = await this.getBotUserId(client, token);
		const messages = (history.messages ?? []) as SlackHistoryMessage[];
		const events: IngestedEventEnvelope[] = [];
		for (const message of messages) {
			const envelope = await this.normalizeMessage(client, channel, message, botUserId);
			if (envelope) events.push(envelope);
		}
		// Oldest-first preferred by the contract; history returns newest-first.
		events.reverse();

		const nextSlackCursor = history.response_metadata?.next_cursor;
		let nextCursor: string | undefined;
		if (typeof nextSlackCursor === 'string' && nextSlackCursor.length > 0) {
			nextCursor = JSON.stringify({ c: channel, n: nextSlackCursor } satisfies SlackPullCursor);
		} else if (channelIndex + 1 < channels.length) {
			nextCursor = JSON.stringify({ c: channels[channelIndex + 1] } satisfies SlackPullCursor);
		}

		return nextCursor ? { events, nextCursor } : { events };
	}

	/**
	 * Normalize one history message → envelope. Bot-authored messages
	 * (incl. this app's own replies) and system subtypes are skipped so
	 * the spine never ingests its own output.
	 */
	private async normalizeMessage(
		client: WebClient,
		channel: string,
		message: SlackHistoryMessage,
		botUserId: string | undefined
	): Promise<IngestedEventEnvelope | null> {
		if (message.type !== 'message' || !message.ts) return null;
		if (message.bot_id || message.subtype) return null;
		if (botUserId && message.user === botUserId) return null;

		const text = message.text ?? '';
		const isMention = Boolean(botUserId) && text.includes(`<@${botUserId}>`);
		const sourceUrl = await this.tryGetPermalink(client, channel, message.ts);

		return {
			id: randomUUID(),
			source: this.id,
			sourceEventId: `${channel}:${message.ts}`,
			kind: isMention ? 'slack.mention' : 'slack.message',
			occurredAt: slackTsToIso(message.ts),
			actor: {
				name: message.username ?? message.user ?? 'unknown',
				...(message.user ? { externalId: message.user } : {})
			},
			subject: { type: 'channel', externalId: channel },
			...(sourceUrl ? { sourceUrl } : {}),
			payload: {
				channel,
				ts: message.ts,
				...(message.thread_ts ? { threadTs: message.thread_ts } : {}),
				...(message.team ? { teamId: message.team } : {}),
				text: truncateText(text)
			}
		};
	}

	/** Permalink lookup is best-effort — a failure just drops `sourceUrl`. */
	private async tryGetPermalink(client: WebClient, channel: string, ts: string): Promise<string | undefined> {
		try {
			const res = await client.chat.getPermalink({ channel, message_ts: ts });
			return typeof res.permalink === 'string' ? res.permalink : undefined;
		} catch {
			return undefined;
		}
	}

	private async getBotUserId(client: WebClient, token: string): Promise<string | undefined> {
		const cached = this.botUserIdCache.get(token);
		if (cached) return cached;
		try {
			const res = await client.auth.test();
			if (typeof res.user_id === 'string' && res.user_id.length > 0) {
				this.botUserIdCache.set(token, res.user_id);
				return res.user_id;
			}
		} catch {
			// Mention detection degrades gracefully — events land as slack.message.
		}
		return undefined;
	}
}

export const slackConnectorPlugin = new SlackConnectorPlugin();
