import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	GoogleWorkspaceConnectorPlugin,
	buildDriveQuery,
	clampBackfillDays,
	isMeetTranscriptFile,
	resolveCalendarIds,
	resolveDriveFolderIds,
	resolveSurfaces,
	GOOGLE_BACKFILL_MAX_PAGES,
	GOOGLE_DOC_MIME_TYPE,
	GOOGLE_EVENT_TEXT_MAX_CHARS,
	GOOGLE_TRANSCRIPT_MAX_CHARS
} from './google-workspace-connector-plugin.js';

const listDriveFilesMock = vi.fn();
const exportDocMock = vi.fn();
const listCalendarEventsMock = vi.fn();
const clientFactoryMock = vi.fn();

/** Subclass overriding the client seam so no real SDK call ever happens. */
class TestGoogleWorkspaceConnectorPlugin extends GoogleWorkspaceConnectorPlugin {
	protected override createClient(credentials: { clientId: string; clientSecret: string; refreshToken: string }) {
		clientFactoryMock(credentials);
		return {
			listDriveFiles: listDriveFilesMock,
			exportDoc: exportDocMock,
			listCalendarEvents: listCalendarEventsMock
		};
	}
}

const SETTINGS = {
	clientId: 'client-abc.apps.googleusercontent.com',
	clientSecret: 'google_client_secret_123',
	refreshToken: 'google_refresh_token_secret_456'
};

/** Drive-only settings keep the sweep to a single phase in most specs. */
const DRIVE_ONLY = { ...SETTINGS, surfaces: 'drive' };
const CALENDAR_ONLY = { ...SETTINGS, surfaces: 'calendar' };

describe('GoogleWorkspaceConnectorPlugin', () => {
	let plugin: TestGoogleWorkspaceConnectorPlugin;

	beforeEach(() => {
		plugin = new TestGoogleWorkspaceConnectorPlugin();
		listDriveFilesMock.mockReset();
		exportDocMock.mockReset();
		listCalendarEventsMock.mockReset();
		clientFactoryMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('declares the connector + event-source capabilities and inbound poll metadata', () => {
		expect(plugin.id).toBe('google-workspace-connector');
		expect(plugin.category).toBe('connector');
		expect(plugin.capabilities).toContain('connector');
		expect(plugin.capabilities).toContain('event-source');
		expect(plugin.providerName).toBe('google-workspace');
		expect(plugin.connector.direction).toBe('inbound');
		expect(plugin.connector.transport).toBe('poll');
		expect(plugin.connector.flags.inbound).toBe(true);
		expect(plugin.connector.flags.outboundMessage).toBe(false);
	});

	it('marks the OAuth secrets as x-secret and bounds backfillDays to 0–90', () => {
		const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
		expect(props.clientSecret['x-secret']).toBe(true);
		expect(props.refreshToken['x-secret']).toBe(true);
		// The client id is not a secret — it ships in every OAuth redirect.
		expect(props.clientId['x-secret']).toBeUndefined();
		expect(plugin.settingsSchema.required).toEqual(
			expect.arrayContaining(['clientId', 'clientSecret', 'refreshToken'])
		);
		expect(props.backfillDays.default).toBe(0);
		expect(props.backfillDays.minimum).toBe(0);
		expect(props.backfillDays.maximum).toBe(90);
	});

	it('clampBackfillDays clamps to the 0–90 range and treats garbage as off', () => {
		expect(clampBackfillDays(0)).toBe(0);
		expect(clampBackfillDays(-5)).toBe(0);
		expect(clampBackfillDays(30)).toBe(30);
		expect(clampBackfillDays(90.9)).toBe(90);
		expect(clampBackfillDays(500)).toBe(90);
		expect(clampBackfillDays('nope')).toBe(0);
	});

	describe('settings parsing', () => {
		it('resolveSurfaces defaults to both and drops unknown entries', () => {
			expect(resolveSurfaces({})).toEqual(['drive', 'calendar']);
			expect(resolveSurfaces({ surfaces: 'calendar' })).toEqual(['calendar']);
			expect(resolveSurfaces({ surfaces: 'calendar,drive' })).toEqual(['drive', 'calendar']);
			expect(resolveSurfaces({ surfaces: 'gmail' })).toEqual(['drive', 'calendar']);
		});

		it('resolveDriveFolderIds whitelists Drive file ids instead of escaping them', () => {
			expect(resolveDriveFolderIds({ driveFolderIds: 'abc123DEF_-x, second_folder_id' })).toEqual([
				'abc123DEF_-x',
				'second_folder_id'
			]);
			// A tampered entry fails as a whole — nothing reaches the `q` query.
			expect(resolveDriveFolderIds({ driveFolderIds: "abc' or '1'='1" })).toEqual([]);
			expect(resolveDriveFolderIds({})).toEqual([]);
		});

		it('resolveCalendarIds defaults to primary', () => {
			expect(resolveCalendarIds({})).toEqual(['primary']);
			expect(resolveCalendarIds({ calendarIds: 'primary, team@acme.dev' })).toEqual(['primary', 'team@acme.dev']);
		});

		it('buildDriveQuery is trash-free, window-bounded and folder-scoped', () => {
			expect(buildDriveQuery('2026-07-20T00:00:00.000Z', [])).toBe(
				"modifiedTime > '2026-07-20T00:00:00.000Z' and trashed = false"
			);
			expect(buildDriveQuery('2026-07-20T00:00:00.000Z', ['fold1'])).toContain("('fold1' in parents)");
		});
	});

	describe('isMeetTranscriptFile', () => {
		it('matches Meet transcript Google Docs only', () => {
			expect(
				isMeetTranscriptFile({ name: 'Weekly sync - 2026/07/22 - Transcript', mimeType: GOOGLE_DOC_MIME_TYPE })
			).toBe(true);
			expect(isMeetTranscriptFile({ name: 'Weekly sync (Transcript)', mimeType: GOOGLE_DOC_MIME_TYPE })).toBe(
				true
			);
			expect(isMeetTranscriptFile({ name: 'Transcript notes draft', mimeType: GOOGLE_DOC_MIME_TYPE })).toBe(
				false
			);
			expect(isMeetTranscriptFile({ name: 'Weekly sync - Transcript', mimeType: 'video/mp4' })).toBe(false);
		});
	});

	describe('verifyConnection', () => {
		it('returns valid when the Drive lookup succeeds', async () => {
			listDriveFilesMock.mockResolvedValueOnce({ files: [] });
			const res = await plugin.verifyConnection({}, { settings: SETTINGS });
			expect(res.valid).toBe(true);
			expect(res.details).toMatchObject({ clientId: SETTINGS.clientId });
		});

		it('returns invalid without calling the API when credentials are incomplete', async () => {
			const res = await plugin.verifyConnection({}, { settings: { clientId: SETTINGS.clientId } });
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/refreshToken/);
			expect(clientFactoryMock).not.toHaveBeenCalled();
		});
	});

	it('send rejects — v1 is a read-only event source', async () => {
		await expect(
			plugin.send({ text: 'x', messageRef: 'r', attribution: { userId: 'u1' } }, { settings: SETTINGS })
		).rejects.toThrow(/not supported in v1/);
	});

	describe('pullEvents', () => {
		it('throws EventSourceNotConfiguredError when credentials are missing', async () => {
			await expect(plugin.pullEvents({ since: new Date(0).toISOString(), settings: {} })).rejects.toMatchObject({
				name: 'EventSourceNotConfiguredError'
			});
			expect(listDriveFilesMock).not.toHaveBeenCalled();
		});

		it('first pull with backfill off uses a now-anchored window (no history)', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
			listDriveFilesMock.mockResolvedValueOnce({ files: [] });
			await plugin.pullEvents({ since: new Date(0).toISOString(), settings: DRIVE_ONLY });
			expect(listDriveFilesMock.mock.calls[0][0].q).toContain("modifiedTime > '2026-07-25T12:00:00.000Z'");
		});

		it('first pull with backfillDays widens the window, clamped to 90 days', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
			listDriveFilesMock.mockResolvedValue({ files: [] });
			await plugin.pullEvents({
				since: new Date(0).toISOString(),
				settings: { ...DRIVE_ONLY, backfillDays: 30 }
			});
			expect(listDriveFilesMock.mock.calls[0][0].q).toContain("modifiedTime > '2026-06-25T12:00:00.000Z'");

			await plugin.pullEvents({
				since: new Date(0).toISOString(),
				settings: { ...DRIVE_ONLY, backfillDays: 500 }
			});
			expect(listDriveFilesMock.mock.calls[1][0].q).toContain("modifiedTime > '2026-04-26T12:00:00.000Z'");
		});

		it('a non-first pull keeps the platform watermark as the window', async () => {
			listDriveFilesMock.mockResolvedValueOnce({ files: [] });
			await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				settings: { ...DRIVE_ONLY, backfillDays: 30 }
			});
			expect(listDriveFilesMock.mock.calls[0][0].q).toContain("modifiedTime > '2026-07-20T00:00:00.000Z'");
		});

		it('normalizes Drive files into google.drive-change envelopes with a doc-database workHint', async () => {
			listDriveFilesMock.mockResolvedValueOnce({
				files: [
					{
						id: 'file-1',
						name: 'n'.repeat(GOOGLE_EVENT_TEXT_MAX_CHARS + 50),
						mimeType: 'application/pdf',
						createdTime: '2026-07-21T10:00:00.000Z',
						modifiedTime: '2026-07-22T10:00:00.000Z',
						webViewLink: 'https://drive.google.com/file/d/file-1/view',
						parents: ['folder-9'],
						lastModifyingUser: { displayName: 'Ada' }
					}
				]
			});
			const res = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: DRIVE_ONLY });
			expect(res.events).toHaveLength(1);
			const env = res.events[0];
			expect(env.source).toBe('google-workspace-connector');
			expect(env.kind).toBe('google.drive-change');
			expect(env.sourceEventId).toBe('file-1:2026-07-22T10:00:00.000Z');
			expect(env.occurredAt).toBe('2026-07-22T10:00:00.000Z');
			expect(env.actor).toEqual({ name: 'Ada' });
			expect(env.subject?.type).toBe('file');
			expect(env.workHint).toEqual({ kind: 'doc-database', externalId: 'folder-9' });
			expect(env.sourceUrl).toBe('https://drive.google.com/file/d/file-1/view');
			expect((env.payload.name as string).length).toBe(GOOGLE_EVENT_TEXT_MAX_CHARS);
			// Neither OAuth secret may ever leak into an envelope.
			const serialized = JSON.stringify(res.events);
			expect(serialized).not.toContain(SETTINGS.clientSecret);
			expect(serialized).not.toContain(SETTINGS.refreshToken);
		});

		it('exports Meet transcript docs into google.meet-recording envelopes with a meeting workHint', async () => {
			listDriveFilesMock.mockResolvedValueOnce({
				files: [
					{
						id: 'doc-7',
						name: 'Weekly sync - 2026/07/22 - Transcript',
						mimeType: GOOGLE_DOC_MIME_TYPE,
						createdTime: '2026-07-22T09:00:00.000Z',
						modifiedTime: '2026-07-22T10:00:00.000Z',
						webViewLink: 'https://docs.google.com/document/d/doc-7/edit',
						parents: ['meet-recordings']
					}
				]
			});
			exportDocMock.mockResolvedValueOnce('t'.repeat(GOOGLE_TRANSCRIPT_MAX_CHARS + 500));
			const res = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: DRIVE_ONLY });
			expect(exportDocMock).toHaveBeenCalledWith('doc-7');
			expect(res.events).toHaveLength(1);
			const env = res.events[0];
			expect(env.kind).toBe('google.meet-recording');
			expect(env.sourceEventId).toBe('doc-7:2026-07-22T10:00:00.000Z:transcript');
			expect(env.subject).toEqual({
				type: 'meeting',
				externalId: 'doc-7',
				title: 'Weekly sync - 2026/07/22 - Transcript'
			});
			expect(env.workHint).toMatchObject({ kind: 'meeting', externalId: 'doc-7' });
			expect(env.payload.meetingExternalId).toBe('doc-7');
			expect(env.payload.provider).toBe('google-meet');
			expect((env.payload.transcriptText as string).length).toBe(GOOGLE_TRANSCRIPT_MAX_CHARS);
		});

		it('degrades a failed transcript export to an ordinary drive-change envelope', async () => {
			listDriveFilesMock.mockResolvedValueOnce({
				files: [
					{
						id: 'doc-8',
						name: 'Standup - Transcript',
						mimeType: GOOGLE_DOC_MIME_TYPE,
						modifiedTime: '2026-07-22T10:00:00.000Z'
					}
				]
			});
			exportDocMock.mockRejectedValueOnce(new Error('403 insufficient scope'));
			const res = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: DRIVE_ONLY });
			expect(res.events[0].kind).toBe('google.drive-change');
			expect(res.events[0].payload.transcriptText).toBeUndefined();
		});

		it('skips the transcript export entirely when meetTranscripts is off', async () => {
			listDriveFilesMock.mockResolvedValueOnce({
				files: [
					{
						id: 'doc-9',
						name: 'Retro - Transcript',
						mimeType: GOOGLE_DOC_MIME_TYPE,
						modifiedTime: '2026-07-22T10:00:00.000Z'
					}
				]
			});
			const res = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				settings: { ...DRIVE_ONLY, meetTranscripts: false }
			});
			expect(exportDocMock).not.toHaveBeenCalled();
			expect(res.events[0].kind).toBe('google.drive-change');
		});

		it('normalizes Calendar events into google.calendar-event envelopes keyed on the Meet conference', async () => {
			listCalendarEventsMock.mockResolvedValueOnce({
				items: [
					{
						id: 'evt-1',
						status: 'confirmed',
						summary: 'Weekly sync',
						htmlLink: 'https://calendar.google.com/event?eid=evt-1',
						created: '2026-07-01T09:00:00.000Z',
						updated: '2026-07-22T09:30:00.000Z',
						hangoutLink: 'https://meet.google.com/abc-defg-hij',
						start: { dateTime: '2026-07-23T09:00:00.000Z' },
						end: { dateTime: '2026-07-23T09:30:00.000Z' },
						organizer: { displayName: 'Ada' },
						attendees: [{ email: 'a@acme.dev' }, { email: 'b@acme.dev' }],
						conferenceData: { conferenceId: 'abc-defg-hij' }
					}
				]
			});
			const res = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				settings: CALENDAR_ONLY
			});
			expect(listCalendarEventsMock.mock.calls[0][0]).toMatchObject({
				calendarId: 'primary',
				updatedMin: '2026-07-20T00:00:00.000Z'
			});
			expect(res.events).toHaveLength(1);
			const env = res.events[0];
			expect(env.kind).toBe('google.calendar-event');
			expect(env.sourceEventId).toBe('primary:evt-1:2026-07-22T09:30:00.000Z');
			expect(env.workHint).toEqual({
				kind: 'meeting',
				externalId: 'abc-defg-hij',
				label: 'Weekly sync'
			});
			expect(env.sourceUrl).toBe('https://calendar.google.com/event?eid=evt-1');
			expect(env.payload.attendeeCount).toBe(2);
			expect(env.payload.meetLink).toBe('https://meet.google.com/abc-defg-hij');
		});

		it('pages within a phase and keeps the SAME window across pages', async () => {
			listDriveFilesMock.mockResolvedValueOnce({ files: [], nextPageToken: 'page-2' });
			const first = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: DRIVE_ONLY });
			expect(JSON.parse(first.nextCursor as string)).toMatchObject({
				p: 'drive',
				n: 'page-2',
				s: '2026-07-20T00:00:00.000Z'
			});

			listDriveFilesMock.mockResolvedValueOnce({ files: [] });
			await plugin.pullEvents({
				since: '2026-07-24T00:00:00.000Z', // a moved watermark must NOT shift the running sweep
				cursor: first.nextCursor,
				settings: DRIVE_ONLY
			});
			const args = listDriveFilesMock.mock.calls[1][0];
			expect(args.pageToken).toBe('page-2');
			expect(args.q).toContain("modifiedTime > '2026-07-20T00:00:00.000Z'");
		});

		it('advances drive → each configured calendar → done across the sweep', async () => {
			const settings = { ...SETTINGS, calendarIds: 'primary, team@acme.dev' };
			listDriveFilesMock.mockResolvedValueOnce({ files: [] });
			const afterDrive = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings });
			expect(JSON.parse(afterDrive.nextCursor as string)).toMatchObject({ p: 'calendar', i: 0 });

			listCalendarEventsMock.mockResolvedValueOnce({ items: [] });
			const afterFirstCalendar = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: afterDrive.nextCursor,
				settings
			});
			expect(listCalendarEventsMock.mock.calls[0][0].calendarId).toBe('primary');
			expect(JSON.parse(afterFirstCalendar.nextCursor as string)).toMatchObject({ p: 'calendar', i: 1 });

			listCalendarEventsMock.mockResolvedValueOnce({ items: [] });
			const afterSecondCalendar = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: afterFirstCalendar.nextCursor,
				settings
			});
			expect(listCalendarEventsMock.mock.calls[1][0].calendarId).toBe('team@acme.dev');
			expect(afterSecondCalendar.nextCursor).toBeUndefined();
		});

		it('ends the sweep after drive when calendar is not a configured surface', async () => {
			listDriveFilesMock.mockResolvedValueOnce({ files: [] });
			const res = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: DRIVE_ONLY });
			expect(res.nextCursor).toBeUndefined();
		});

		it('bounds backfill sweeps to the per-phase page budget', async () => {
			listDriveFilesMock.mockResolvedValueOnce({ files: [], nextPageToken: 'more-files' });
			const res = await plugin.pullEvents({
				since: new Date(0).toISOString(),
				cursor: JSON.stringify({
					p: 'drive',
					n: 'page-n',
					s: '2026-05-01T00:00:00.000Z',
					f: 1,
					b: GOOGLE_BACKFILL_MAX_PAGES - 1
				}),
				settings: { ...SETTINGS, backfillDays: 90 }
			});
			// Budget hit mid-drive: jump to the calendar phase instead of paging on.
			const parsed = JSON.parse(res.nextCursor as string);
			expect(parsed.p).toBe('calendar');
			expect(parsed.n).toBeUndefined();
			expect(parsed.b).toBe(0);
		});

		it('treats a malformed cursor as a fresh sweep instead of crashing', async () => {
			listDriveFilesMock.mockResolvedValueOnce({ files: [] });
			const res = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: 'not-json{{{',
				settings: DRIVE_ONLY
			});
			expect(listDriveFilesMock).toHaveBeenCalledTimes(1);
			expect(res.events).toEqual([]);
		});
	});
});
