import { randomUUID } from 'node:crypto';
import { createRestAPIClient } from 'masto';
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
 * size-capped platform-side (32 KB serialized); a status body never
 * needs more than this to be useful in Memory/Activities.
 */
export const MASTODON_EVENT_TEXT_MAX_CHARS = 4000;

/** Items requested per Mastodon page (notifications and statuses alike). */
export const MASTODON_PULL_PAGE_SIZE = 40;

/**
 * Historical backfill bound: at most this many pages per phase
 * (notifications, then the account's own statuses) during the opt-in
 * first-pull backfill, so a busy account can never turn activation
 * into an unbounded crawl.
 */
export const MASTODON_BACKFILL_MAX_PAGES = 10;

/** Visibilities Mastodon accepts for an outbound status. */
export const MASTODON_VISIBILITIES = ['public', 'unlisted', 'private', 'direct'] as const;
export type MastodonVisibility = (typeof MASTODON_VISIBILITIES)[number];

/** Clamp the opt-in backfill window to the supported 0–90 day range. */
export function clampBackfillDays(value: unknown): number {
	const num = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(num) || num <= 0) return 0;
	return Math.min(Math.floor(num), 90);
}

function truncateText(text: string): string {
	return text.length > MASTODON_EVENT_TEXT_MAX_CHARS ? text.slice(0, MASTODON_EVENT_TEXT_MAX_CHARS) : text;
}

/**
 * Mastodon status bodies are HTML. Envelopes carry plain text (Memory
 * observations and Activity rows are text surfaces), so block-level
 * markup becomes newlines, remaining tags are dropped and the handful
 * of entities Mastodon actually emits are decoded.
 */
export function stripStatusHtml(html: string | undefined): string | undefined {
	if (typeof html !== 'string' || html.length === 0) return undefined;
	const text = html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&')
		.trim();
	return text.length > 0 ? text : undefined;
}

/** Normalize the configured visibility, defaulting to `public`. */
export function resolveVisibility(value: unknown): MastodonVisibility {
	if (typeof value === 'string') {
		const candidate = value.trim().toLowerCase();
		if ((MASTODON_VISIBILITIES as readonly string[]).includes(candidate)) {
			return candidate as MastodonVisibility;
		}
	}
	return 'public';
}

/** Extract a readable message from a `masto` error. */
function mastodonErrorMessage(err: unknown): string {
	const e = err as { message?: string; error?: string; statusCode?: number };
	return e.message ?? e.error ?? (typeof e.statusCode === 'number' ? `HTTP ${e.statusCode}` : 'unknown error');
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
 * Opaque pull cursor. `p` is the sweep phase (notifications → the
 * account's own statuses), `n` the Mastodon `max_id` page cursor, `s`
 * the effective since-watermark the sweep was started with (later
 * pages of the same sweep keep the SAME window), `f` flags a first-pull
 * backfill sweep and `b` counts pages used in the current phase
 * (backfill page bound). Malformed input restarts the sweep — safe, the
 * ingest pipeline dedupes on `(source, sourceEventId)`.
 */
interface MastodonPullCursor {
	p: 'notifications' | 'statuses';
	n?: string;
	s: string;
	f?: 1;
	b?: number;
}

function parsePullCursor(cursor: string | undefined): MastodonPullCursor | undefined {
	if (!cursor) return undefined;
	try {
		const parsed = JSON.parse(cursor) as MastodonPullCursor;
		if (parsed && (parsed.p === 'notifications' || parsed.p === 'statuses') && typeof parsed.s === 'string') {
			return parsed;
		}
	} catch {
		// fall through — treat as no cursor
	}
	return undefined;
}

/** Minimal shape of an account we consume. */
interface MastodonAccount {
	id?: string;
	username?: string;
	acct?: string;
	displayName?: string;
	url?: string;
}

/** Minimal shape of a status we consume. */
interface MastodonStatus {
	id?: string;
	uri?: string;
	url?: string;
	content?: string;
	createdAt?: string;
	repliesCount?: number;
	reblogsCount?: number;
	favouritesCount?: number;
	visibility?: string;
	account?: MastodonAccount;
}

/** Minimal shape of a notification we consume. */
interface MastodonNotification {
	id?: string;
	type?: string;
	createdAt?: string;
	account?: MastodonAccount;
	status?: MastodonStatus;
}

/** The subset of the `masto` REST surface this plugin calls. */
interface MastodonClientLike {
	v1: {
		accounts: {
			verifyCredentials(): Promise<MastodonAccount>;
			$select(id: string): {
				statuses: { list(params: Record<string, unknown>): Promise<MastodonStatus[]> };
			};
		};
		statuses: { create(params: Record<string, unknown>): Promise<MastodonStatus> };
		notifications: { list(params: Record<string, unknown>): Promise<MastodonNotification[]> };
	};
}

/** First non-empty trimmed string among the candidates. */
function firstString(candidates: unknown[]): string | undefined {
	for (const c of candidates) {
		if (typeof c === 'string' && c.trim().length > 0) return c.trim();
	}
	return undefined;
}

/** Resolved credentials for one call. */
interface MastodonCredentials {
	instanceUrl: string;
	accessToken: string;
}

/**
 * Resolve credentials from the per-connection target config, falling
 * back to the resolved plugin settings. Returns undefined (never a
 * partial) so callers fail loudly with one clear message.
 */
export function resolveCredentials(
	config: ChannelTargetConfig,
	options: ConnectorCallOptions
): MastodonCredentials | undefined {
	const instanceUrl = firstString([config.instanceUrl, options.settings?.instanceUrl]);
	const accessToken = firstString([config.accessToken, options.settings?.accessToken]);
	if (!instanceUrl || !accessToken) return undefined;
	return { instanceUrl, accessToken };
}

/**
 * Mastodon social connector — first-party native connector.
 *
 * Outbound: `send` publishes a status — or a threaded reply when the
 * target config carries `inReplyToId` — through the `masto` SDK against
 * the operator's own instance. The instance URL is operator-supplied,
 * so it passes the shared SSRF guard before any request is issued.
 *
 * Event source: `pullEvents` sweeps notifications (mentions, favourites,
 * boosts, follows) then the connected account's own statuses since the
 * watermark, normalized into `IngestedEventEnvelope`s
 * (`mastodon.notification` / `mastodon.status`, the status permalink as
 * `sourceUrl`) for the platform's event-ingest spine. Mastodon paginates
 * by id rather than time, so each phase walks `max_id` newest-first and
 * stops at the first item older than the watermark. The opt-in
 * historical backfill (`backfillDays`, default 0 = off, max 90) widens
 * the FIRST pull's window only, with a per-phase page bound.
 * Re-delivery across overlapping windows is fine — the ingest pipeline
 * dedupes on `(source, sourceEventId)`.
 *
 * Unconfigured is always LOUD: `verifyConnection` reports the missing
 * credentials, `send` throws, and `pullEvents` throws
 * `EventSourceNotConfiguredError`. Nothing silently no-ops.
 */
export class MastodonConnectorPlugin implements IConnectorPlugin, IEventSourcePlugin {
	readonly id = 'mastodon-connector';
	readonly name = 'Mastodon Connector';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'connector';
	readonly capabilities = [
		PLUGIN_CAPABILITIES.CONNECTOR,
		PLUGIN_CAPABILITIES.CONNECTOR_MASTODON,
		PLUGIN_CAPABILITIES.EVENT_SOURCE
	] as const;

	readonly providerName = 'mastodon';

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
		required: ['instanceUrl', 'accessToken'],
		properties: {
			instanceUrl: {
				type: 'string',
				title: 'Mastodon instance URL (e.g. https://mastodon.social)'
			},
			accessToken: {
				type: 'string',
				title: 'Mastodon application access token',
				'x-secret': true,
				'x-envVar': 'MASTODON_ACCESS_TOKEN'
			},
			defaultVisibility: {
				type: 'string',
				title: 'Visibility applied to outbound statuses',
				default: 'public',
				enum: [...MASTODON_VISIBILITIES]
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
		// No-op — no warm-up resources; a client is created per call.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
	}

	/** Testable seam — specs stub this; production uses the real SDK. */
	protected createClient(instanceUrl: string, accessToken: string): MastodonClientLike {
		return createRestAPIClient({ url: instanceUrl, accessToken }) as unknown as MastodonClientLike;
	}

	/**
	 * Build a client for the operator's instance. The instance URL is
	 * user-supplied, so it passes the shared SSRF guard before any
	 * request is issued.
	 */
	private connect(credentials: MastodonCredentials): MastodonClientLike {
		if (!isSafeWebhookUrl(credentials.instanceUrl)) {
			throw new Error(`mastodon-connector: refusing to use an unsafe instance URL '${credentials.instanceUrl}'`);
		}
		return this.createClient(credentials.instanceUrl, credentials.accessToken);
	}

	async verifyConnection(config: ChannelTargetConfig, options: ConnectorCallOptions): Promise<ChannelVerification> {
		const credentials = resolveCredentials(config, options);
		if (!credentials) {
			return { valid: false, message: 'instanceUrl and accessToken are required' };
		}
		try {
			const account = await this.connect(credentials).v1.accounts.verifyCredentials();
			return {
				valid: true,
				details: {
					instanceUrl: credentials.instanceUrl,
					...(account?.id ? { accountId: account.id } : {}),
					...(account?.acct ? { acct: account.acct } : {}),
					...(account?.displayName ? { displayName: account.displayName } : {})
				}
			};
		} catch (err) {
			return { valid: false, message: `Mastodon verifyCredentials failed: ${mastodonErrorMessage(err)}` };
		}
	}

	/** Outbound leg — publish a status (or a threaded reply). */
	async send(payload: ChannelSendInput, options: ConnectorCallOptions): Promise<ChannelSendResult> {
		const config = payload.target ?? options.target ?? {};
		const credentials = resolveCredentials(config, options);
		if (!credentials) {
			throw new Error(
				'mastodon-connector: instanceUrl and accessToken are required ' +
					'(targetConfig.instanceUrl/accessToken or settings.instanceUrl/accessToken)'
			);
		}
		const inReplyToId = firstString([config.inReplyToId]);
		const visibility = resolveVisibility(config.visibility ?? options.settings?.defaultVisibility);

		// Idempotency: scope the key to connectorId + thread + messageRef with a
		// NUL separator so components can't collide across tenants (mirrors the
		// slack-connector hardening — this plugin is a module-level singleton).
		const cacheKey = `${options.connectorId ?? ''}\0${inReplyToId ?? ''}\0${payload.messageRef}`;
		const cached = this.idempotencyCache.get(cacheKey);
		if (cached) return cached;

		let statusId: string | undefined;
		try {
			const status = await this.connect(credentials).v1.statuses.create({
				status: payload.text,
				visibility,
				...(inReplyToId ? { inReplyToId } : {})
			});
			statusId = typeof status?.id === 'string' ? status.id : undefined;
		} catch (err) {
			throw new Error(`Mastodon status create failed: ${mastodonErrorMessage(err)}`);
		}

		const result: ChannelSendResult = {
			provider: this.id,
			providerMessageId: statusId ?? `mastodon-${payload.messageRef}`,
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
	 * statuses) since the effective watermark, normalized to envelopes.
	 * The returned cursor resumes the same phase (Mastodon `max_id`) or
	 * advances to the next; no cursor means the sweep is done.
	 *
	 * First pull (epoch/absent watermark, no cursor): the window is
	 * `now - backfillDays` when the opt-in backfill is on, otherwise
	 * `now` — history stays untouched unless the user asked for it.
	 */
	async pullEvents(input: EventSourcePullInput): Promise<EventSourcePullResult> {
		const instanceUrl = input.settings?.instanceUrl;
		const accessToken = input.settings?.accessToken;
		if (typeof instanceUrl !== 'string' || instanceUrl.length === 0) {
			throw new EventSourceNotConfiguredError(
				'mastodon-connector: settings.instanceUrl is required to pull events'
			);
		}
		if (typeof accessToken !== 'string' || accessToken.length === 0) {
			throw new EventSourceNotConfiguredError(
				'mastodon-connector: settings.accessToken is required to pull events'
			);
		}

		const cursor = parsePullCursor(input.cursor);
		let phase: 'notifications' | 'statuses';
		let maxId: string | undefined;
		let since: string;
		let backfill: boolean;
		let pagesUsed: number;

		if (cursor) {
			phase = cursor.p;
			maxId = cursor.n;
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
			maxId = undefined;
			pagesUsed = 0;
		}

		const client = this.connect({ instanceUrl, accessToken });
		const sinceMs = Date.parse(since);
		const events: IngestedEventEnvelope[] = [];
		let lastId: string | undefined;
		let pageSize = 0;
		let stopSweep = false;

		if (phase === 'notifications') {
			const notifications = await client.v1.notifications.list({
				limit: MASTODON_PULL_PAGE_SIZE,
				...(maxId ? { maxId } : {})
			});
			pageSize = notifications.length;
			for (const notification of notifications) {
				lastId = notification.id ?? lastId;
				const createdMs = Date.parse(notification.createdAt ?? '');
				if (Number.isFinite(createdMs) && createdMs < sinceMs) {
					stopSweep = true;
					break;
				}
				const envelope = this.normalizeNotification(notification);
				if (envelope) events.push(envelope);
			}
		} else {
			const account = await client.v1.accounts.verifyCredentials();
			const accountId = account?.id;
			if (!accountId) {
				throw new EventSourceNotConfiguredError(
					'mastodon-connector: the access token resolved to no account — re-authorize the application'
				);
			}
			const statuses = await client.v1.accounts.$select(accountId).statuses.list({
				limit: MASTODON_PULL_PAGE_SIZE,
				...(maxId ? { maxId } : {})
			});
			pageSize = statuses.length;
			for (const status of statuses) {
				lastId = status.id ?? lastId;
				const createdMs = Date.parse(status.createdAt ?? '');
				if (Number.isFinite(createdMs) && createdMs < sinceMs) {
					stopSweep = true;
					break;
				}
				const envelope = this.normalizeStatus(status);
				if (envelope) events.push(envelope);
			}
		}

		pagesUsed += 1;
		const pageBudgetExhausted = backfill && pagesUsed >= MASTODON_BACKFILL_MAX_PAGES;
		// A short page means the timeline is exhausted; only a FULL page can
		// have more behind it.
		const mayHaveMore = pageSize >= MASTODON_PULL_PAGE_SIZE && lastId !== undefined;

		let next: MastodonPullCursor | undefined;
		if (!stopSweep && mayHaveMore && !pageBudgetExhausted) {
			next = { p: phase, n: lastId, s: since, ...(backfill ? { f: 1 as const } : {}), b: pagesUsed };
		} else if (phase === 'notifications') {
			// Advance to the own-statuses phase (page counter resets per phase).
			next = { p: 'statuses', s: since, ...(backfill ? { f: 1 as const } : {}), b: 0 };
		}

		return next ? { events, nextCursor: JSON.stringify(next) } : { events };
	}

	private normalizeNotification(notification: MastodonNotification): IngestedEventEnvelope | null {
		if (!notification.id) return null;
		const occurredAt = toIso(notification.createdAt);
		const type = notification.type ?? 'unknown';
		const account = notification.account ?? {};
		const text = stripStatusHtml(notification.status?.content);
		const sourceUrl = notification.status?.url ?? account.url;

		return {
			id: randomUUID(),
			source: this.id,
			sourceEventId: `notification:${notification.id}`,
			kind: 'mastodon.notification',
			occurredAt,
			...(account.acct || account.displayName
				? {
						actor: {
							name: account.displayName ?? account.acct ?? 'unknown',
							...(account.id ? { externalId: account.id } : {})
						}
					}
				: {}),
			subject: {
				type: notification.status?.id ? 'status' : 'account',
				externalId: notification.status?.id ?? account.id ?? notification.id,
				...(text ? { title: truncateText(text) } : {})
			},
			...(sourceUrl ? { sourceUrl } : {}),
			payload: {
				notificationType: type,
				notificationId: notification.id,
				...(notification.status?.id ? { statusId: notification.status.id } : {}),
				...(account.id ? { accountId: account.id } : {}),
				...(account.acct ? { acct: account.acct } : {}),
				...(text ? { text: truncateText(text) } : {}),
				createdAt: occurredAt
			}
		};
	}

	private normalizeStatus(status: MastodonStatus): IngestedEventEnvelope | null {
		if (!status.id) return null;
		const occurredAt = toIso(status.createdAt);
		const account = status.account ?? {};
		const text = stripStatusHtml(status.content);

		return {
			id: randomUUID(),
			source: this.id,
			sourceEventId: `status:${status.id}`,
			kind: 'mastodon.status',
			occurredAt,
			...(account.acct || account.displayName
				? {
						actor: {
							name: account.displayName ?? account.acct ?? 'unknown',
							...(account.id ? { externalId: account.id } : {})
						}
					}
				: {}),
			subject: {
				type: 'status',
				externalId: status.id,
				...(text ? { title: truncateText(text) } : {})
			},
			...(status.url ? { sourceUrl: status.url } : {}),
			payload: {
				statusId: status.id,
				...(status.uri ? { uri: status.uri } : {}),
				...(status.visibility ? { visibility: status.visibility } : {}),
				...(account.acct ? { acct: account.acct } : {}),
				...(text ? { text: truncateText(text) } : {}),
				...(typeof status.repliesCount === 'number' ? { repliesCount: status.repliesCount } : {}),
				...(typeof status.reblogsCount === 'number' ? { reblogsCount: status.reblogsCount } : {}),
				...(typeof status.favouritesCount === 'number' ? { favouritesCount: status.favouritesCount } : {}),
				createdAt: occurredAt
			}
		};
	}
}

export const mastodonConnectorPlugin = new MastodonConnectorPlugin();
