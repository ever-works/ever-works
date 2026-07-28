import { randomUUID } from 'node:crypto';
import { AtpAgent } from '@atproto/api';
import type {
	IConnectorPlugin,
	IEventSourcePlugin,
	ConnectorMetadata,
	ConnectorCallOptions,
	ChannelSendInput,
	ChannelSendResult,
	ChannelTargetConfig,
	ChannelVerification,
	EventSourcePullInput,
	EventSourcePullResult,
	PluginCategory,
	JsonSchema
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES, EventSourceNotConfiguredError } from '@ever-works/plugin';
import { isSafeWebhookUrl } from '@ever-works/plugin/helpers/ssrf-guard';
import type { IngestedEventEnvelope } from '@ever-works/contracts';

/**
 * Payload text cap for ingested envelopes. Envelope payloads are
 * size-capped platform-side (32 KB serialized); a post body never needs
 * more than this to be useful in Memory/Activities.
 */
export const BLUESKY_EVENT_TEXT_MAX_CHARS = 4000;

/** Items requested per Bluesky page (notifications and feed alike). */
export const BLUESKY_PULL_PAGE_SIZE = 50;

/**
 * Historical backfill bound: at most this many pages per phase
 * (notifications, then the account's own posts) during the opt-in
 * first-pull backfill, so a busy account can never turn activation
 * into an unbounded crawl.
 */
export const BLUESKY_BACKFILL_MAX_PAGES = 10;

/** Default AT Protocol PDS when the operator does not override it. */
export const BLUESKY_DEFAULT_SERVICE = 'https://bsky.social';

/** Clamp the opt-in backfill window to the supported 0–90 day range. */
export function clampBackfillDays(value: unknown): number {
	const num = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(num) || num <= 0) return 0;
	return Math.min(Math.floor(num), 90);
}

function truncateText(text: string): string {
	return text.length > BLUESKY_EVENT_TEXT_MAX_CHARS ? text.slice(0, BLUESKY_EVENT_TEXT_MAX_CHARS) : text;
}

/** Extract a readable message from an `@atproto/api` error. */
function atprotoErrorMessage(err: unknown): string {
	const e = err as { message?: string; error?: string; status?: number };
	return e.message ?? e.error ?? (typeof e.status === 'number' ? `HTTP ${e.status}` : 'unknown error');
}

/** ISO string | Date | undefined → ISO 8601 (epoch on garbage). */
function toIso(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'string') {
		const ms = Date.parse(value);
		if (Number.isFinite(ms)) return new Date(ms).toISOString();
	}
	return new Date(0).toISOString();
}

/**
 * `at://<repo>/app.bsky.feed.post/<rkey>` → the public bsky.app
 * permalink. Uses the author handle when known (nicer links) and falls
 * back to the repo DID. Returns undefined for anything that is not a
 * post AT-URI, so callers simply omit `sourceUrl`.
 */
export function postUrlFromAtUri(uri: string | undefined, handle?: string): string | undefined {
	if (typeof uri !== 'string' || !uri.startsWith('at://')) return undefined;
	const parts = uri.slice('at://'.length).split('/');
	if (parts.length < 3) return undefined;
	const [repo, collection, rkey] = parts;
	if (collection !== 'app.bsky.feed.post' || !rkey) return undefined;
	const actor = handle && handle.length > 0 ? handle : repo;
	return `https://bsky.app/profile/${encodeURIComponent(actor)}/post/${encodeURIComponent(rkey)}`;
}

/**
 * Opaque pull cursor. `p` is the sweep phase (notifications → the
 * account's own posts), `n` the AT Protocol page cursor, `s` the
 * effective since-watermark the sweep was started with (later pages of
 * the same sweep keep the SAME window), `f` flags a first-pull backfill
 * sweep and `b` counts pages used in the current phase (backfill page
 * bound). Malformed input restarts the sweep — safe, the ingest
 * pipeline dedupes on `(source, sourceEventId)`.
 */
interface BlueskyPullCursor {
	p: 'notifications' | 'author';
	n?: string;
	s: string;
	f?: 1;
	b?: number;
}

function parsePullCursor(cursor: string | undefined): BlueskyPullCursor | undefined {
	if (!cursor) return undefined;
	try {
		const parsed = JSON.parse(cursor) as BlueskyPullCursor;
		if (parsed && (parsed.p === 'notifications' || parsed.p === 'author') && typeof parsed.s === 'string') {
			return parsed;
		}
	} catch {
		// fall through — treat as no cursor
	}
	return undefined;
}

/** Minimal shape of an actor we consume. */
interface BlueskyActor {
	did?: string;
	handle?: string;
	displayName?: string;
}

/** Minimal shape of a notification we consume. */
interface BlueskyNotification {
	uri?: string;
	cid?: string;
	author?: BlueskyActor;
	reason?: string;
	reasonSubject?: string;
	record?: { text?: string };
	isRead?: boolean;
	indexedAt?: string;
}

/** Minimal shape of an author-feed item we consume. */
interface BlueskyFeedItem {
	post?: {
		uri?: string;
		cid?: string;
		author?: BlueskyActor;
		record?: { text?: string; createdAt?: string };
		replyCount?: number;
		repostCount?: number;
		likeCount?: number;
		indexedAt?: string;
	};
}

/** The subset of the `AtpAgent` surface this plugin calls. */
interface BlueskyAgentLike {
	login(input: { identifier: string; password: string }): Promise<{
		data?: { did?: string; handle?: string };
	}>;
	post(record: Record<string, unknown>): Promise<{ uri?: string; cid?: string }>;
	listNotifications(params: Record<string, unknown>): Promise<{
		data?: { notifications?: BlueskyNotification[]; cursor?: string };
	}>;
	getAuthorFeed(params: Record<string, unknown>): Promise<{
		data?: { feed?: BlueskyFeedItem[]; cursor?: string };
	}>;
}

/** First non-empty trimmed string among the candidates. */
function firstString(candidates: unknown[]): string | undefined {
	for (const c of candidates) {
		if (typeof c === 'string' && c.trim().length > 0) return c.trim();
	}
	return undefined;
}

/** Resolved credentials for one call. */
interface BlueskyCredentials {
	identifier: string;
	appPassword: string;
	service: string;
}

/**
 * Resolve credentials from the per-connection target config, falling
 * back to the resolved plugin settings. Returns undefined (never a
 * partial) so callers fail loudly with one clear message.
 */
export function resolveCredentials(
	config: ChannelTargetConfig,
	options: ConnectorCallOptions
): BlueskyCredentials | undefined {
	const identifier = firstString([config.identifier, options.settings?.identifier]);
	const appPassword = firstString([config.appPassword, options.settings?.appPassword]);
	if (!identifier || !appPassword) return undefined;
	const service = firstString([config.service, options.settings?.service]) ?? BLUESKY_DEFAULT_SERVICE;
	return { identifier, appPassword, service };
}

/**
 * Bluesky (AT Protocol) social connector — first-party native connector.
 *
 * Outbound: `send` publishes a post — or a threaded reply when the
 * target config carries `replyToUri`/`replyToCid` — through the
 * official `@atproto/api` SDK using an app password (never the account
 * password).
 *
 * Event source: `pullEvents` sweeps notifications (mentions, replies,
 * likes, reposts, follows) then the connected account's own posts since
 * the watermark, normalized into `IngestedEventEnvelope`s
 * (`bluesky.notification` / `bluesky.post`, bsky.app permalink as
 * `sourceUrl`) for the platform's event-ingest spine. Neither API can
 * filter by time, so each phase is windowed client-side newest-first
 * and stops at the first item older than the watermark. The opt-in
 * historical backfill (`backfillDays`, default 0 = off, max 90) widens
 * the FIRST pull's window only, with a per-phase page bound.
 * Re-delivery across overlapping windows is fine — the ingest pipeline
 * dedupes on `(source, sourceEventId)`.
 *
 * Unconfigured is always LOUD: `verifyConnection` reports the missing
 * credentials, `send` throws, and `pullEvents` throws
 * `EventSourceNotConfiguredError`. Nothing silently no-ops.
 */
export class BlueskyConnectorPlugin implements IConnectorPlugin, IEventSourcePlugin {
	readonly id = 'bluesky-connector';
	readonly name = 'Bluesky Connector';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'connector';
	readonly capabilities = [
		PLUGIN_CAPABILITIES.CONNECTOR,
		PLUGIN_CAPABILITIES.CONNECTOR_BLUESKY,
		PLUGIN_CAPABILITIES.EVENT_SOURCE
	] as const;

	readonly providerName = 'bluesky';

	readonly connector: ConnectorMetadata = {
		direction: 'outbound',
		transport: 'poll',
		flags: {
			outboundMessage: true,
			outboundRecord: false,
			inbound: false,
			reply: false,
			pairing: false,
			richOutbound: false
		}
	};

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		required: ['identifier', 'appPassword'],
		properties: {
			identifier: {
				type: 'string',
				title: 'Bluesky handle or DID (e.g. acme.bsky.social)'
			},
			appPassword: {
				type: 'string',
				title: 'Bluesky app password (never your account password)',
				'x-secret': true,
				'x-envVar': 'BLUESKY_APP_PASSWORD'
			},
			service: {
				type: 'string',
				title: 'PDS service URL (defaults to https://bsky.social)',
				default: BLUESKY_DEFAULT_SERVICE
			},
			backfillDays: {
				type: 'number',
				title: 'Historical backfill window in days on first pull (0 = off, max 90)',
				default: 0,
				minimum: 0,
				maximum: 90
			}
		}
	};

	private readonly idempotencyCache = new Map<string, ChannelSendResult>();

	async onLoad(): Promise<void> {
		// No-op — no warm-up resources; an agent is created per call.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
	}

	/** Testable seam — specs stub this; production uses the real SDK. */
	protected createAgent(service: string): BlueskyAgentLike {
		return new AtpAgent({ service }) as unknown as BlueskyAgentLike;
	}

	/**
	 * Build an authenticated agent. The PDS URL is operator-supplied, so
	 * it passes the shared SSRF guard before any request is issued.
	 */
	private async connect(
		credentials: BlueskyCredentials
	): Promise<{ agent: BlueskyAgentLike; did?: string; handle?: string }> {
		if (!isSafeWebhookUrl(credentials.service)) {
			throw new Error(`bluesky-connector: refusing to use an unsafe service URL '${credentials.service}'`);
		}
		const agent = this.createAgent(credentials.service);
		const res = await agent.login({ identifier: credentials.identifier, password: credentials.appPassword });
		return { agent, did: res?.data?.did, handle: res?.data?.handle };
	}

	async verifyConnection(config: ChannelTargetConfig, options: ConnectorCallOptions): Promise<ChannelVerification> {
		const credentials = resolveCredentials(config, options);
		if (!credentials) {
			return { valid: false, message: 'identifier and appPassword are required' };
		}
		try {
			const { did, handle } = await this.connect(credentials);
			return {
				valid: true,
				details: {
					service: credentials.service,
					...(did ? { did } : {}),
					...(handle ? { handle } : {})
				}
			};
		} catch (err) {
			return { valid: false, message: `Bluesky login failed: ${atprotoErrorMessage(err)}` };
		}
	}

	/** Outbound leg — publish a post (or a threaded reply). */
	async send(payload: ChannelSendInput, options: ConnectorCallOptions): Promise<ChannelSendResult> {
		const config = payload.target ?? options.target ?? {};
		const credentials = resolveCredentials(config, options);
		if (!credentials) {
			throw new Error(
				'bluesky-connector: identifier and appPassword are required ' +
					'(targetConfig.identifier/appPassword or settings.identifier/appPassword)'
			);
		}

		const replyToUri = firstString([config.replyToUri]);
		const replyToCid = firstString([config.replyToCid]);

		// Idempotency: scope the key to connectorId + thread + messageRef with a
		// NUL separator so components can't collide across tenants (mirrors the
		// slack-connector hardening — this plugin is a module-level singleton).
		const cacheKey = `${options.connectorId ?? ''}\0${replyToUri ?? ''}\0${payload.messageRef}`;
		const cached = this.idempotencyCache.get(cacheKey);
		if (cached) return cached;

		let uri: string | undefined;
		try {
			const { agent } = await this.connect(credentials);
			const record: Record<string, unknown> = {
				text: payload.text,
				createdAt: new Date().toISOString()
			};
			if (replyToUri && replyToCid) {
				const rootUri = firstString([config.rootUri]) ?? replyToUri;
				const rootCid = firstString([config.rootCid]) ?? replyToCid;
				record.reply = {
					root: { uri: rootUri, cid: rootCid },
					parent: { uri: replyToUri, cid: replyToCid }
				};
			}
			const res = await agent.post(record);
			uri = typeof res?.uri === 'string' ? res.uri : undefined;
		} catch (err) {
			throw new Error(`Bluesky post failed: ${atprotoErrorMessage(err)}`);
		}

		const result: ChannelSendResult = {
			provider: this.id,
			providerMessageId: uri ?? `bluesky-${payload.messageRef}`,
			deliveredAt: new Date()
		};
		this.idempotencyCache.set(cacheKey, result);
		if (this.idempotencyCache.size > 500) {
			const firstKey = this.idempotencyCache.keys().next().value;
			if (firstKey) this.idempotencyCache.delete(firstKey);
		}
		return result;
	}

	// ── Event source (pull) ─────────────────────────────────────────────

	/**
	 * Pull one page of the current sweep phase (notifications → own
	 * posts) since the effective watermark, normalized to envelopes. The
	 * returned cursor resumes the same phase (AT Protocol page cursor) or
	 * advances to the next; no cursor means the sweep is done.
	 *
	 * First pull (epoch/absent watermark, no cursor): the window is
	 * `now - backfillDays` when the opt-in backfill is on, otherwise
	 * `now` — history stays untouched unless the user asked for it.
	 */
	async pullEvents(input: EventSourcePullInput): Promise<EventSourcePullResult> {
		const identifier = input.settings?.identifier;
		const appPassword = input.settings?.appPassword;
		if (typeof identifier !== 'string' || identifier.length === 0) {
			throw new EventSourceNotConfiguredError(
				'bluesky-connector: settings.identifier is required to pull events'
			);
		}
		if (typeof appPassword !== 'string' || appPassword.length === 0) {
			throw new EventSourceNotConfiguredError(
				'bluesky-connector: settings.appPassword is required to pull events'
			);
		}
		const service = firstString([input.settings?.service]) ?? BLUESKY_DEFAULT_SERVICE;

		const cursor = parsePullCursor(input.cursor);
		let phase: 'notifications' | 'author';
		let after: string | undefined;
		let since: string;
		let backfill: boolean;
		let pagesUsed: number;

		if (cursor) {
			phase = cursor.p;
			after = cursor.n;
			since = cursor.s;
			backfill = cursor.f === 1;
			pagesUsed = cursor.b ?? 0;
		} else {
			const sinceMs = Date.parse(input.since);
			const firstPull = !Number.isFinite(sinceMs) || sinceMs <= 0;
			const backfillDays = clampBackfillDays(input.settings?.backfillDays);
			if (firstPull) {
				const start = backfillDays > 0 ? Date.now() - backfillDays * 86400_000 : Date.now();
				since = new Date(start).toISOString();
				backfill = backfillDays > 0;
			} else {
				since = new Date(sinceMs).toISOString();
				backfill = false;
			}
			phase = 'notifications';
			after = undefined;
			pagesUsed = 0;
		}

		const { agent, did, handle } = await this.connect({ identifier, appPassword, service });
		const sinceMs = Date.parse(since);
		const events: IngestedEventEnvelope[] = [];
		let nextPageCursor: string | undefined;
		let stopSweep = false;

		if (phase === 'notifications') {
			const res = await agent.listNotifications({
				limit: BLUESKY_PULL_PAGE_SIZE,
				...(after ? { cursor: after } : {})
			});
			for (const notification of res?.data?.notifications ?? []) {
				const indexedMs = Date.parse(notification.indexedAt ?? '');
				if (Number.isFinite(indexedMs) && indexedMs < sinceMs) {
					stopSweep = true;
					break;
				}
				const envelope = this.normalizeNotification(notification);
				if (envelope) events.push(envelope);
			}
			nextPageCursor = res?.data?.cursor;
		} else {
			const actor = did ?? handle ?? identifier;
			const res = await agent.getAuthorFeed({
				actor,
				limit: BLUESKY_PULL_PAGE_SIZE,
				...(after ? { cursor: after } : {})
			});
			for (const item of res?.data?.feed ?? []) {
				const indexedMs = Date.parse(item.post?.indexedAt ?? '');
				if (Number.isFinite(indexedMs) && indexedMs < sinceMs) {
					stopSweep = true;
					break;
				}
				const envelope = this.normalizePost(item);
				if (envelope) events.push(envelope);
			}
			nextPageCursor = res?.data?.cursor;
		}

		pagesUsed += 1;
		const pageBudgetExhausted = backfill && pagesUsed >= BLUESKY_BACKFILL_MAX_PAGES;

		let next: BlueskyPullCursor | undefined;
		if (!stopSweep && nextPageCursor && !pageBudgetExhausted) {
			next = { p: phase, n: nextPageCursor, s: since, ...(backfill ? { f: 1 as const } : {}), b: pagesUsed };
		} else if (phase === 'notifications') {
			// Advance to the own-posts phase (page counter resets per phase).
			next = { p: 'author', s: since, ...(backfill ? { f: 1 as const } : {}), b: 0 };
		}

		return next ? { events, nextCursor: JSON.stringify(next) } : { events };
	}

	private normalizeNotification(notification: BlueskyNotification): IngestedEventEnvelope | null {
		if (!notification.uri) return null;
		const occurredAt = toIso(notification.indexedAt);
		const reason = notification.reason ?? 'unknown';
		const author = notification.author ?? {};
		const text = typeof notification.record?.text === 'string' ? notification.record.text : undefined;
		const sourceUrl = postUrlFromAtUri(notification.uri, author.handle);

		return {
			id: randomUUID(),
			source: this.id,
			sourceEventId: `${notification.uri}:${reason}:${occurredAt}`,
			kind: 'bluesky.notification',
			occurredAt,
			...(author.handle || author.displayName
				? {
						actor: {
							name: author.displayName ?? author.handle ?? 'unknown',
							...(author.did ? { externalId: author.did } : {})
						}
					}
				: {}),
			subject: {
				type: 'post',
				externalId: notification.reasonSubject ?? notification.uri,
				...(text ? { title: truncateText(text) } : {})
			},
			...(sourceUrl ? { sourceUrl } : {}),
			payload: {
				reason,
				uri: notification.uri,
				...(notification.cid ? { cid: notification.cid } : {}),
				...(notification.reasonSubject ? { reasonSubject: notification.reasonSubject } : {}),
				...(author.did ? { authorDid: author.did } : {}),
				...(author.handle ? { authorHandle: author.handle } : {}),
				...(text ? { text: truncateText(text) } : {}),
				...(typeof notification.isRead === 'boolean' ? { isRead: notification.isRead } : {}),
				indexedAt: occurredAt
			}
		};
	}

	private normalizePost(item: BlueskyFeedItem): IngestedEventEnvelope | null {
		const post = item.post;
		if (!post?.uri) return null;
		const occurredAt = toIso(post.indexedAt ?? post.record?.createdAt);
		const author = post.author ?? {};
		const text = typeof post.record?.text === 'string' ? post.record.text : undefined;
		const sourceUrl = postUrlFromAtUri(post.uri, author.handle);

		return {
			id: randomUUID(),
			source: this.id,
			sourceEventId: `${post.uri}:${occurredAt}`,
			kind: 'bluesky.post',
			occurredAt,
			...(author.handle || author.displayName
				? {
						actor: {
							name: author.displayName ?? author.handle ?? 'unknown',
							...(author.did ? { externalId: author.did } : {})
						}
					}
				: {}),
			subject: {
				type: 'post',
				externalId: post.uri,
				...(text ? { title: truncateText(text) } : {})
			},
			...(sourceUrl ? { sourceUrl } : {}),
			payload: {
				uri: post.uri,
				...(post.cid ? { cid: post.cid } : {}),
				...(author.did ? { authorDid: author.did } : {}),
				...(author.handle ? { authorHandle: author.handle } : {}),
				...(text ? { text: truncateText(text) } : {}),
				...(typeof post.replyCount === 'number' ? { replyCount: post.replyCount } : {}),
				...(typeof post.repostCount === 'number' ? { repostCount: post.repostCount } : {}),
				...(typeof post.likeCount === 'number' ? { likeCount: post.likeCount } : {}),
				...(post.record?.createdAt ? { createdAt: toIso(post.record.createdAt) } : {}),
				indexedAt: occurredAt
			}
		};
	}
}

export const blueskyConnectorPlugin = new BlueskyConnectorPlugin();
