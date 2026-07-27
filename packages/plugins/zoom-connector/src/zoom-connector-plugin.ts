import { randomUUID } from 'node:crypto';
import { MeetingsS2SAuthClient } from '@zoom/rivet/meetings';
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
 * Transcript text cap for ingested envelopes. Envelope payloads are
 * size-capped platform-side (32 KB serialized) — a long meeting's VTT
 * can exceed that, so the plugin truncates to this many characters
 * (the full recording stays reachable via `sourceUrl`).
 */
export const ZOOM_TRANSCRIPT_MAX_CHARS = 24_000;

/** Recordings requested per page. */
export const ZOOM_PULL_PAGE_SIZE = 30;

/**
 * The Zoom recordings list API only accepts a window of at most one
 * month per request — sweeps over longer ranges advance in chunks of
 * this many days.
 */
export const ZOOM_WINDOW_MAX_DAYS = 30;

/**
 * Historical backfill bound: at most this many pages per window chunk
 * during the opt-in first-pull backfill, so a recording-heavy account
 * can never turn activation into an unbounded crawl.
 */
export const ZOOM_BACKFILL_MAX_PAGES = 10;

const DAY_MS = 86_400_000;

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

/**
 * WebVTT → readable text: drops the WEBVTT header, cue indices and
 * `00:00:00.000 --> 00:00:05.000` timing lines, keeps speaker-labelled
 * caption text, and collapses duplicate blank lines.
 */
export function parseVttToText(vtt: string): string {
	const lines = vtt.split(/\r?\n/);
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		if (/^WEBVTT/i.test(trimmed)) continue;
		if (/^\d+$/.test(trimmed)) continue;
		if (/-->/.test(trimmed)) continue;
		out.push(trimmed);
	}
	return out.join('\n');
}

function truncateTranscript(text: string): string {
	return text.length > ZOOM_TRANSCRIPT_MAX_CHARS ? text.slice(0, ZOOM_TRANSCRIPT_MAX_CHARS) : text;
}

/** Date-only string (`yyyy-mm-dd`) the recordings list API expects. */
function toDateOnly(iso: string): string {
	return iso.slice(0, 10);
}

interface ZoomCredentials {
	accountId: string;
	clientId: string;
	clientSecret: string;
}

function resolveCredentials(
	settings: PluginSettings | Readonly<Record<string, unknown>> | undefined
): ZoomCredentials | undefined {
	const accountId = settings?.accountId;
	const clientId = settings?.clientId;
	const clientSecret = settings?.clientSecret;
	if (
		typeof accountId === 'string' &&
		accountId.length > 0 &&
		typeof clientId === 'string' &&
		clientId.length > 0 &&
		typeof clientSecret === 'string' &&
		clientSecret.length > 0
	) {
		return { accountId, clientId, clientSecret };
	}
	return undefined;
}

/**
 * Opaque pull cursor. Sweeps advance through ≤30-day window chunks
 * (`from`/`to`, the Zoom month-range constraint); `n` is the API's
 * `next_page_token` inside the current chunk, `w` the sweep end bound
 * (fixed when the sweep started so a long sweep converges), `f` flags
 * a first-pull backfill sweep and `b` counts pages used in the current
 * chunk (backfill page bound). Malformed input restarts the sweep —
 * safe, the ingest pipeline dedupes on `(source, sourceEventId)`.
 */
interface ZoomPullCursor {
	from: string;
	to: string;
	w: string;
	n?: string;
	f?: 1;
	b?: number;
}

function parsePullCursor(cursor: string | undefined): ZoomPullCursor | undefined {
	if (!cursor) return undefined;
	try {
		const parsed = JSON.parse(cursor) as ZoomPullCursor;
		if (
			parsed &&
			typeof parsed.from === 'string' &&
			typeof parsed.to === 'string' &&
			typeof parsed.w === 'string'
		) {
			return parsed;
		}
	} catch {
		// fall through — treat as no cursor
	}
	return undefined;
}

/** Minimal scalar shape of a recording file node we consume. */
export interface ZoomRecordingFileNode {
	id?: string;
	file_type?: string;
	download_url?: string;
	play_url?: string;
	recording_type?: string;
	status?: string;
}

/** Minimal scalar shape of a recorded-meeting node we consume. */
export interface ZoomRecordingMeetingNode {
	uuid?: string;
	id?: number;
	topic?: string;
	start_time?: string;
	duration?: number;
	host_id?: string;
	recording_files?: ZoomRecordingFileNode[];
}

export interface ZoomRecordingsPage {
	meetings?: ZoomRecordingMeetingNode[];
	next_page_token?: string;
}

/** The subset of the Zoom surface this plugin calls (testable seam). */
export interface ZoomClientLike {
	listAllRecordings(query: {
		from?: string;
		to?: string;
		page_size?: number;
		next_page_token?: string;
	}): Promise<ZoomRecordingsPage>;
	/** Fetch a transcript (VTT) file's raw content. */
	downloadTranscript(url: string): Promise<string>;
}

/** In-memory S2S token cache entry (module-singleton plugin). */
interface CachedToken {
	token: string;
	expiresAt: number;
}

/**
 * Zoom connector (Wave 8, Meetings v1) — first-party native connector.
 *
 * Event source: `pullEvents` sweeps COMPLETED cloud recordings since
 * the watermark via the official `@zoom/rivet` SDK
 * (`MeetingsS2SAuthClient.endpoints.cloudRecording.listAllRecordings`,
 * Server-to-Server OAuth — the SDK pins the API host, so there is no
 * SSRF surface), downloads the transcript (VTT → text, truncated to
 * `ZOOM_TRANSCRIPT_MAX_CHARS`) when one is available, and normalizes
 * each recording into a `zoom.recording` `IngestedEventEnvelope` for
 * the platform's event-ingest spine. The agent-side Meetings processor
 * turns those envelopes into Meeting rows + transcript ingest.
 *
 * Vendor-SDK note: every Zoom API call goes through the official
 * `@zoom/rivet` SDK. The ONE exception is the transcript FILE
 * download — Rivet wraps the REST endpoints but exposes neither
 * recording-file downloads nor its internal access token, so the
 * download leg performs the official Server-to-Server OAuth
 * `account_credentials` token flow (`https://zoom.us/oauth/token`)
 * and fetches the SDK-returned `download_url` with the bearer token.
 * Both URLs are fixed Zoom hosts (no user-controlled origins).
 *
 * Outbound: none in v1 (`send` rejects) — Meetings v1 is
 * transcript-first. LIVE BOT-JOIN (an Ever Works bot joining the
 * meeting to capture audio in real time) is the documented FOLLOW-UP:
 * it requires the Meeting Bot / RTMS surface and a media pipeline,
 * and will layer onto this connector without changing the envelope
 * contract.
 *
 * Sweep protocol: the Zoom recordings list API caps `from`/`to` at one
 * month, so a sweep advances through ≤30-day window chunks up to the
 * sweep end bound. The opt-in historical backfill (`backfillDays`,
 * default 0 = off, max 90) widens the FIRST pull's window only, with a
 * per-chunk page bound so activation never becomes an unbounded crawl.
 * Re-delivery across overlapping windows is fine — the ingest pipeline
 * dedupes on `(source, sourceEventId)`.
 */
export class ZoomConnectorPlugin implements IConnectorPlugin, IEventSourcePlugin {
	readonly id = 'zoom-connector';
	readonly name = 'Zoom Connector';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'connector';
	readonly capabilities = [PLUGIN_CAPABILITIES.CONNECTOR, PLUGIN_CAPABILITIES.EVENT_SOURCE] as const;

	readonly providerName = 'zoom';

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
		required: ['accountId', 'clientId', 'clientSecret'],
		properties: {
			accountId: {
				type: 'string',
				title: 'Zoom account id (Server-to-Server OAuth app)',
				'x-envVar': 'ZOOM_ACCOUNT_ID'
			},
			clientId: {
				type: 'string',
				title: 'Zoom client id (Server-to-Server OAuth app)',
				'x-envVar': 'ZOOM_CLIENT_ID'
			},
			clientSecret: {
				type: 'string',
				title: 'Zoom client secret (Server-to-Server OAuth app)',
				'x-secret': true,
				'x-envVar': 'ZOOM_CLIENT_SECRET'
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

	private readonly tokenCache = new Map<string, CachedToken>();

	async onLoad(): Promise<void> {
		// No-op — no warm-up resources; a client is created per call.
	}

	async onUnload(): Promise<void> {
		this.tokenCache.clear();
	}

	/** Testable seam — specs stub this; production uses `@zoom/rivet`. */
	protected createClient(credentials: ZoomCredentials): ZoomClientLike {
		const client = new MeetingsS2SAuthClient({
			accountId: credentials.accountId,
			clientId: credentials.clientId,
			clientSecret: credentials.clientSecret,
			disableReceiver: true
		});
		return {
			listAllRecordings: async (query) => {
				const res = await client.endpoints.cloudRecording.listAllRecordings({
					path: { userId: 'me' },
					query
				});
				return (res.data ?? {}) as ZoomRecordingsPage;
			},
			downloadTranscript: async (url) => {
				const token = await this.getS2SToken(credentials);
				const res = await fetch(url, {
					headers: { Authorization: `Bearer ${token}` },
					redirect: 'follow'
				});
				if (!res.ok) {
					throw new Error(`Zoom transcript download failed: HTTP ${res.status}`);
				}
				return res.text();
			}
		};
	}

	/**
	 * Official Server-to-Server OAuth `account_credentials` token flow —
	 * used ONLY for the transcript file download (see the vendor-SDK
	 * note on the class doc). Cached in-memory until shortly before
	 * expiry; the plugin is a module singleton so the cache is shared.
	 */
	protected async getS2SToken(credentials: ZoomCredentials): Promise<string> {
		const cacheKey = `${credentials.accountId}\0${credentials.clientId}`;
		const cached = this.tokenCache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.token;
		}
		const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');
		const url = new URL('https://zoom.us/oauth/token');
		url.searchParams.set('grant_type', 'account_credentials');
		url.searchParams.set('account_id', credentials.accountId);
		const res = await fetch(url, {
			method: 'POST',
			headers: { Authorization: `Basic ${basic}` }
		});
		if (!res.ok) {
			throw new Error(`Zoom S2S token request failed: HTTP ${res.status}`);
		}
		const body = (await res.json()) as { access_token?: string; expires_in?: number };
		if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
			throw new Error('Zoom S2S token response missing access_token');
		}
		// Refresh one minute early so an almost-expired token is never used.
		const ttlMs = Math.max(((body.expires_in ?? 3600) - 60) * 1000, 60_000);
		this.tokenCache.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + ttlMs });
		return body.access_token;
	}

	async verifyConnection(config: ChannelTargetConfig, options: ConnectorCallOptions): Promise<ChannelVerification> {
		const credentials = resolveCredentials(config) ?? resolveCredentials(options.settings);
		if (!credentials) {
			return { valid: false, message: 'accountId, clientId and clientSecret are required' };
		}
		try {
			await this.createClient(credentials).listAllRecordings({ page_size: 1 });
			return { valid: true, details: { accountId: credentials.accountId } };
		} catch (err) {
			return {
				valid: false,
				message: `Zoom recordings lookup failed: ${err instanceof Error ? err.message : String(err)}`
			};
		}
	}

	/**
	 * Outbound messaging is not part of Meetings v1 — the connector is
	 * an inbound event source (recordings + transcripts). Kept explicit
	 * so a mis-routed send fails loudly instead of silently no-oping.
	 */
	async send(_payload: ChannelSendInput, _options: ConnectorCallOptions): Promise<ChannelSendResult> {
		throw new Error(
			'zoom-connector: outbound messaging is not supported in v1 (transcript-first event source; live bot-join is a documented follow-up)'
		);
	}

	// ── Event source (pull) ─────────────────────────────────────────────

	/**
	 * Pull one page of the current ≤30-day window chunk since the
	 * effective watermark, normalized to `zoom.recording` envelopes.
	 * The returned cursor resumes the same chunk (API page token) or
	 * advances to the next chunk; no cursor means the sweep is done.
	 *
	 * First pull (epoch/absent watermark, no cursor): the window is
	 * `now - backfillDays` when the opt-in backfill is on, otherwise
	 * `now` — history stays untouched unless the user asked for it.
	 */
	async pullEvents(input: EventSourcePullInput): Promise<EventSourcePullResult> {
		const credentials = resolveCredentials(input.settings);
		if (!credentials) {
			throw new EventSourceNotConfiguredError(
				'zoom-connector: settings.accountId, settings.clientId and settings.clientSecret are required to pull events'
			);
		}

		const now = Date.now();
		const cursor = parsePullCursor(input.cursor);
		let from: string;
		let to: string;
		let sweepEnd: string;
		let pageToken: string | undefined;
		let backfill: boolean;
		let pagesUsed: number;

		if (cursor) {
			from = cursor.from;
			to = cursor.to;
			sweepEnd = cursor.w;
			pageToken = cursor.n;
			backfill = cursor.f === 1;
			pagesUsed = cursor.b ?? 0;
		} else {
			const sinceMs = Date.parse(input.since);
			const firstPull = !Number.isFinite(sinceMs) || sinceMs <= 0;
			const backfillDays = clampBackfillDays(input.settings?.backfillDays);
			let startMs: number;
			if (firstPull) {
				startMs = backfillDays > 0 ? now - backfillDays * DAY_MS : now;
				backfill = backfillDays > 0;
			} else {
				startMs = sinceMs;
				backfill = false;
			}
			sweepEnd = new Date(now).toISOString();
			from = new Date(startMs).toISOString();
			to = new Date(Math.min(startMs + ZOOM_WINDOW_MAX_DAYS * DAY_MS, now)).toISOString();
			pageToken = undefined;
			pagesUsed = 0;
		}

		const client = this.createClient(credentials);
		const page = await client.listAllRecordings({
			from: toDateOnly(from),
			to: toDateOnly(to),
			page_size: ZOOM_PULL_PAGE_SIZE,
			...(pageToken ? { next_page_token: pageToken } : {})
		});

		const events: IngestedEventEnvelope[] = [];
		for (const meeting of page.meetings ?? []) {
			const envelope = await this.normalizeRecording(meeting, client);
			if (envelope) events.push(envelope);
		}

		pagesUsed += 1;
		const pageBudgetExhausted = backfill && pagesUsed >= ZOOM_BACKFILL_MAX_PAGES;
		const nextPageToken =
			typeof page.next_page_token === 'string' && page.next_page_token.length > 0
				? page.next_page_token
				: undefined;

		let next: ZoomPullCursor | undefined;
		if (nextPageToken && !pageBudgetExhausted) {
			next = { from, to, w: sweepEnd, n: nextPageToken, ...(backfill ? { f: 1 as const } : {}), b: pagesUsed };
		} else if (Date.parse(to) < Date.parse(sweepEnd)) {
			// Chunk finished (or its backfill budget spent) — advance to the
			// next ≤30-day window (page counter resets per chunk).
			const nextFrom = to;
			const nextTo = new Date(
				Math.min(Date.parse(to) + ZOOM_WINDOW_MAX_DAYS * DAY_MS, Date.parse(sweepEnd))
			).toISOString();
			next = { from: nextFrom, to: nextTo, w: sweepEnd, ...(backfill ? { f: 1 as const } : {}), b: 0 };
		}

		return next ? { events, nextCursor: JSON.stringify(next) } : { events };
	}

	/**
	 * Bounded HISTORICAL sweep over an explicit `[since, until]` window —
	 * the capability's opt-in `backfill()` method.
	 *
	 * Before this method existed, history was reachable only as a side
	 * effect of the FIRST pull (`settings.backfillDays` widening the
	 * initial window), so a user who activated the connector without the
	 * setting could never go back and fetch it. `backfill()` runs the same
	 * chunked sweep out-of-band, on a caller-chosen window, as many times
	 * as wanted — re-delivery is free because the ingest pipeline dedupes
	 * on `(source, sourceEventId)`.
	 *
	 * The per-chunk page bound (`ZOOM_BACKFILL_MAX_PAGES`) applies here
	 * too: one call fetches ONE page and hands back a cursor, so a
	 * recording-heavy account can never turn a backfill into an
	 * unbounded crawl.
	 */
	async backfill(input: EventSourceBackfillInput): Promise<EventSourceBackfillResult> {
		const sinceMs = Date.parse(input.since);
		if (!Number.isFinite(sinceMs)) {
			throw new EventSourceNotConfiguredError(
				`zoom-connector: backfill requires a valid ISO 8601 "since" (received ${JSON.stringify(input.since)})`
			);
		}
		const untilMs = input.until ? Date.parse(input.until) : Date.now();
		if (!Number.isFinite(untilMs)) {
			throw new EventSourceNotConfiguredError(
				`zoom-connector: backfill "until" must be a valid ISO 8601 timestamp (received ${JSON.stringify(input.until)})`
			);
		}
		// An inverted or empty window is a no-op, not an error — callers
		// derive windows from user input and clock skew is real.
		if (untilMs <= sinceMs) {
			return { events: [], complete: true };
		}

		// Resume the caller's cursor, or open the sweep on the first
		// ≤30-day chunk of the requested window. `f: 1` marks it as a
		// backfill sweep so the per-chunk page bound engages.
		const cursor =
			input.cursor ??
			JSON.stringify({
				from: new Date(sinceMs).toISOString(),
				to: new Date(Math.min(sinceMs + ZOOM_WINDOW_MAX_DAYS * DAY_MS, untilMs)).toISOString(),
				w: new Date(untilMs).toISOString(),
				f: 1 as const,
				b: 0
			} satisfies ZoomPullCursor);

		const page = await this.pullEvents({
			since: input.since,
			cursor,
			...(input.settings ? { settings: input.settings } : {})
		});

		return page.nextCursor
			? { events: page.events, nextCursor: page.nextCursor }
			: { events: page.events, complete: true };
	}

	/**
	 * Normalize one completed cloud recording → envelope. The transcript
	 * (VTT) is downloaded best-effort when a completed TRANSCRIPT file
	 * exists — a download failure degrades to a transcript-less
	 * envelope; the transcript re-lands later because its availability
	 * is part of the dedupe identity (`:transcript` vs `:recording`).
	 */
	private async normalizeRecording(
		meeting: ZoomRecordingMeetingNode,
		client: ZoomClientLike
	): Promise<IngestedEventEnvelope | null> {
		const externalId = meeting.uuid ?? (meeting.id != null ? String(meeting.id) : undefined);
		if (!externalId) return null;

		const files = meeting.recording_files ?? [];
		const transcriptFile = files.find(
			(f) => f.file_type === 'TRANSCRIPT' && typeof f.download_url === 'string' && f.status !== 'processing'
		);
		const playUrl = files.find((f) => typeof f.play_url === 'string' && f.play_url.length > 0)?.play_url;

		let transcriptText: string | undefined;
		if (transcriptFile?.download_url) {
			try {
				const vtt = await client.downloadTranscript(transcriptFile.download_url);
				const text = parseVttToText(vtt);
				if (text.length > 0) transcriptText = truncateTranscript(text);
			} catch {
				transcriptText = undefined;
			}
		}

		const occurredAt = meeting.start_time ?? new Date(0).toISOString();
		return {
			id: randomUUID(),
			source: this.id,
			// Transcript availability is PART of the identity: a recording
			// often completes before its transcript does, and a second
			// delivery with `:transcript` must not be dropped as a duplicate
			// of the transcript-less first one.
			sourceEventId: `${externalId}:${transcriptText ? 'transcript' : 'recording'}`,
			kind: 'zoom.recording',
			occurredAt,
			subject: {
				type: 'meeting',
				externalId,
				...(meeting.topic ? { title: meeting.topic } : {})
			},
			// Work routing: the meeting is the container. A Work that
			// claims this meeting id gets the recording on its feed;
			// otherwise the event stays user-scoped.
			workHint: {
				kind: 'meeting',
				externalId,
				...(meeting.topic ? { label: meeting.topic } : {})
			},
			...(playUrl ? { sourceUrl: playUrl } : {}),
			payload: {
				meetingExternalId: externalId,
				...(meeting.id != null ? { meetingNumber: meeting.id } : {}),
				...(meeting.topic ? { topic: meeting.topic } : {}),
				...(meeting.start_time ? { startTime: meeting.start_time } : {}),
				...(meeting.duration != null ? { durationMinutes: meeting.duration } : {}),
				...(meeting.host_id ? { hostId: meeting.host_id } : {}),
				...(transcriptText ? { transcriptText } : {}),
				recordingCount: files.length
			}
		};
	}
}

export const zoomConnectorPlugin = new ZoomConnectorPlugin();
