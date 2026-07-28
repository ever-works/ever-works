import { randomUUID } from 'node:crypto';
// The official SDK exposes both Pipedrive API generations behind their
// own subpaths, and the surfaces this connector needs are split across
// them: `/recents`, notes and the current-user probe only exist in v1,
// while record creation moved to v2. Import both rather than hand-roll
// the missing calls.
import { Configuration as ConfigurationV1, NotesApi, RecentsApi, UsersApi } from 'pipedrive/v1';
import { Configuration as ConfigurationV2, DealsApi, OrganizationsApi, PersonsApi } from 'pipedrive/v2';
import type {
	IConnectorPlugin,
	IEventSourcePlugin,
	ConnectorMetadata,
	ConnectorCallOptions,
	ConnectorRecordInput,
	ConnectorRecordResult,
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

/**
 * Payload text cap for ingested envelopes. Envelope payloads are
 * size-capped platform-side (32 KB serialized); a CRM field value never
 * needs more than this to be useful in Memory/Activities.
 */
export const PIPEDRIVE_EVENT_TEXT_MAX_CHARS = 4000;

/** Records requested per `/recents` page. */
export const PIPEDRIVE_PULL_PAGE_SIZE = 50;

/**
 * Historical backfill bound: at most this many pages per phase (per
 * entity type) during the opt-in first-pull backfill, so a large
 * account can never turn activation into an unbounded crawl.
 */
export const PIPEDRIVE_BACKFILL_MAX_PAGES = 10;

/** Entity types this connector understands, in sweep order. */
export const PIPEDRIVE_ENTITY_TYPES = ['deals', 'persons', 'organizations'] as const;
export type PipedriveEntityType = (typeof PIPEDRIVE_ENTITY_TYPES)[number];

/** Per-entity ingest / deep-link / note-association metadata. */
interface PipedriveEntityMeta {
	/** Envelope `kind` (source-namespaced, singular). */
	readonly kind: string;
	/** Value the `/recents` `items` filter expects. */
	readonly recentsItem: string;
	/** Path segment in a Pipedrive web deep link. */
	readonly urlSegment: string;
	/** Field carrying the human title on the record. */
	readonly titleField: string;
	/** Field the note payload uses to attach to this entity. */
	readonly noteField: string;
	/** Non-custom fields copied into the envelope payload. */
	readonly payloadFields: readonly string[];
}

export const PIPEDRIVE_ENTITY_META: Readonly<Record<PipedriveEntityType, PipedriveEntityMeta>> = {
	deals: {
		kind: 'pipedrive.deal',
		recentsItem: 'deal',
		urlSegment: 'deal',
		titleField: 'title',
		noteField: 'deal_id',
		payloadFields: ['title', 'status', 'stage_id', 'pipeline_id', 'value', 'currency', 'add_time', 'update_time']
	},
	persons: {
		kind: 'pipedrive.person',
		recentsItem: 'person',
		urlSegment: 'person',
		titleField: 'name',
		noteField: 'person_id',
		payloadFields: ['name', 'org_id', 'owner_id', 'add_time', 'update_time']
	},
	organizations: {
		kind: 'pipedrive.organization',
		recentsItem: 'organization',
		urlSegment: 'organization',
		titleField: 'name',
		noteField: 'org_id',
		payloadFields: ['name', 'address', 'owner_id', 'people_count', 'add_time', 'update_time']
	}
};

/** Clamp the opt-in backfill window to the supported 0–90 day range. */
export function clampBackfillDays(value: unknown): number {
	const num = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(num) || num <= 0) return 0;
	return Math.min(Math.floor(num), 90);
}

function truncateText(text: string): string {
	return text.length > PIPEDRIVE_EVENT_TEXT_MAX_CHARS ? text.slice(0, PIPEDRIVE_EVENT_TEXT_MAX_CHARS) : text;
}

/**
 * Which entity types to sweep. Unknown entries are dropped; an empty or
 * absent setting means "all three", matching the manifest default.
 */
export function resolveEntityTypes(settings: PluginSettings | undefined): PipedriveEntityType[] {
	const raw = settings?.entityTypes;
	if (typeof raw !== 'string' || raw.trim().length === 0) return [...PIPEDRIVE_ENTITY_TYPES];
	const requested = raw
		.split(/[\s,]+/)
		.map((t) => t.trim().toLowerCase())
		.filter((t): t is PipedriveEntityType => (PIPEDRIVE_ENTITY_TYPES as readonly string[]).includes(t));
	return requested.length > 0
		? [...PIPEDRIVE_ENTITY_TYPES].filter((t) => requested.includes(t))
		: [...PIPEDRIVE_ENTITY_TYPES];
}

/**
 * Pipedrive timestamps are `YYYY-MM-DD HH:MM:SS` in UTC without a zone
 * marker, which `Date.parse` would read as LOCAL time. Normalize to a
 * real ISO instant (epoch on garbage, so an envelope never carries NaN).
 */
export function pipedriveTimeToIso(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'string' && value.trim().length > 0) {
		const raw = value.trim();
		const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw;
		const ms = Date.parse(normalized);
		if (Number.isFinite(ms)) return new Date(ms).toISOString();
	}
	return new Date(0).toISOString();
}

/** ISO instant → the `YYYY-MM-DD HH:MM:SS` UTC form `/recents` expects. */
export function isoToPipedriveTime(iso: string): string {
	const ms = Date.parse(iso);
	const date = new Date(Number.isFinite(ms) ? ms : 0);
	return date.toISOString().replace('T', ' ').slice(0, 19);
}

/** Extract a readable message from a `pipedrive` SDK error. */
function pipedriveErrorMessage(err: unknown): string {
	const e = err as {
		message?: string;
		response?: { data?: { error?: string; error_info?: string }; status?: number };
	};
	return (
		e.response?.data?.error ??
		e.message ??
		(typeof e.response?.status === 'number' ? `HTTP ${e.response.status}` : 'unknown error')
	);
}

/**
 * Opaque pull cursor. `t` is the entity type the sweep is on, `n` the
 * `/recents` `next_start` offset, `s` the effective since-watermark the
 * sweep was started with (later pages of the same sweep keep the SAME
 * window), `f` flags a first-pull backfill sweep and `b` counts pages
 * used in the current phase (backfill page bound). Malformed input
 * restarts the sweep — safe, the ingest pipeline dedupes on
 * `(source, sourceEventId)`.
 */
interface PipedrivePullCursor {
	t: PipedriveEntityType;
	n?: number;
	s: string;
	f?: 1;
	b?: number;
}

function parsePullCursor(cursor: string | undefined): PipedrivePullCursor | undefined {
	if (!cursor) return undefined;
	try {
		const parsed = JSON.parse(cursor) as PipedrivePullCursor;
		if (
			parsed &&
			typeof parsed.s === 'string' &&
			(PIPEDRIVE_ENTITY_TYPES as readonly string[]).includes(parsed.t)
		) {
			return parsed;
		}
	} catch {
		// fall through — treat as no cursor
	}
	return undefined;
}

/** One `/recents` entry: the item type plus the record itself. */
interface PipedriveRecentItem {
	item?: string;
	id?: number | string;
	data?: Record<string, unknown>;
}

interface PipedriveRecentsResponse {
	data?: PipedriveRecentItem[] | null;
	additional_data?: {
		pagination?: { start?: number; limit?: number; more_items_in_collection?: boolean; next_start?: number };
	};
}

interface PipedriveIdResponse {
	data?: { id?: number | string } | null;
}

interface PipedriveUserResponse {
	data?: { id?: number | string; name?: string; company_name?: string; company_domain?: string } | null;
}

/** The subset of the Pipedrive SDK surface this plugin calls. */
interface PipedriveClientLike {
	getCurrentUser(): Promise<PipedriveUserResponse>;
	getRecents(params: Record<string, unknown>): Promise<PipedriveRecentsResponse>;
	addNote(payload: Record<string, unknown>): Promise<PipedriveIdResponse>;
	addRecord(entityType: PipedriveEntityType, fields: Record<string, unknown>): Promise<PipedriveIdResponse>;
}

function resolveApiToken(config: ChannelTargetConfig, options: ConnectorCallOptions): string | undefined {
	const candidates = [config.apiToken, options.settings?.apiToken];
	for (const c of candidates) {
		if (typeof c === 'string' && c.length > 0) return c;
	}
	return undefined;
}

/**
 * First usable id among the candidates, in order. Record ids arrive as
 * strings from `targetConfig` but as numbers from the API, so both are
 * accepted and normalized to a string.
 */
function firstString(candidates: unknown[]): string | undefined {
	for (const c of candidates) {
		if (typeof c === 'string' && c.trim().length > 0) return c.trim();
		if (typeof c === 'number' && Number.isFinite(c)) return String(c);
	}
	return undefined;
}

/** Narrow an arbitrary string to a known entity type. */
export function asEntityType(value: unknown): PipedriveEntityType | undefined {
	if (typeof value !== 'string') return undefined;
	const candidate = value.trim().toLowerCase();
	return (PIPEDRIVE_ENTITY_TYPES as readonly string[]).includes(candidate)
		? (candidate as PipedriveEntityType)
		: undefined;
}

/**
 * Resolve which record an outbound note attaches to. A per-send
 * `recordId`/`recordType` overrides the connection default; the
 * resolved plugin `settings` `defaultDealId` is the final fallback.
 */
export function resolveNoteTarget(
	config: ChannelTargetConfig,
	options: ConnectorCallOptions
): { entityType: PipedriveEntityType; recordId: string } {
	const explicitId = firstString([config.recordId, config.dealId]);
	if (explicitId) {
		const entityType = asEntityType(config.recordType) ?? 'deals';
		return { entityType, recordId: explicitId };
	}
	const defaultDealId = firstString([config.defaultDealId, options.settings?.defaultDealId]);
	if (defaultDealId) {
		return { entityType: 'deals', recordId: defaultDealId };
	}
	throw new Error(
		'pipedrive-connector: a record id is required for an outbound note ' +
			'(targetConfig.recordId or settings.defaultDealId)'
	);
}

/**
 * Pipedrive CRM connector — first-party native connector.
 *
 * Outbound: `send` appends a note to a deal / person / organization and
 * `createRecord` writes a new record of any of those types, both through
 * the official `pipedrive` Node SDK (API-token auth; the SDK pins the
 * API host, so there is no SSRF surface).
 *
 * Event source: `pullEvents` sweeps each configured entity type in turn
 * through `/recents` — Pipedrive's own "everything that changed since
 * this timestamp" endpoint — normalized into `IngestedEventEnvelope`s
 * (`pipedrive.deal` / `.person` / `.organization`) for the platform's
 * event-ingest spine. When a `companyDomain` is configured every
 * envelope carries a record deep link as `sourceUrl`. The opt-in
 * historical backfill (`backfillDays`, default 0 = off, max 90) widens
 * the FIRST pull's window only, with a per-phase page bound so
 * activation never becomes an unbounded crawl. Re-delivery across
 * overlapping windows is fine — the ingest pipeline dedupes on
 * `(source, sourceEventId)`.
 *
 * Unconfigured is always LOUD: `verifyConnection` reports the missing
 * token, `send`/`createRecord` throw, and `pullEvents` throws
 * `EventSourceNotConfiguredError`. Nothing silently no-ops.
 */
export class PipedriveConnectorPlugin implements IConnectorPlugin, IEventSourcePlugin {
	readonly id = 'pipedrive-connector';
	readonly name = 'Pipedrive Connector';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'connector';
	readonly capabilities = [
		PLUGIN_CAPABILITIES.CONNECTOR,
		PLUGIN_CAPABILITIES.CONNECTOR_PIPEDRIVE,
		PLUGIN_CAPABILITIES.EVENT_SOURCE
	] as const;

	readonly providerName = 'pipedrive';

	readonly connector: ConnectorMetadata = {
		direction: 'outbound',
		transport: 'poll',
		flags: {
			outboundMessage: true,
			outboundRecord: true,
			inbound: false,
			reply: false,
			pairing: false,
			richOutbound: false
		}
	};

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		required: ['apiToken'],
		properties: {
			apiToken: {
				type: 'string',
				title: 'Pipedrive API token',
				'x-secret': true,
				'x-envVar': 'PIPEDRIVE_API_TOKEN'
			},
			entityTypes: {
				type: 'string',
				title: 'Entity types to ingest (comma-separated; deals, persons, organizations when empty)',
				default: 'deals,persons,organizations'
			},
			companyDomain: {
				type: 'string',
				title: 'Pipedrive company domain (e.g. `acme` for acme.pipedrive.com) — enables deep links'
			},
			backfillDays: {
				type: 'number',
				title: 'Historical backfill window in days on first pull (0 = off, max 90)',
				default: 0,
				minimum: 0,
				maximum: 90
			},
			defaultDealId: {
				type: 'string',
				title: 'Default deal id outbound notes are attached to'
			}
		}
	};

	private readonly idempotencyCache = new Map<string, ChannelSendResult>();
	private readonly recordIdempotencyCache = new Map<string, ConnectorRecordResult>();

	async onLoad(): Promise<void> {
		// No-op — no warm-up resources; a client is created per call.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
		this.recordIdempotencyCache.clear();
	}

	/**
	 * Testable seam — specs stub this; production adapts the official
	 * SDK's per-resource API classes onto the narrow surface above.
	 */
	protected createClient(apiToken: string): PipedriveClientLike {
		const v1 = new ConfigurationV1({ apiKey: apiToken });
		const v2 = new ConfigurationV2({ apiKey: apiToken });
		const users = new UsersApi(v1);
		const recents = new RecentsApi(v1);
		const notes = new NotesApi(v1);
		const deals = new DealsApi(v2);
		const persons = new PersonsApi(v2);
		const organizations = new OrganizationsApi(v2);
		return {
			getCurrentUser: () => users.getCurrentUser() as unknown as Promise<PipedriveUserResponse>,
			getRecents: (params) =>
				recents.getRecents(
					params as unknown as Parameters<RecentsApi['getRecents']>[0]
				) as unknown as Promise<PipedriveRecentsResponse>,
			// The generated SDK wraps every request body in a property
			// named after its schema — `addNote({ AddNoteRequest: {…} })`.
			addNote: (payload) =>
				notes.addNote({
					AddNoteRequest: payload as unknown as NonNullable<
						Parameters<NotesApi['addNote']>[0]
					>['AddNoteRequest']
				}) as unknown as Promise<PipedriveIdResponse>,
			addRecord: (entityType, fields) => {
				if (entityType === 'persons') {
					return persons.addPerson({
						AddPersonRequest: fields as unknown as NonNullable<
							Parameters<PersonsApi['addPerson']>[0]
						>['AddPersonRequest']
					}) as unknown as Promise<PipedriveIdResponse>;
				}
				if (entityType === 'organizations') {
					return organizations.addOrganization({
						AddOrganizationRequest: fields as unknown as NonNullable<
							Parameters<OrganizationsApi['addOrganization']>[0]
						>['AddOrganizationRequest']
					}) as unknown as Promise<PipedriveIdResponse>;
				}
				return deals.addDeal({
					AddDealRequest: fields as unknown as NonNullable<
						Parameters<DealsApi['addDeal']>[0]
					>['AddDealRequest']
				}) as unknown as Promise<PipedriveIdResponse>;
			}
		};
	}

	async verifyConnection(config: ChannelTargetConfig, options: ConnectorCallOptions): Promise<ChannelVerification> {
		const apiToken = resolveApiToken(config, options);
		if (!apiToken) {
			return { valid: false, message: 'apiToken is required' };
		}
		try {
			const me = await this.createClient(apiToken).getCurrentUser();
			const user = me?.data ?? undefined;
			return {
				valid: true,
				details: {
					...(user?.id !== undefined ? { userId: String(user.id) } : {}),
					...(user?.name ? { userName: user.name } : {}),
					...(user?.company_name ? { companyName: user.company_name } : {}),
					...(user?.company_domain ? { companyDomain: user.company_domain } : {})
				}
			};
		} catch (err) {
			return { valid: false, message: `Pipedrive getCurrentUser failed: ${pipedriveErrorMessage(err)}` };
		}
	}

	/** Outbound leg — append a note to a deal / person / organization. */
	async send(payload: ChannelSendInput, options: ConnectorCallOptions): Promise<ChannelSendResult> {
		const config = payload.target ?? options.target ?? {};
		const apiToken = resolveApiToken(config, options);
		if (!apiToken) {
			throw new Error(
				'pipedrive-connector: an API token is required (targetConfig.apiToken or settings.apiToken)'
			);
		}
		const { entityType, recordId } = resolveNoteTarget(config, options);
		const noteField = PIPEDRIVE_ENTITY_META[entityType].noteField;

		// Idempotency: scope the key to connectorId + record + messageRef with a
		// NUL separator so components can't collide across tenants (mirrors the
		// slack-connector hardening — this plugin is a module-level singleton).
		const cacheKey = `${options.connectorId ?? ''}\0${entityType}\0${recordId}\0${payload.messageRef}`;
		const cached = this.idempotencyCache.get(cacheKey);
		if (cached) return cached;

		let noteId: string | undefined;
		try {
			const numericId = Number(recordId);
			const res = await this.createClient(apiToken).addNote({
				content: payload.text,
				[noteField]: Number.isFinite(numericId) ? numericId : recordId
			});
			const id = res?.data?.id;
			noteId = id === undefined || id === null ? undefined : String(id);
		} catch (err) {
			throw new Error(`Pipedrive addNote failed: ${pipedriveErrorMessage(err)}`);
		}

		const result: ChannelSendResult = {
			provider: this.id,
			providerMessageId: noteId ?? `pipedrive-${payload.messageRef}`,
			deliveredAt: new Date()
		};
		this.idempotencyCache.set(cacheKey, result);
		if (this.idempotencyCache.size > 500) {
			const firstKey = this.idempotencyCache.keys().next().value;
			if (firstKey) this.idempotencyCache.delete(firstKey);
		}
		return result;
	}

	/** Outbound record leg — create a deal / person / organization. */
	async createRecord(record: ConnectorRecordInput, options: ConnectorCallOptions): Promise<ConnectorRecordResult> {
		const config = options.target ?? {};
		const apiToken = resolveApiToken(config, options);
		if (!apiToken) {
			throw new Error(
				'pipedrive-connector: an API token is required (targetConfig.apiToken or settings.apiToken)'
			);
		}
		const entityType = asEntityType(record.collection);
		if (!entityType) {
			throw new Error(
				`pipedrive-connector: unsupported collection '${record.collection}' — ` +
					`use one of ${PIPEDRIVE_ENTITY_TYPES.join(', ')}`
			);
		}

		const cacheKey = `${options.connectorId ?? ''}\0${entityType}\0${record.idempotencyKey}`;
		const cached = this.recordIdempotencyCache.get(cacheKey);
		if (cached) return cached;

		let recordId: string | undefined;
		try {
			const res = await this.createClient(apiToken).addRecord(entityType, { ...record.fields });
			const id = res?.data?.id;
			recordId = id === undefined || id === null ? undefined : String(id);
		} catch (err) {
			throw new Error(`Pipedrive ${entityType} create failed: ${pipedriveErrorMessage(err)}`);
		}
		if (!recordId) {
			throw new Error(`Pipedrive ${entityType} create returned no record id`);
		}

		const result: ConnectorRecordResult = { provider: this.id, recordId };
		this.recordIdempotencyCache.set(cacheKey, result);
		if (this.recordIdempotencyCache.size > 500) {
			const firstKey = this.recordIdempotencyCache.keys().next().value;
			if (firstKey) this.recordIdempotencyCache.delete(firstKey);
		}
		return result;
	}

	// ── Event source (pull) ─────────────────────────────────────────────

	/**
	 * Pull one `/recents` page of the current entity-type phase since the
	 * effective watermark, normalized to envelopes. The returned cursor
	 * resumes the same phase (`next_start` offset) or advances to the
	 * next configured entity type; no cursor means the sweep is done.
	 *
	 * First pull (epoch/absent watermark, no cursor): the window is
	 * `now - backfillDays` when the opt-in backfill is on, otherwise
	 * `now` — history stays untouched unless the user asked for it.
	 */
	async pullEvents(input: EventSourcePullInput): Promise<EventSourcePullResult> {
		const apiToken = input.settings?.apiToken;
		if (typeof apiToken !== 'string' || apiToken.length === 0) {
			throw new EventSourceNotConfiguredError(
				'pipedrive-connector: settings.apiToken is required to pull events'
			);
		}

		const entityTypes = resolveEntityTypes(input.settings);
		const cursor = parsePullCursor(input.cursor);
		let entityType: PipedriveEntityType;
		let start: number | undefined;
		let since: string;
		let backfill: boolean;
		let pagesUsed: number;

		if (cursor) {
			entityType = cursor.t;
			start = cursor.n;
			since = cursor.s;
			backfill = cursor.f === 1;
			pagesUsed = cursor.b ?? 0;
		} else {
			const sinceMs = Date.parse(input.since);
			const firstPull = !Number.isFinite(sinceMs) || sinceMs <= 0;
			const backfillDays = clampBackfillDays(input.settings?.backfillDays);
			if (firstPull) {
				const anchor = backfillDays > 0 ? Date.now() - backfillDays * 86400_000 : Date.now();
				since = new Date(anchor).toISOString();
				backfill = backfillDays > 0;
			} else {
				since = new Date(sinceMs).toISOString();
				backfill = false;
			}
			entityType = entityTypes[0];
			start = undefined;
			pagesUsed = 0;
		}

		// A type dropped from settings mid-sweep restarts at the first one.
		let typeIndex = entityTypes.indexOf(entityType);
		if (typeIndex === -1) {
			typeIndex = 0;
			entityType = entityTypes[0];
			start = undefined;
			pagesUsed = 0;
		}

		const meta = PIPEDRIVE_ENTITY_META[entityType];
		const companyDomain =
			typeof input.settings?.companyDomain === 'string' ? input.settings.companyDomain.trim() : undefined;
		const client = this.createClient(apiToken);

		const page = await client.getRecents({
			since_timestamp: isoToPipedriveTime(since),
			items: meta.recentsItem,
			limit: PIPEDRIVE_PULL_PAGE_SIZE,
			...(typeof start === 'number' ? { start } : {})
		});

		const events: IngestedEventEnvelope[] = [];
		for (const item of page.data ?? []) {
			const envelope = this.normalizeRecent(item, entityType, since, companyDomain);
			if (envelope) events.push(envelope);
		}

		const pagination = page.additional_data?.pagination;
		const nextStart =
			pagination?.more_items_in_collection === true && typeof pagination.next_start === 'number'
				? pagination.next_start
				: undefined;

		pagesUsed += 1;
		const pageBudgetExhausted = backfill && pagesUsed >= PIPEDRIVE_BACKFILL_MAX_PAGES;

		let next: PipedrivePullCursor | undefined;
		if (nextStart !== undefined && !pageBudgetExhausted) {
			next = { t: entityType, n: nextStart, s: since, ...(backfill ? { f: 1 as const } : {}), b: pagesUsed };
		} else if (typeIndex + 1 < entityTypes.length) {
			// Advance to the next entity type (page counter resets per phase).
			next = { t: entityTypes[typeIndex + 1], s: since, ...(backfill ? { f: 1 as const } : {}), b: 0 };
		}

		return next ? { events, nextCursor: JSON.stringify(next) } : { events };
	}

	private normalizeRecent(
		item: PipedriveRecentItem,
		entityType: PipedriveEntityType,
		since: string,
		companyDomain: string | undefined
	): IngestedEventEnvelope | null {
		const meta = PIPEDRIVE_ENTITY_META[entityType];
		const data = item.data ?? {};
		const rawId = item.id ?? data.id;
		if (rawId === undefined || rawId === null || rawId === '') return null;
		const recordId = String(rawId);

		const updatedAt = pipedriveTimeToIso(data.update_time ?? data.add_time);
		const createdAt = pipedriveTimeToIso(data.add_time);
		const changeType = Date.parse(createdAt) >= Date.parse(since) ? 'created' : 'updated';
		const rawTitle = data[meta.titleField];
		const title = typeof rawTitle === 'string' && rawTitle.trim().length > 0 ? rawTitle.trim() : undefined;
		const sourceUrl = companyDomain
			? `https://${encodeURIComponent(companyDomain)}.pipedrive.com/${meta.urlSegment}/${encodeURIComponent(recordId)}`
			: undefined;

		return {
			id: randomUUID(),
			source: this.id,
			sourceEventId: `${entityType}:${recordId}:${updatedAt}`,
			kind: meta.kind,
			occurredAt: updatedAt,
			subject: {
				type: 'crm-record',
				externalId: recordId,
				...(title ? { title } : {})
			},
			...(sourceUrl ? { sourceUrl } : {}),
			payload: {
				entityType,
				recordId,
				changeType,
				createdAt,
				updatedAt,
				fields: this.sanitizeFields(data, meta)
			}
		};
	}

	/**
	 * Payload fields are limited to the per-entity whitelist and each
	 * string value is capped, so a record with a huge free-text field can
	 * never blow the envelope byte budget (and custom fields, which can
	 * hold anything, never ride along).
	 */
	private sanitizeFields(data: Record<string, unknown>, meta: PipedriveEntityMeta): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const key of meta.payloadFields) {
			const value = data[key];
			if (value === undefined || value === null) continue;
			if (typeof value === 'string') {
				out[key] = truncateText(value);
			} else if (typeof value === 'number' || typeof value === 'boolean') {
				out[key] = value;
			}
			// Objects (nested owner/org expansions) are intentionally dropped.
		}
		return out;
	}
}

export const pipedriveConnectorPlugin = new PipedriveConnectorPlugin();
