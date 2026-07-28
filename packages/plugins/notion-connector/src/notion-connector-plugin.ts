import { randomUUID } from 'node:crypto';
import { Client } from '@notionhq/client';
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
	EventSourceBackfillInput,
	EventSourceBackfillResult,
	PluginCategory,
	PluginSettings,
	JsonSchema
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES, EventSourceNotConfiguredError, clampEventSourceBackfillDays } from '@ever-works/plugin';
import type { IngestedEventEnvelope } from '@ever-works/contracts';

/**
 * Payload text cap for ingested envelopes. Envelope payloads are
 * size-capped platform-side (32 KB serialized); a page title never
 * needs more than this to be useful in Memory/Activities.
 */
export const NOTION_EVENT_TEXT_MAX_CHARS = 4000;

/** Items requested per Notion page of results. */
export const NOTION_PULL_PAGE_SIZE = 50;

/**
 * Historical backfill bound: at most this many result pages per phase
 * (per database, or for the workspace search sweep) during the opt-in
 * first-pull backfill, so activation never becomes an unbounded crawl.
 */
export const NOTION_BACKFILL_MAX_PAGES = 10;

/**
 * Clamp the opt-in backfill window to the supported 0–90 day range.
 *
 * Delegates to the shared capability helper so the bound is stated once
 * for the whole connector fabric; the local export stays because it is
 * part of this plugin's published surface.
 */
export function clampBackfillDays(value: unknown): number {
	return clampEventSourceBackfillDays(value);
}

function truncateText(text: string): string {
	return text.length > NOTION_EVENT_TEXT_MAX_CHARS ? text.slice(0, NOTION_EVENT_TEXT_MAX_CHARS) : text;
}

/** Parse the database filter list: comma/space separated ids → array. */
function resolveDatabaseIds(settings: PluginSettings | undefined): string[] {
	const raw = settings?.databaseIds;
	if (typeof raw === 'string' && raw.trim().length > 0) {
		return raw
			.split(/[\s,]+/)
			.map((d) => d.trim())
			.filter((d) => d.length > 0);
	}
	return [];
}

/** Extract a readable message from a `@notionhq/client` error. */
function notionErrorMessage(err: unknown): string {
	const e = err as { code?: string; message?: string };
	return e.message ?? e.code ?? 'unknown error';
}

/** True when the error means the integration token cannot comment. */
function isCommentCapabilityError(err: unknown): boolean {
	const code = (err as { code?: string }).code;
	return code === 'restricted_resource' || code === 'insufficient_permissions' || code === 'unauthorized';
}

/**
 * Opaque pull cursor. `m` is the sweep mode (`search` workspace-wide,
 * `db` for the configured-databases sweep), `d` the current database
 * id in `db` mode, `n` Notion's own page cursor, `s` the effective
 * since-watermark the sweep was started with (later pages of the same
 * sweep keep the SAME window), `f` flags a first-pull backfill sweep
 * and `b` counts result pages used in the current phase (backfill
 * bound). Malformed input restarts the sweep — safe, the ingest
 * pipeline dedupes on `(source, sourceEventId)`.
 */
interface NotionPullCursor {
	m: 'search' | 'db';
	d?: string;
	n?: string;
	s: string;
	f?: 1;
	b?: number;
}

function parsePullCursor(cursor: string | undefined): NotionPullCursor | undefined {
	if (!cursor) return undefined;
	try {
		const parsed = JSON.parse(cursor) as NotionPullCursor;
		if (parsed && (parsed.m === 'search' || parsed.m === 'db') && typeof parsed.s === 'string') {
			return parsed;
		}
	} catch {
		// fall through — treat as no cursor
	}
	return undefined;
}

/** Minimal shape of a Notion page object we consume. */
interface NotionPageObject {
	object?: string;
	id?: string;
	url?: string;
	created_time?: string;
	last_edited_time?: string;
	parent?: { type?: string; database_id?: string; page_id?: string };
	properties?: Record<string, { type?: string; title?: Array<{ plain_text?: string }> }>;
}

interface NotionResultPage {
	results?: NotionPageObject[];
	has_more?: boolean;
	next_cursor?: string | null;
}

/** The subset of the `@notionhq/client` surface this plugin calls. */
interface NotionClientLike {
	users: { me(args: Record<string, unknown>): Promise<{ id?: string; name?: string | null }> };
	search(args: Record<string, unknown>): Promise<NotionResultPage>;
	databases: { query(args: Record<string, unknown>): Promise<NotionResultPage> };
	comments: { create(args: Record<string, unknown>): Promise<{ id?: string }> };
}

function resolveApiKey(config: ChannelTargetConfig, options: ConnectorCallOptions): string | undefined {
	const candidates = [config.apiKey, options.settings?.apiKey];
	for (const c of candidates) {
		if (typeof c === 'string' && c.length > 0) return c;
	}
	return undefined;
}

/**
 * Resolve the destination page id for an outbound comment. A per-send
 * `pageId` overrides the connection's `defaultPageId`; the resolved
 * plugin `settings` default is the final fallback.
 */
function resolvePageId(config: ChannelTargetConfig, options: ConnectorCallOptions): string {
	const candidates = [config.pageId, config.defaultPageId, options.settings?.defaultPageId];
	for (const c of candidates) {
		if (typeof c === 'string' && c.length > 0) return c;
	}
	throw new Error('notion-connector: a page id is required (targetConfig.pageId or defaultPageId)');
}

/** Best-effort page title from the `title`-typed property. */
export function extractPageTitle(page: NotionPageObject): string | undefined {
	const properties = page.properties ?? {};
	for (const prop of Object.values(properties)) {
		if (prop?.type === 'title' && Array.isArray(prop.title)) {
			const title = prop.title
				.map((t) => t?.plain_text ?? '')
				.join('')
				.trim();
			if (title.length > 0) return title;
		}
	}
	return undefined;
}

/**
 * Notion connector (Wave 8) — first-party native connector.
 *
 * Outbound: appends a comment to a Notion page via `comments.create`
 * on the official `@notionhq/client` (integration-token auth; the SDK
 * pins the API host, so there is no SSRF surface). Integrations
 * without comment capabilities fail with a clear, actionable error.
 *
 * Event source: `pullEvents` sweeps pages created/edited since the
 * watermark — per configured database (`databases.query`, server-side
 * `last_edited_time` filter) or workspace-wide (`search`, sorted by
 * `last_edited_time` descending with client-side windowing, since the
 * search API cannot filter by time) — normalized into
 * `IngestedEventEnvelope`s (`notion.page`, page url as `sourceUrl`)
 * for the platform's event-ingest spine. The opt-in historical
 * backfill (`backfillDays`, default 0 = off, max 90) widens the FIRST
 * pull's window only, with a per-phase page bound. Re-delivery across
 * overlapping windows is fine — the ingest pipeline dedupes on
 * `(source, sourceEventId)`.
 */
export class NotionConnectorPlugin implements IConnectorPlugin, IEventSourcePlugin {
	readonly id = 'notion-connector';
	readonly name = 'Notion Connector';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'connector';
	readonly capabilities = [
		PLUGIN_CAPABILITIES.CONNECTOR,
		PLUGIN_CAPABILITIES.CONNECTOR_NOTION,
		PLUGIN_CAPABILITIES.EVENT_SOURCE
	] as const;

	readonly providerName = 'notion';

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
		required: ['apiKey'],
		properties: {
			apiKey: {
				type: 'string',
				title: 'Notion integration token (ntn_… / secret_…)',
				'x-secret': true,
				'x-envVar': 'NOTION_API_KEY'
			},
			databaseIds: {
				type: 'string',
				title: 'Database ids to ingest pages from (comma-separated; workspace-wide search when empty)'
			},
			backfillDays: {
				type: 'number',
				title: 'Historical backfill window in days on first pull (0 = off, max 90)',
				default: 0,
				minimum: 0,
				maximum: 90
			},
			defaultPageId: {
				type: 'string',
				title: 'Default page id for outbound comments'
			}
		}
	};

	private readonly idempotencyCache = new Map<string, ChannelSendResult>();

	async onLoad(): Promise<void> {
		// No-op — no warm-up resources; a Client is created per call.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
	}

	/** Testable seam — specs stub this; production uses the real SDK. */
	protected createClient(apiKey: string): NotionClientLike {
		return new Client({ auth: apiKey }) as unknown as NotionClientLike;
	}

	async verifyConnection(config: ChannelTargetConfig, options: ConnectorCallOptions): Promise<ChannelVerification> {
		const apiKey = resolveApiKey(config, options);
		if (!apiKey) {
			return { valid: false, message: 'apiKey is required' };
		}
		try {
			const me = await this.createClient(apiKey).users.me({});
			return {
				valid: true,
				details: {
					botId: me?.id,
					...(me?.name ? { botName: me.name } : {})
				}
			};
		} catch (err) {
			return { valid: false, message: `Notion users.me failed: ${notionErrorMessage(err)}` };
		}
	}

	/** Outbound leg — append a comment to a Notion page. */
	async send(payload: ChannelSendInput, options: ConnectorCallOptions): Promise<ChannelSendResult> {
		const config = payload.target ?? options.target ?? {};
		const apiKey = resolveApiKey(config, options);
		if (!apiKey) {
			throw new Error('notion-connector: an API key is required (targetConfig.apiKey or settings.apiKey)');
		}
		const pageId = resolvePageId(config, options);

		// Idempotency: scope the key to connectorId + page + messageRef with a
		// NUL separator so components can't collide across tenants (mirrors the
		// slack-connector hardening — this plugin is a module-level singleton).
		const cacheKey = `${options.connectorId ?? ''}\0${pageId}\0${payload.messageRef}`;
		const cached = this.idempotencyCache.get(cacheKey);
		if (cached) return cached;

		let commentId: string | undefined;
		try {
			const res = await this.createClient(apiKey).comments.create({
				parent: { page_id: pageId },
				rich_text: [{ type: 'text', text: { content: payload.text } }]
			});
			commentId = typeof res?.id === 'string' ? res.id : undefined;
		} catch (err) {
			if (isCommentCapabilityError(err)) {
				// The comments endpoint is capability-gated per integration —
				// surface exactly what to fix instead of a generic failure.
				throw new Error(
					'notion-connector: the integration token cannot comment on this page — grant the ' +
						`integration "Insert comments" capabilities and share the page with it (${notionErrorMessage(err)})`
				);
			}
			throw new Error(`Notion comments.create failed: ${notionErrorMessage(err)}`);
		}

		const result: ChannelSendResult = {
			provider: this.id,
			providerMessageId: commentId ?? `notion-${payload.messageRef}`,
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
	 * Pull one result page of the current sweep, normalized to
	 * envelopes. With `databaseIds` configured the sweep visits each
	 * database in turn (server-side `last_edited_time` filter);
	 * otherwise a workspace `search` sorted by `last_edited_time`
	 * descending is windowed client-side and stops at the first result
	 * older than the watermark. No returned cursor means the sweep is
	 * done.
	 *
	 * First pull (epoch/absent watermark, no cursor): the window is
	 * `now - backfillDays` when the opt-in backfill is on, otherwise
	 * `now` — history stays untouched unless the user asked for it.
	 */
	async pullEvents(input: EventSourcePullInput): Promise<EventSourcePullResult> {
		const apiKey = input.settings?.apiKey;
		if (typeof apiKey !== 'string' || apiKey.length === 0) {
			throw new EventSourceNotConfiguredError('notion-connector: settings.apiKey is required to pull events');
		}

		const databaseIds = resolveDatabaseIds(input.settings);
		const cursor = parsePullCursor(input.cursor);
		let since: string;
		let backfill: boolean;
		let pagesUsed: number;
		let after: string | undefined;
		let mode: 'search' | 'db';
		let databaseId: string | undefined;

		if (cursor) {
			since = cursor.s;
			backfill = cursor.f === 1;
			pagesUsed = cursor.b ?? 0;
			after = cursor.n;
			mode = cursor.m;
			databaseId = cursor.d;
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
			pagesUsed = 0;
			after = undefined;
			mode = databaseIds.length > 0 ? 'db' : 'search';
			databaseId = databaseIds[0];
		}

		const client = this.createClient(apiKey);
		const events: IngestedEventEnvelope[] = [];
		let hasMore = false;
		let nextNotionCursor: string | undefined;
		let stopSweep = false;

		if (mode === 'db') {
			// A database dropped from settings mid-sweep restarts at the first.
			let dbIndex = databaseId ? databaseIds.indexOf(databaseId) : 0;
			if (dbIndex === -1) dbIndex = 0;
			databaseId = databaseIds[dbIndex];
			if (!databaseId) {
				// Valid outbound-only configuration — nothing to pull.
				return { events: [] };
			}
			const page = await client.databases.query({
				database_id: databaseId,
				page_size: NOTION_PULL_PAGE_SIZE,
				...(after ? { start_cursor: after } : {}),
				filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } },
				sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }]
			});
			for (const result of page.results ?? []) {
				const envelope = this.normalizePage(result, since, databaseId);
				if (envelope) events.push(envelope);
			}
			hasMore = page.has_more === true && typeof page.next_cursor === 'string';
			nextNotionCursor = typeof page.next_cursor === 'string' ? page.next_cursor : undefined;

			pagesUsed += 1;
			const budgetExhausted = backfill && pagesUsed >= NOTION_BACKFILL_MAX_PAGES;
			let next: NotionPullCursor | undefined;
			if (hasMore && nextNotionCursor && !budgetExhausted) {
				next = {
					m: 'db',
					d: databaseId,
					n: nextNotionCursor,
					s: since,
					...(backfill ? { f: 1 as const } : {}),
					b: pagesUsed
				};
			} else if (dbIndex + 1 < databaseIds.length) {
				// Advance to the next database (page counter resets per phase).
				next = {
					m: 'db',
					d: databaseIds[dbIndex + 1],
					s: since,
					...(backfill ? { f: 1 as const } : {}),
					b: 0
				};
			}
			return next ? { events, nextCursor: JSON.stringify(next) } : { events };
		}

		// Workspace-wide search sweep. The search API cannot filter by
		// time, so we sort newest-first and stop at the first result that
		// falls behind the window.
		const page = await client.search({
			filter: { property: 'object', value: 'page' },
			sort: { direction: 'descending', timestamp: 'last_edited_time' },
			page_size: NOTION_PULL_PAGE_SIZE,
			...(after ? { start_cursor: after } : {})
		});
		for (const result of page.results ?? []) {
			const editedMs = Date.parse(result.last_edited_time ?? '');
			if (Number.isFinite(editedMs) && editedMs < Date.parse(since)) {
				stopSweep = true;
				break;
			}
			const envelope = this.normalizePage(result, since);
			if (envelope) events.push(envelope);
		}
		hasMore = page.has_more === true && typeof page.next_cursor === 'string';
		nextNotionCursor = typeof page.next_cursor === 'string' ? page.next_cursor : undefined;

		pagesUsed += 1;
		const budgetExhausted = backfill && pagesUsed >= NOTION_BACKFILL_MAX_PAGES;
		let next: NotionPullCursor | undefined;
		if (!stopSweep && hasMore && nextNotionCursor && !budgetExhausted) {
			next = {
				m: 'search',
				n: nextNotionCursor,
				s: since,
				...(backfill ? { f: 1 as const } : {}),
				b: pagesUsed
			};
		}
		return next ? { events, nextCursor: JSON.stringify(next) } : { events };
	}

	/**
	 * Bounded HISTORICAL sweep from an explicit `since` — the
	 * capability's opt-in `backfill()` method.
	 *
	 * Before this method existed, history was reachable only as a side
	 * effect of the FIRST pull (`settings.backfillDays` widening the
	 * initial window), so a user who activated the connector without the
	 * setting could never go back and fetch it. `backfill()` runs the
	 * same sweep (configured databases, else workspace search)
	 * out-of-band on a caller-chosen window, as many times as wanted —
	 * re-delivery is free because the ingest pipeline dedupes on
	 * `(source, sourceEventId)`.
	 *
	 * `until` is accepted for contract symmetry but NOT applied: the
	 * Notion filter bounds only the near end
	 * (`last_edited_time on_or_after`). An over-wide window costs
	 * duplicate deliveries, which the pipeline drops — never wrong data.
	 *
	 * The per-phase page bound (`NOTION_BACKFILL_MAX_PAGES`) applies here
	 * too: one call fetches ONE page and hands back a cursor, so a large
	 * workspace can never turn a backfill into an unbounded crawl.
	 */
	async backfill(input: EventSourceBackfillInput): Promise<EventSourceBackfillResult> {
		const sinceMs = Date.parse(input.since);
		if (!Number.isFinite(sinceMs)) {
			throw new EventSourceNotConfiguredError(
				`notion-connector: backfill requires a valid ISO 8601 "since" (received ${JSON.stringify(input.since)})`
			);
		}

		// Resume the caller's cursor, or open the sweep the same way a
		// first pull does: configured databases when present, otherwise
		// the workspace search. `f: 1` marks it a backfill sweep so the
		// page bound engages.
		const databaseIds = resolveDatabaseIds(input.settings);
		const cursor =
			input.cursor ??
			JSON.stringify({
				m: databaseIds.length > 0 ? 'db' : 'search',
				...(databaseIds[0] ? { d: databaseIds[0] } : {}),
				s: new Date(sinceMs).toISOString(),
				f: 1 as const,
				b: 0
			} satisfies NotionPullCursor);

		const page = await this.pullEvents({
			since: input.since,
			cursor,
			...(input.settings ? { settings: input.settings } : {})
		});

		return page.nextCursor
			? { events: page.events, nextCursor: page.nextCursor }
			: { events: page.events, complete: true };
	}

	private normalizePage(page: NotionPageObject, since: string, databaseId?: string): IngestedEventEnvelope | null {
		if (page.object !== 'page' || !page.id) return null;
		const lastEdited = page.last_edited_time ?? page.created_time;
		const editedMs = Date.parse(lastEdited ?? '');
		if (!Number.isFinite(editedMs)) return null;
		const occurredAt = new Date(editedMs).toISOString();
		const createdMs = Date.parse(page.created_time ?? '');
		const changeType = Number.isFinite(createdMs) && createdMs >= Date.parse(since) ? 'created' : 'edited';
		const title = extractPageTitle(page);
		const resolvedDatabaseId = databaseId ?? page.parent?.database_id;

		return {
			id: randomUUID(),
			source: this.id,
			sourceEventId: `${page.id}:${occurredAt}`,
			kind: 'notion.page',
			occurredAt,
			subject: {
				type: 'page',
				externalId: page.id,
				...(title ? { title } : {})
			},
			// Work routing: the owning database is the container. Pages
			// outside any database (workspace-root pages) carry no hint
			// and stay user-scoped.
			...(resolvedDatabaseId
				? {
						workHint: {
							kind: 'doc-database' as const,
							externalId: resolvedDatabaseId,
							...(title ? { label: title } : {})
						}
					}
				: {}),
			...(page.url ? { sourceUrl: page.url } : {}),
			payload: {
				pageId: page.id,
				...(title ? { title: truncateText(title) } : {}),
				changeType,
				...(page.created_time ? { createdTime: page.created_time } : {}),
				lastEditedTime: occurredAt,
				...(resolvedDatabaseId ? { databaseId: resolvedDatabaseId } : {})
			}
		};
	}
}

export const notionConnectorPlugin = new NotionConnectorPlugin();
