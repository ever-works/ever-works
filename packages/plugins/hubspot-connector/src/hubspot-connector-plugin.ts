import { randomUUID } from 'node:crypto';
import { Client } from '@hubspot/api-client';
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
 * size-capped platform-side (32 KB serialized); a CRM property value
 * never needs more than this to be useful in Memory/Activities.
 */
export const HUBSPOT_EVENT_TEXT_MAX_CHARS = 4000;

/** Records requested per HubSpot search page. */
export const HUBSPOT_PULL_PAGE_SIZE = 50;

/**
 * Historical backfill bound: at most this many search pages per phase
 * (per CRM object type) during the opt-in first-pull backfill, so a
 * large portal can never turn activation into an unbounded crawl.
 */
export const HUBSPOT_BACKFILL_MAX_PAGES = 10;

/** Object types swept when `objectTypes` is left empty. */
export const HUBSPOT_DEFAULT_OBJECT_TYPES = ['contacts', 'companies', 'deals'] as const;

/** Per-object-type ingest/deep-link metadata. */
interface HubSpotObjectMeta {
	/** Envelope `kind` (source-namespaced, singular). */
	readonly kind: string;
	/** Property carrying the record's last-modified timestamp. */
	readonly lastModifiedProperty: string;
	/** Properties requested from search (also the payload whitelist). */
	readonly properties: readonly string[];
	/** Numeric object-type id used in HubSpot record deep links. */
	readonly objectTypeId?: string;
	/**
	 * `associationTypeId` for a HUBSPOT_DEFINED note → record
	 * association. Absent means outbound notes are unsupported for the
	 * type and `send` fails loudly rather than writing an orphan note.
	 */
	readonly noteAssociationTypeId?: number;
}

/**
 * Known first-class CRM object types. Custom objects still work — they
 * fall back to {@link GENERIC_OBJECT_META} (the `hs_lastmodifieddate`
 * property every HubSpot object carries).
 */
export const HUBSPOT_OBJECT_META: Readonly<Record<string, HubSpotObjectMeta>> = {
	contacts: {
		kind: 'hubspot.contact',
		lastModifiedProperty: 'lastmodifieddate',
		properties: ['firstname', 'lastname', 'email', 'company', 'lifecyclestage', 'createdate', 'lastmodifieddate'],
		objectTypeId: '0-1',
		noteAssociationTypeId: 202
	},
	companies: {
		kind: 'hubspot.company',
		lastModifiedProperty: 'hs_lastmodifieddate',
		properties: ['name', 'domain', 'industry', 'createdate', 'hs_lastmodifieddate'],
		objectTypeId: '0-2',
		noteAssociationTypeId: 190
	},
	deals: {
		kind: 'hubspot.deal',
		lastModifiedProperty: 'hs_lastmodifieddate',
		properties: ['dealname', 'dealstage', 'amount', 'pipeline', 'createdate', 'hs_lastmodifieddate'],
		objectTypeId: '0-3',
		noteAssociationTypeId: 214
	}
};

const GENERIC_OBJECT_META: HubSpotObjectMeta = {
	kind: 'hubspot.record',
	lastModifiedProperty: 'hs_lastmodifieddate',
	properties: ['hs_object_id', 'createdate', 'hs_lastmodifieddate']
};

/** Metadata for a type, falling back to the generic custom-object shape. */
export function objectMeta(objectType: string): HubSpotObjectMeta {
	return HUBSPOT_OBJECT_META[objectType] ?? GENERIC_OBJECT_META;
}

/** Clamp the opt-in backfill window to the supported 0–90 day range. */
export function clampBackfillDays(value: unknown): number {
	const num = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(num) || num <= 0) return 0;
	return Math.min(Math.floor(num), 90);
}

function truncateText(text: string): string {
	return text.length > HUBSPOT_EVENT_TEXT_MAX_CHARS ? text.slice(0, HUBSPOT_EVENT_TEXT_MAX_CHARS) : text;
}

/** Parse the object-type list: comma/space separated → array (defaulted). */
export function resolveObjectTypes(settings: PluginSettings | undefined): string[] {
	const raw = settings?.objectTypes;
	if (typeof raw === 'string' && raw.trim().length > 0) {
		const parsed = raw
			.split(/[\s,]+/)
			.map((t) => t.trim())
			.filter((t) => t.length > 0);
		if (parsed.length > 0) return parsed;
	}
	return [...HUBSPOT_DEFAULT_OBJECT_TYPES];
}

/** Extract a readable message from a `@hubspot/api-client` error. */
function hubspotErrorMessage(err: unknown): string {
	const e = err as { message?: string; body?: { message?: string }; code?: number };
	return e.body?.message ?? e.message ?? (typeof e.code === 'number' ? `HTTP ${e.code}` : 'unknown error');
}

/** Date | ISO string | epoch-ms | undefined → ISO 8601 (epoch on garbage). */
function toIso(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
	if (typeof value === 'string') {
		const ms = Date.parse(value);
		if (Number.isFinite(ms)) return new Date(ms).toISOString();
	}
	return new Date(0).toISOString();
}

/**
 * Opaque pull cursor. `t` is the CRM object type the sweep is on, `n`
 * HubSpot's own `paging.next.after`, `s` the effective since-watermark
 * the sweep was started with (later pages of the same sweep keep the
 * SAME window), `f` flags a first-pull backfill sweep and `b` counts
 * pages used in the current phase (backfill page bound). Malformed
 * input restarts the sweep — safe, the ingest pipeline dedupes on
 * `(source, sourceEventId)`.
 */
interface HubSpotPullCursor {
	t: string;
	n?: string;
	s: string;
	f?: 1;
	b?: number;
}

function parsePullCursor(cursor: string | undefined): HubSpotPullCursor | undefined {
	if (!cursor) return undefined;
	try {
		const parsed = JSON.parse(cursor) as HubSpotPullCursor;
		if (parsed && typeof parsed.t === 'string' && parsed.t.length > 0 && typeof parsed.s === 'string') {
			return parsed;
		}
	} catch {
		// fall through — treat as no cursor
	}
	return undefined;
}

/** Minimal shape of a CRM record the search API returns. */
interface HubSpotRecord {
	id?: string;
	properties?: Record<string, unknown>;
	createdAt?: Date | string;
	updatedAt?: Date | string;
	archived?: boolean;
}

interface HubSpotSearchPage {
	results?: HubSpotRecord[];
	paging?: { next?: { after?: string } };
}

/** The subset of the `@hubspot/api-client` surface this plugin calls. */
interface HubSpotClientLike {
	crm: {
		objects: {
			basicApi: {
				create(objectType: string, input: Record<string, unknown>): Promise<{ id?: string }>;
				getPage(objectType: string, limit?: number): Promise<HubSpotSearchPage>;
			};
			searchApi: {
				doSearch(objectType: string, request: Record<string, unknown>): Promise<HubSpotSearchPage>;
			};
		};
	};
}

function resolveAccessToken(config: ChannelTargetConfig, options: ConnectorCallOptions): string | undefined {
	const candidates = [config.accessToken, options.settings?.accessToken];
	for (const c of candidates) {
		if (typeof c === 'string' && c.length > 0) return c;
	}
	return undefined;
}

/** First non-empty string among the candidates. */
function firstString(candidates: unknown[]): string | undefined {
	for (const c of candidates) {
		if (typeof c === 'string' && c.trim().length > 0) return c.trim();
	}
	return undefined;
}

/**
 * Resolve which CRM record an outbound note attaches to. A per-send
 * `associatedObjectId` overrides the connection default; the resolved
 * plugin `settings` default is the final fallback.
 */
export function resolveNoteTarget(
	config: ChannelTargetConfig,
	options: ConnectorCallOptions
): { objectType: string; objectId: string } {
	const objectId = firstString([
		config.associatedObjectId,
		config.defaultAssociatedObjectId,
		options.settings?.defaultAssociatedObjectId
	]);
	if (!objectId) {
		throw new Error(
			'hubspot-connector: a CRM record id is required for an outbound note ' +
				'(targetConfig.associatedObjectId or settings.defaultAssociatedObjectId)'
		);
	}
	const objectType =
		firstString([config.associatedObjectType, config.defaultObjectType, options.settings?.defaultObjectType]) ??
		'contacts';
	return { objectType, objectId };
}

/** Best-effort human title for a record, per object type. */
export function recordTitle(objectType: string, properties: Record<string, unknown> | undefined): string | undefined {
	const props = properties ?? {};
	const str = (key: string): string | undefined => {
		const value = props[key];
		return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
	};
	if (objectType === 'contacts') {
		const name = [str('firstname'), str('lastname')].filter(Boolean).join(' ').trim();
		return name.length > 0 ? name : str('email');
	}
	if (objectType === 'companies') return str('name') ?? str('domain');
	if (objectType === 'deals') return str('dealname');
	return str('name');
}

/**
 * HubSpot CRM connector — first-party native connector.
 *
 * Outbound: `send` appends a Note engagement to a CRM record and
 * `createRecord` writes a contact / company / deal (or a custom
 * object) through the official `@hubspot/api-client` (private-app
 * token auth; the SDK pins the API host, so there is no SSRF surface).
 *
 * Event source: `pullEvents` sweeps each configured CRM object type in
 * turn via the Search API, filtered server-side on the type's
 * last-modified property, normalized into `IngestedEventEnvelope`s
 * (`hubspot.contact` / `.company` / `.deal` / `.record`) for the
 * platform's event-ingest spine. When a `portalId` is configured every
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
export class HubSpotConnectorPlugin implements IConnectorPlugin, IEventSourcePlugin {
	readonly id = 'hubspot-connector';
	readonly name = 'HubSpot Connector';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'connector';
	readonly capabilities = [
		PLUGIN_CAPABILITIES.CONNECTOR,
		PLUGIN_CAPABILITIES.CONNECTOR_HUBSPOT,
		PLUGIN_CAPABILITIES.EVENT_SOURCE
	] as const;

	readonly providerName = 'hubspot';

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
		required: ['accessToken'],
		properties: {
			accessToken: {
				type: 'string',
				title: 'HubSpot private-app access token (pat-…)',
				'x-secret': true,
				'x-envVar': 'HUBSPOT_ACCESS_TOKEN'
			},
			objectTypes: {
				type: 'string',
				title: 'CRM object types to ingest (comma-separated; contacts, companies, deals when empty)',
				default: 'contacts,companies,deals'
			},
			portalId: {
				type: 'string',
				title: 'HubSpot portal (hub) id — enables deep links back to each record'
			},
			backfillDays: {
				type: 'number',
				title: 'Historical backfill window in days on first pull (0 = off, max 90)',
				default: 0,
				minimum: 0,
				maximum: 90
			},
			defaultObjectType: {
				type: 'string',
				title: 'Default CRM object type for record writes',
				default: 'contacts'
			},
			defaultAssociatedObjectId: {
				type: 'string',
				title: 'Default CRM record id outbound notes are attached to'
			}
		}
	};

	private readonly idempotencyCache = new Map<string, ChannelSendResult>();
	private readonly recordIdempotencyCache = new Map<string, ConnectorRecordResult>();

	async onLoad(): Promise<void> {
		// No-op — no warm-up resources; a Client is created per call.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
		this.recordIdempotencyCache.clear();
	}

	/** Testable seam — specs stub this; production uses the real SDK. */
	protected createClient(accessToken: string): HubSpotClientLike {
		return new Client({ accessToken }) as unknown as HubSpotClientLike;
	}

	async verifyConnection(config: ChannelTargetConfig, options: ConnectorCallOptions): Promise<ChannelVerification> {
		const accessToken = resolveAccessToken(config, options);
		if (!accessToken) {
			return { valid: false, message: 'accessToken is required' };
		}
		// Probe the FIRST configured object type rather than hardcoding
		// contacts: a private app scoped only to deals must still verify.
		const objectTypes = resolveObjectTypes(options.settings as PluginSettings | undefined);
		const probeType = objectTypes[0];
		try {
			const page = await this.createClient(accessToken).crm.objects.basicApi.getPage(probeType, 1);
			return {
				valid: true,
				details: {
					probedObjectType: probeType,
					objectTypes: objectTypes.join(','),
					sampled: (page?.results ?? []).length
				}
			};
		} catch (err) {
			return {
				valid: false,
				message: `HubSpot ${probeType} read failed: ${hubspotErrorMessage(err)}`
			};
		}
	}

	/** Outbound leg — append a Note engagement to a CRM record. */
	async send(payload: ChannelSendInput, options: ConnectorCallOptions): Promise<ChannelSendResult> {
		const config = payload.target ?? options.target ?? {};
		const accessToken = resolveAccessToken(config, options);
		if (!accessToken) {
			throw new Error(
				'hubspot-connector: an access token is required (targetConfig.accessToken or settings.accessToken)'
			);
		}
		const { objectType, objectId } = resolveNoteTarget(config, options);
		const associationTypeId = objectMeta(objectType).noteAssociationTypeId;
		if (associationTypeId === undefined) {
			throw new Error(
				`hubspot-connector: outbound notes are not supported for object type '${objectType}' — ` +
					`use one of ${Object.keys(HUBSPOT_OBJECT_META).join(', ')}`
			);
		}

		// Idempotency: scope the key to connectorId + object + messageRef with a
		// NUL separator so components can't collide across tenants (mirrors the
		// slack-connector hardening — this plugin is a module-level singleton).
		const cacheKey = `${options.connectorId ?? ''}\0${objectType}\0${objectId}\0${payload.messageRef}`;
		const cached = this.idempotencyCache.get(cacheKey);
		if (cached) return cached;

		let noteId: string | undefined;
		try {
			const res = await this.createClient(accessToken).crm.objects.basicApi.create('notes', {
				properties: {
					hs_note_body: payload.text,
					hs_timestamp: new Date().toISOString()
				},
				associations: [
					{
						to: { id: objectId },
						types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId }]
					}
				]
			});
			noteId = typeof res?.id === 'string' ? res.id : undefined;
		} catch (err) {
			throw new Error(`HubSpot note create failed: ${hubspotErrorMessage(err)}`);
		}

		const result: ChannelSendResult = {
			provider: this.id,
			providerMessageId: noteId ?? `hubspot-${payload.messageRef}`,
			deliveredAt: new Date()
		};
		this.rememberSend(cacheKey, result);
		return result;
	}

	/** Outbound record leg — create a CRM record of any object type. */
	async createRecord(record: ConnectorRecordInput, options: ConnectorCallOptions): Promise<ConnectorRecordResult> {
		const config = options.target ?? {};
		const accessToken = resolveAccessToken(config, options);
		if (!accessToken) {
			throw new Error(
				'hubspot-connector: an access token is required (targetConfig.accessToken or settings.accessToken)'
			);
		}
		const objectType =
			firstString([record.collection, config.defaultObjectType, options.settings?.defaultObjectType]) ??
			'contacts';

		const cacheKey = `${options.connectorId ?? ''}\0${objectType}\0${record.idempotencyKey}`;
		const cached = this.recordIdempotencyCache.get(cacheKey);
		if (cached) return cached;

		let recordId: string | undefined;
		try {
			const res = await this.createClient(accessToken).crm.objects.basicApi.create(objectType, {
				properties: record.fields
			});
			recordId = typeof res?.id === 'string' ? res.id : undefined;
		} catch (err) {
			throw new Error(`HubSpot ${objectType} create failed: ${hubspotErrorMessage(err)}`);
		}
		if (!recordId) {
			throw new Error(`HubSpot ${objectType} create returned no record id`);
		}

		const result: ConnectorRecordResult = { provider: this.id, recordId };
		this.recordIdempotencyCache.set(cacheKey, result);
		if (this.recordIdempotencyCache.size > 500) {
			const firstKey = this.recordIdempotencyCache.keys().next().value;
			if (firstKey) this.recordIdempotencyCache.delete(firstKey);
		}
		return result;
	}

	private rememberSend(cacheKey: string, result: ChannelSendResult): void {
		this.idempotencyCache.set(cacheKey, result);
		if (this.idempotencyCache.size > 500) {
			const firstKey = this.idempotencyCache.keys().next().value;
			if (firstKey) this.idempotencyCache.delete(firstKey);
		}
	}

	// ── Event source (pull) ─────────────────────────────────────────────

	/**
	 * Pull one search page of the current object-type phase since the
	 * effective watermark, normalized to envelopes. The returned cursor
	 * resumes the same phase (HubSpot `after` token) or advances to the
	 * next configured object type; no cursor means the sweep is done.
	 *
	 * First pull (epoch/absent watermark, no cursor): the window is
	 * `now - backfillDays` when the opt-in backfill is on, otherwise
	 * `now` — history stays untouched unless the user asked for it.
	 */
	async pullEvents(input: EventSourcePullInput): Promise<EventSourcePullResult> {
		const accessToken = input.settings?.accessToken;
		if (typeof accessToken !== 'string' || accessToken.length === 0) {
			throw new EventSourceNotConfiguredError(
				'hubspot-connector: settings.accessToken is required to pull events'
			);
		}

		const objectTypes = resolveObjectTypes(input.settings);
		const cursor = parsePullCursor(input.cursor);
		let objectType: string;
		let after: string | undefined;
		let since: string;
		let backfill: boolean;
		let pagesUsed: number;

		if (cursor) {
			objectType = cursor.t;
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
			objectType = objectTypes[0];
			after = undefined;
			pagesUsed = 0;
		}

		// A type dropped from settings mid-sweep restarts at the first one.
		let typeIndex = objectTypes.indexOf(objectType);
		if (typeIndex === -1) {
			typeIndex = 0;
			objectType = objectTypes[0];
			after = undefined;
			pagesUsed = 0;
		}

		const meta = objectMeta(objectType);
		const portalId = typeof input.settings?.portalId === 'string' ? input.settings.portalId : undefined;
		const client = this.createClient(accessToken);

		const page = await client.crm.objects.searchApi.doSearch(objectType, {
			filterGroups: [
				{
					filters: [
						{
							propertyName: meta.lastModifiedProperty,
							operator: 'GTE',
							value: String(Date.parse(since))
						}
					]
				}
			],
			// No `sorts`: the SDK types it as `string[]` while the API expects
			// sort objects, and ordering is not load-bearing here — the
			// server-side filter guarantees every matching record is visited
			// across the `after` pages, and the ingest pipeline dedupes on
			// `(source, sourceEventId)`.
			properties: [...meta.properties],
			limit: HUBSPOT_PULL_PAGE_SIZE,
			...(after ? { after } : {})
		});

		const events: IngestedEventEnvelope[] = [];
		for (const record of page.results ?? []) {
			const envelope = this.normalizeRecord(record, objectType, since, portalId);
			if (envelope) events.push(envelope);
		}

		const nextAfter = page.paging?.next?.after;
		pagesUsed += 1;
		const pageBudgetExhausted = backfill && pagesUsed >= HUBSPOT_BACKFILL_MAX_PAGES;

		let next: HubSpotPullCursor | undefined;
		if (nextAfter && !pageBudgetExhausted) {
			next = { t: objectType, n: nextAfter, s: since, ...(backfill ? { f: 1 as const } : {}), b: pagesUsed };
		} else if (typeIndex + 1 < objectTypes.length) {
			// Advance to the next object type (page counter resets per phase).
			next = { t: objectTypes[typeIndex + 1], s: since, ...(backfill ? { f: 1 as const } : {}), b: 0 };
		}

		return next ? { events, nextCursor: JSON.stringify(next) } : { events };
	}

	private normalizeRecord(
		record: HubSpotRecord,
		objectType: string,
		since: string,
		portalId: string | undefined
	): IngestedEventEnvelope | null {
		if (!record.id) return null;
		const meta = objectMeta(objectType);
		const properties = record.properties ?? {};
		const updatedAt = toIso(record.updatedAt ?? properties[meta.lastModifiedProperty] ?? record.createdAt);
		const createdAt = toIso(record.createdAt ?? properties.createdate);
		const changeType = Date.parse(createdAt) >= Date.parse(since) ? 'created' : 'updated';
		const title = recordTitle(objectType, properties);
		const sourceUrl =
			portalId && meta.objectTypeId
				? `https://app.hubspot.com/contacts/${encodeURIComponent(portalId)}/record/${meta.objectTypeId}/${encodeURIComponent(record.id)}`
				: undefined;

		return {
			id: randomUUID(),
			source: this.id,
			sourceEventId: `${objectType}:${record.id}:${updatedAt}`,
			kind: meta.kind,
			occurredAt: updatedAt,
			subject: {
				type: 'crm-record',
				externalId: record.id,
				...(title ? { title } : {})
			},
			...(sourceUrl ? { sourceUrl } : {}),
			payload: {
				objectType,
				recordId: record.id,
				changeType,
				createdAt,
				updatedAt,
				...(record.archived === true ? { archived: true } : {}),
				properties: this.sanitizeProperties(properties, meta)
			}
		};
	}

	/**
	 * Payload properties are limited to the whitelist the sweep asked
	 * for and each string value is capped, so a CRM record with a
	 * huge free-text field can never blow the envelope byte budget.
	 */
	private sanitizeProperties(properties: Record<string, unknown>, meta: HubSpotObjectMeta): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const key of meta.properties) {
			const value = properties[key];
			if (value === undefined || value === null) continue;
			out[key] = typeof value === 'string' ? truncateText(value) : value;
		}
		return out;
	}
}

export const hubspotConnectorPlugin = new HubSpotConnectorPlugin();
