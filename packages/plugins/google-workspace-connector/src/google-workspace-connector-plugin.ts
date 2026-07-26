import { randomUUID } from 'node:crypto';
import { auth as googleAuth, drive as driveApi } from '@googleapis/drive';
import { calendar as calendarApi } from '@googleapis/calendar';
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
	PluginSettings,
	JsonSchema
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES, EventSourceNotConfiguredError } from '@ever-works/plugin';
import type { IngestedEventEnvelope } from '@ever-works/contracts';

/**
 * Payload text cap for non-transcript envelope text (file names, event
 * titles, descriptions). Envelope payloads are size-capped platform-side
 * (32 KB serialized).
 */
export const GOOGLE_EVENT_TEXT_MAX_CHARS = 4000;

/**
 * Transcript text cap. A long Meet transcript can exceed the platform's
 * 32 KB envelope cap on its own, so the exported text is truncated here
 * (the full document stays reachable via `sourceUrl`).
 */
export const GOOGLE_TRANSCRIPT_MAX_CHARS = 24_000;

/** Items requested per Drive / Calendar page. */
export const GOOGLE_PULL_PAGE_SIZE = 50;

/**
 * Historical backfill bound: at most this many pages per phase during
 * the opt-in first-pull backfill, so a large Drive can never turn
 * activation into an unbounded crawl.
 */
export const GOOGLE_BACKFILL_MAX_PAGES = 10;

/** Google Docs mime type — the shape a Meet transcript arrives as. */
export const GOOGLE_DOC_MIME_TYPE = 'application/vnd.google-apps.document';

/** The surfaces this connector can sweep, in sweep order. */
export const GOOGLE_SURFACES = ['drive', 'calendar'] as const;
export type GoogleSurface = (typeof GOOGLE_SURFACES)[number];

/** Clamp the opt-in backfill window to the supported 0–90 day range. */
export function clampBackfillDays(value: unknown): number {
	const num = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(num) || num <= 0) return 0;
	return Math.min(Math.floor(num), 90);
}

function truncateText(text: string): string {
	return text.length > GOOGLE_EVENT_TEXT_MAX_CHARS ? text.slice(0, GOOGLE_EVENT_TEXT_MAX_CHARS) : text;
}

function truncateTranscript(text: string): string {
	return text.length > GOOGLE_TRANSCRIPT_MAX_CHARS ? text.slice(0, GOOGLE_TRANSCRIPT_MAX_CHARS) : text;
}

/** Date | ISO string | undefined → ISO 8601 (epoch on garbage). */
function toIso(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'string') {
		const ms = Date.parse(value);
		if (Number.isFinite(ms)) return new Date(ms).toISOString();
	}
	return new Date(0).toISOString();
}

/**
 * Which surfaces to sweep. Unknown entries are dropped; an empty or
 * absent setting means "both", matching the manifest default.
 */
export function resolveSurfaces(settings: PluginSettings | undefined): GoogleSurface[] {
	const raw = settings?.surfaces;
	if (typeof raw !== 'string' || raw.trim().length === 0) return [...GOOGLE_SURFACES];
	const requested = raw
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter((s): s is GoogleSurface => (GOOGLE_SURFACES as readonly string[]).includes(s));
	return requested.length > 0 ? [...GOOGLE_SURFACES].filter((s) => requested.includes(s)) : [...GOOGLE_SURFACES];
}

/**
 * Drive folder-id filter. Ids are interpolated into the Drive `q` query
 * language, so each entry is whitelisted against Drive's own file-id
 * alphabet rather than escaped — anything else is dropped. Comma-only
 * split so a tampered entry fails as a whole.
 */
export function resolveDriveFolderIds(settings: PluginSettings | undefined): string[] {
	const raw = settings?.driveFolderIds;
	if (typeof raw !== 'string' || raw.trim().length === 0) return [];
	return raw
		.split(',')
		.map((id) => id.trim())
		.filter((id) => /^[A-Za-z0-9_-]{4,256}$/.test(id));
}

/** Calendar ids to sweep. Defaults to the account's `primary` calendar. */
export function resolveCalendarIds(settings: PluginSettings | undefined): string[] {
	const raw = settings?.calendarIds;
	if (typeof raw !== 'string' || raw.trim().length === 0) return ['primary'];
	const ids = raw
		.split(',')
		.map((id) => id.trim())
		.filter((id) => id === 'primary' || /^[A-Za-z0-9._%+@#-]{1,320}$/.test(id));
	return ids.length > 0 ? ids : ['primary'];
}

/**
 * Google Meet drops a per-meeting transcript into the account's "Meet
 * Recordings" Drive folder as a Google Doc whose name ends in
 * `… - Transcript` (`(Transcript)` in some locales). This is the
 * heuristic that separates those from ordinary document edits.
 */
export function isMeetTranscriptFile(file: { name?: string | null; mimeType?: string | null }): boolean {
	if (file.mimeType !== GOOGLE_DOC_MIME_TYPE) return false;
	const name = file.name ?? '';
	return /\s-\s*transcript\s*$/i.test(name) || /\(transcript\)\s*$/i.test(name);
}

/** Build the Drive `q` filter for one sweep page. */
export function buildDriveQuery(since: string, folderIds: string[]): string {
	const clauses = [`modifiedTime > '${toIso(since)}'`, 'trashed = false'];
	if (folderIds.length > 0) {
		clauses.push(`(${folderIds.map((id) => `'${id}' in parents`).join(' or ')})`);
	}
	return clauses.join(' and ');
}

/** Extract a readable message from a Google API error. */
function googleErrorMessage(err: unknown): string {
	const e = err as { message?: string; errors?: Array<{ message?: string }> };
	return e.errors?.[0]?.message ?? e.message ?? 'unknown error';
}

/**
 * Opaque pull cursor. `p` is the sweep phase, `i` the index into the
 * configured calendar list (calendar phase only), `n` the API page
 * token, `s` the effective since-watermark the sweep was started with
 * (kept here so later pages of the same sweep use the SAME window), `f`
 * flags a first-pull backfill sweep and `b` counts pages used in the
 * current phase (backfill page bound). Malformed input restarts the
 * sweep — safe, the ingest pipeline dedupes on
 * `(source, sourceEventId)`.
 */
interface GooglePullCursor {
	p: GoogleSurface;
	i?: number;
	n?: string;
	s: string;
	f?: 1;
	b?: number;
}

function parsePullCursor(cursor: string | undefined): GooglePullCursor | undefined {
	if (!cursor) return undefined;
	try {
		const parsed = JSON.parse(cursor) as GooglePullCursor;
		if (parsed && (GOOGLE_SURFACES as readonly string[]).includes(parsed.p) && typeof parsed.s === 'string') {
			return parsed;
		}
	} catch {
		// fall through — treat as no cursor
	}
	return undefined;
}

/** Minimal scalar shape of a Drive file node we consume. */
export interface DriveFileNode {
	id?: string | null;
	name?: string | null;
	mimeType?: string | null;
	createdTime?: string | null;
	modifiedTime?: string | null;
	webViewLink?: string | null;
	parents?: string[] | null;
	lastModifyingUser?: { displayName?: string | null; permissionId?: string | null } | null;
}

export interface DriveFilesPage {
	files?: DriveFileNode[];
	nextPageToken?: string | null;
}

/** Minimal scalar shape of a Calendar event node we consume. */
export interface CalendarEventNode {
	id?: string | null;
	status?: string | null;
	summary?: string | null;
	description?: string | null;
	htmlLink?: string | null;
	created?: string | null;
	updated?: string | null;
	hangoutLink?: string | null;
	start?: { dateTime?: string | null; date?: string | null } | null;
	end?: { dateTime?: string | null; date?: string | null } | null;
	organizer?: { displayName?: string | null; email?: string | null } | null;
	attendees?: Array<{ email?: string | null; displayName?: string | null }> | null;
	conferenceData?: { conferenceId?: string | null } | null;
}

export interface CalendarEventsPage {
	items?: CalendarEventNode[];
	nextPageToken?: string | null;
}

/** The subset of the Google API surface this plugin calls (testable seam). */
export interface GoogleWorkspaceClientLike {
	listDriveFiles(params: { q: string; pageSize: number; pageToken?: string }): Promise<DriveFilesPage>;
	/** Export a Google Doc as plain text (used for Meet transcripts). */
	exportDoc(fileId: string): Promise<string>;
	listCalendarEvents(params: {
		calendarId: string;
		updatedMin: string;
		maxResults: number;
		pageToken?: string;
	}): Promise<CalendarEventsPage>;
}

interface GoogleCredentials {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}

function resolveCredentials(
	settings: PluginSettings | Readonly<Record<string, unknown>> | undefined
): GoogleCredentials | undefined {
	const clientId = settings?.clientId;
	const clientSecret = settings?.clientSecret;
	const refreshToken = settings?.refreshToken;
	if (
		typeof clientId === 'string' &&
		clientId.length > 0 &&
		typeof clientSecret === 'string' &&
		clientSecret.length > 0 &&
		typeof refreshToken === 'string' &&
		refreshToken.length > 0
	) {
		return { clientId, clientSecret, refreshToken };
	}
	return undefined;
}

/**
 * Google Workspace connector (Wave 8) — first-party native connector.
 *
 * SCOPE (v1), deliberately narrow: the two highest-value, lowest-risk
 * read surfaces.
 *
 *   - **Drive file changes** → `google.drive-change` envelopes (files
 *     modified since the watermark, optionally narrowed to configured
 *     folders). `workHint` kind `doc-database` on the file's parent
 *     folder — the folder is the container an Ever Works Work maps onto.
 *   - **Calendar events** → `google.calendar-event` envelopes (events
 *     updated since the watermark, per configured calendar).
 *     `workHint` kind `meeting` on the Meet conference id when the
 *     event has one, else the event id.
 *   - **Google Meet transcripts** → `google.meet-recording` envelopes.
 *     Meet drops a transcript Google Doc into the account's "Meet
 *     Recordings" Drive folder; those files are exported as plain text
 *     and emitted with `transcriptText`, which the platform's Meetings
 *     kind processor turns into a Meeting row + `ingestTranscript` run.
 *     Meet therefore needs NO separate connector — it rides this one.
 *
 * Gmail, Docs content, Sheets and Admin/Reports are explicitly OUT of
 * v1: each needs a materially wider consent scope for materially less
 * signal, and Gmail in particular would put whole mailboxes through the
 * ingest spine.
 *
 * AUTH: OAuth **refresh token** (client id + secret + refresh token,
 * scopes `drive.readonly` + `calendar.readonly`), NOT a service
 * account. A service account can only reach a user's My Drive through
 * Workspace domain-wide delegation, which excludes individual Google
 * accounts and requires super-admin configuration; a refresh token is
 * the same "paste one secret" operation and works for both. Service
 * accounts with domain-wide delegation are a documented follow-up for
 * org-wide sweeps.
 *
 * Vendor-SDK note: every call goes through Google's official Node
 * clients (`@googleapis/drive`, `@googleapis/calendar` — the per-API
 * packages published from `googleapis/google-api-nodejs-client`, chosen
 * over the monolithic `googleapis` aggregate for install size). The SDK
 * pins the API hosts, so there is no SSRF surface.
 *
 * Outbound: none in v1 (`send` rejects) — this is a read-only event
 * source.
 *
 * Sweep protocol: phases run drive → calendar (per configured
 * calendar), each resumable on the API's own page token. The opt-in
 * historical backfill (`backfillDays`, default 0 = off, max 90) widens
 * the FIRST pull's window only, with a per-phase page bound so
 * activation never becomes an unbounded crawl. Re-delivery across
 * overlapping windows is fine — the ingest pipeline dedupes on
 * `(source, sourceEventId)`.
 */
export class GoogleWorkspaceConnectorPlugin implements IConnectorPlugin, IEventSourcePlugin {
	readonly id = 'google-workspace-connector';
	readonly name = 'Google Workspace Connector';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'connector';
	readonly capabilities = [PLUGIN_CAPABILITIES.CONNECTOR, PLUGIN_CAPABILITIES.EVENT_SOURCE] as const;

	readonly providerName = 'google-workspace';

	readonly connector: ConnectorMetadata = {
		direction: 'inbound',
		transport: 'poll',
		flags: {
			outboundMessage: false,
			outboundRecord: false,
			inbound: true,
			reply: false,
			pairing: false,
			richOutbound: false
		}
	};

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		required: ['clientId', 'clientSecret', 'refreshToken'],
		properties: {
			clientId: {
				type: 'string',
				title: 'Google OAuth client id',
				'x-envVar': 'GOOGLE_WORKSPACE_CLIENT_ID'
			},
			clientSecret: {
				type: 'string',
				title: 'Google OAuth client secret',
				'x-secret': true,
				'x-envVar': 'GOOGLE_WORKSPACE_CLIENT_SECRET'
			},
			refreshToken: {
				type: 'string',
				title: 'Google OAuth refresh token (drive.readonly + calendar.readonly scopes)',
				'x-secret': true,
				'x-envVar': 'GOOGLE_WORKSPACE_REFRESH_TOKEN'
			},
			surfaces: {
				type: 'string',
				title: 'Surfaces to ingest: drive, calendar, or drive,calendar (default both)',
				default: 'drive,calendar'
			},
			driveFolderIds: {
				type: 'string',
				title: 'Drive folder ids to ingest changes from (comma-separated; whole Drive when empty)'
			},
			calendarIds: {
				type: 'string',
				title: 'Calendar ids to ingest events from (comma-separated; defaults to primary)',
				default: 'primary'
			},
			meetTranscripts: {
				type: 'boolean',
				title: 'Export Google Meet transcript documents into meeting envelopes',
				default: true
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

	async onLoad(): Promise<void> {
		// No-op — no warm-up resources; a client is created per call.
	}

	async onUnload(): Promise<void> {
		// No-op — nothing cached across calls.
	}

	/** Testable seam — specs stub this; production uses the real SDKs. */
	protected createClient(credentials: GoogleCredentials): GoogleWorkspaceClientLike {
		const oauth2 = new googleAuth.OAuth2({
			clientId: credentials.clientId,
			clientSecret: credentials.clientSecret
		});
		oauth2.setCredentials({ refresh_token: credentials.refreshToken });
		const drive = driveApi({ version: 'v3', auth: oauth2 });
		const calendar = calendarApi({ version: 'v3', auth: oauth2 });
		return {
			listDriveFiles: async (params) => {
				const res = await drive.files.list({
					q: params.q,
					pageSize: params.pageSize,
					orderBy: 'modifiedTime',
					fields: 'nextPageToken, files(id,name,mimeType,createdTime,modifiedTime,webViewLink,parents,lastModifyingUser(displayName,permissionId))',
					...(params.pageToken ? { pageToken: params.pageToken } : {})
				});
				return (res.data ?? {}) as DriveFilesPage;
			},
			exportDoc: async (fileId) => {
				const res = await drive.files.export({ fileId, mimeType: 'text/plain' });
				return typeof res.data === 'string' ? res.data : String(res.data ?? '');
			},
			listCalendarEvents: async (params) => {
				const res = await calendar.events.list({
					calendarId: params.calendarId,
					updatedMin: params.updatedMin,
					maxResults: params.maxResults,
					singleEvents: true,
					showDeleted: false,
					...(params.pageToken ? { pageToken: params.pageToken } : {})
				});
				return (res.data ?? {}) as CalendarEventsPage;
			}
		};
	}

	async verifyConnection(config: ChannelTargetConfig, options: ConnectorCallOptions): Promise<ChannelVerification> {
		const credentials = resolveCredentials(config) ?? resolveCredentials(options.settings);
		if (!credentials) {
			return { valid: false, message: 'clientId, clientSecret and refreshToken are required' };
		}
		try {
			await this.createClient(credentials).listDriveFiles({
				q: 'trashed = false',
				pageSize: 1
			});
			return { valid: true, details: { clientId: credentials.clientId } };
		} catch (err) {
			return { valid: false, message: `Google Drive lookup failed: ${googleErrorMessage(err)}` };
		}
	}

	/**
	 * Outbound messaging is not part of v1 — the connector is a
	 * read-only event source. Kept explicit so a mis-routed send fails
	 * loudly instead of silently no-oping.
	 */
	async send(_payload: ChannelSendInput, _options: ConnectorCallOptions): Promise<ChannelSendResult> {
		throw new Error(
			'google-workspace-connector: outbound messaging is not supported in v1 (read-only Drive/Calendar event source)'
		);
	}

	// ── Event source (pull) ─────────────────────────────────────────────

	/**
	 * Pull one page of the current sweep phase since the effective
	 * watermark, normalized to envelopes. The returned cursor resumes
	 * the same phase (API page token) or advances to the next; no cursor
	 * means the sweep is done.
	 *
	 * First pull (epoch/absent watermark, no cursor): the window is
	 * `now - backfillDays` when the opt-in backfill is on, otherwise
	 * `now` — history stays untouched unless the user asked for it.
	 */
	async pullEvents(input: EventSourcePullInput): Promise<EventSourcePullResult> {
		const credentials = resolveCredentials(input.settings);
		if (!credentials) {
			throw new EventSourceNotConfiguredError(
				'google-workspace-connector: settings.clientId, settings.clientSecret and settings.refreshToken are required to pull events'
			);
		}

		const surfaces = resolveSurfaces(input.settings);
		const calendarIds = resolveCalendarIds(input.settings);
		const cursor = parsePullCursor(input.cursor);

		let phase: GoogleSurface;
		let calendarIndex: number;
		let pageToken: string | undefined;
		let since: string;
		let backfill: boolean;
		let pagesUsed: number;

		if (cursor) {
			phase = cursor.p;
			calendarIndex = cursor.i ?? 0;
			pageToken = cursor.n;
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
			phase = surfaces[0] ?? 'drive';
			calendarIndex = 0;
			pageToken = undefined;
			pagesUsed = 0;
		}

		// A phase the settings turned off is skipped without an API call.
		if (!surfaces.includes(phase)) {
			const next = this.advancePhase({ phase, calendarIndex, since, backfill, surfaces, calendarIds });
			return next ? { events: [], nextCursor: JSON.stringify(next) } : { events: [] };
		}

		const client = this.createClient(credentials);
		const events: IngestedEventEnvelope[] = [];
		let nextPageToken: string | undefined;

		if (phase === 'drive') {
			const page = await client.listDriveFiles({
				q: buildDriveQuery(since, resolveDriveFolderIds(input.settings)),
				pageSize: GOOGLE_PULL_PAGE_SIZE,
				...(pageToken ? { pageToken } : {})
			});
			const wantTranscripts = input.settings?.meetTranscripts !== false;
			for (const file of page.files ?? []) {
				const envelope = await this.normalizeDriveFile(file, client, wantTranscripts);
				if (envelope) events.push(envelope);
			}
			nextPageToken = page.nextPageToken ?? undefined;
		} else {
			const calendarId = calendarIds[calendarIndex] ?? 'primary';
			const page = await client.listCalendarEvents({
				calendarId,
				updatedMin: toIso(since),
				maxResults: GOOGLE_PULL_PAGE_SIZE,
				...(pageToken ? { pageToken } : {})
			});
			for (const event of page.items ?? []) {
				const envelope = this.normalizeCalendarEvent(event, calendarId);
				if (envelope) events.push(envelope);
			}
			nextPageToken = page.nextPageToken ?? undefined;
		}

		pagesUsed += 1;
		const pageBudgetExhausted = backfill && pagesUsed >= GOOGLE_BACKFILL_MAX_PAGES;

		let next: GooglePullCursor | undefined;
		if (nextPageToken && !pageBudgetExhausted) {
			next = {
				p: phase,
				...(phase === 'calendar' ? { i: calendarIndex } : {}),
				n: nextPageToken,
				s: since,
				...(backfill ? { f: 1 as const } : {}),
				b: pagesUsed
			};
		} else {
			next = this.advancePhase({ phase, calendarIndex, since, backfill, surfaces, calendarIds });
		}

		return next ? { events, nextCursor: JSON.stringify(next) } : { events };
	}

	/**
	 * Move the sweep on: drive → the first calendar → the next calendar
	 * → done. Page counters reset per phase.
	 */
	private advancePhase(input: {
		phase: GoogleSurface;
		calendarIndex: number;
		since: string;
		backfill: boolean;
		surfaces: GoogleSurface[];
		calendarIds: string[];
	}): GooglePullCursor | undefined {
		const { phase, calendarIndex, since, backfill, surfaces, calendarIds } = input;
		const flags = { s: since, ...(backfill ? { f: 1 as const } : {}), b: 0 };
		if (phase === 'drive') {
			return surfaces.includes('calendar') && calendarIds.length > 0
				? { p: 'calendar', i: 0, ...flags }
				: undefined;
		}
		const nextIndex = calendarIndex + 1;
		return nextIndex < calendarIds.length ? { p: 'calendar', i: nextIndex, ...flags } : undefined;
	}

	/**
	 * Normalize one Drive file → envelope. Meet transcript documents
	 * become `google.meet-recording` envelopes carrying the exported
	 * plain text (best-effort: an export failure degrades to an ordinary
	 * `google.drive-change` envelope, and the transcript re-lands later
	 * because transcript availability is part of the dedupe identity).
	 */
	private async normalizeDriveFile(
		file: DriveFileNode,
		client: GoogleWorkspaceClientLike,
		wantTranscripts: boolean
	): Promise<IngestedEventEnvelope | null> {
		if (!file.id) return null;
		const modifiedAt = toIso(file.modifiedTime ?? file.createdTime);
		const createdAt = toIso(file.createdTime);
		const parentId = file.parents?.[0];
		const actorName = file.lastModifyingUser?.displayName ?? undefined;

		let transcriptText: string | undefined;
		if (wantTranscripts && isMeetTranscriptFile(file)) {
			try {
				const text = await client.exportDoc(file.id);
				if (text.trim().length > 0) transcriptText = truncateTranscript(text);
			} catch {
				transcriptText = undefined;
			}
		}

		if (transcriptText) {
			return {
				id: randomUUID(),
				source: this.id,
				// Transcript availability is PART of the identity, mirroring the
				// zoom connector: a doc can appear before its text is exportable.
				sourceEventId: `${file.id}:${modifiedAt}:transcript`,
				kind: 'google.meet-recording',
				occurredAt: modifiedAt,
				...(actorName ? { actor: { name: actorName } } : {}),
				subject: {
					type: 'meeting',
					externalId: file.id,
					...(file.name ? { title: file.name } : {})
				},
				// Work routing: the meeting is the container. A Work that
				// claims this meeting id gets the transcript on its feed.
				workHint: {
					kind: 'meeting' as const,
					externalId: file.id,
					...(file.name ? { label: file.name } : {})
				},
				...(file.webViewLink ? { sourceUrl: file.webViewLink } : {}),
				payload: {
					meetingExternalId: file.id,
					provider: 'google-meet',
					...(file.name ? { topic: truncateText(file.name) } : {}),
					startTime: createdAt,
					transcriptText,
					driveFileId: file.id,
					modifiedAt
				}
			};
		}

		return {
			id: randomUUID(),
			source: this.id,
			sourceEventId: `${file.id}:${modifiedAt}`,
			kind: 'google.drive-change',
			occurredAt: modifiedAt,
			...(actorName ? { actor: { name: actorName } } : {}),
			subject: {
				type: 'file',
				externalId: file.id,
				...(file.name ? { title: file.name } : {})
			},
			// Work routing: the parent folder is the doc "database" an
			// Ever Works Work maps onto. Files at the Drive root carry no
			// hint and stay user-scoped.
			...(parentId ? { workHint: { kind: 'doc-database' as const, externalId: parentId } } : {}),
			...(file.webViewLink ? { sourceUrl: file.webViewLink } : {}),
			payload: {
				fileId: file.id,
				...(file.name ? { name: truncateText(file.name) } : {}),
				...(file.mimeType ? { mimeType: file.mimeType } : {}),
				...(parentId ? { parentFolderId: parentId } : {}),
				changeType: Date.parse(createdAt) >= Date.parse(modifiedAt) ? 'created' : 'modified',
				createdAt,
				modifiedAt
			}
		};
	}

	/** Normalize one Calendar event → `google.calendar-event` envelope. */
	private normalizeCalendarEvent(event: CalendarEventNode, calendarId: string): IngestedEventEnvelope | null {
		if (!event.id) return null;
		const updatedAt = toIso(event.updated ?? event.created);
		const startsAt = event.start?.dateTime ?? event.start?.date ?? undefined;
		const conferenceId = event.conferenceData?.conferenceId ?? undefined;
		const organizer = event.organizer?.displayName ?? event.organizer?.email ?? undefined;
		const attendeeCount = event.attendees?.length ?? 0;
		return {
			id: randomUUID(),
			source: this.id,
			sourceEventId: `${calendarId}:${event.id}:${updatedAt}`,
			kind: 'google.calendar-event',
			occurredAt: updatedAt,
			...(organizer ? { actor: { name: organizer } } : {}),
			subject: {
				type: 'calendar-event',
				externalId: event.id,
				...(event.summary ? { title: event.summary } : {})
			},
			// Work routing: the recurring meeting / conference is the
			// container. The Meet conference id is preferred because that is
			// what a Meet transcript resolves to; the event id is the
			// fallback for conference-less entries.
			workHint: {
				kind: 'meeting' as const,
				externalId: conferenceId ?? event.id,
				...(event.summary ? { label: event.summary } : {})
			},
			...(event.htmlLink ? { sourceUrl: event.htmlLink } : {}),
			payload: {
				eventId: event.id,
				calendarId,
				...(event.summary ? { summary: truncateText(event.summary) } : {}),
				...(event.description ? { description: truncateText(event.description) } : {}),
				...(startsAt ? { startTime: startsAt } : {}),
				...(event.end?.dateTime || event.end?.date ? { endTime: event.end.dateTime ?? event.end.date } : {}),
				...(conferenceId ? { conferenceId } : {}),
				...(event.hangoutLink ? { meetLink: event.hangoutLink } : {}),
				...(event.status ? { status: event.status } : {}),
				attendeeCount,
				createdAt: toIso(event.created),
				updatedAt
			}
		};
	}
}

export const googleWorkspaceConnectorPlugin = new GoogleWorkspaceConnectorPlugin();
