import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	ZoomConnectorPlugin,
	clampBackfillDays,
	parseVttToText,
	ZOOM_TRANSCRIPT_MAX_CHARS,
	ZOOM_BACKFILL_MAX_PAGES,
	ZOOM_WINDOW_MAX_DAYS
} from './zoom-connector-plugin.js';
import type { ZoomRecordingsPage } from './zoom-connector-plugin.js';
import { supportsEventSourceBackfill } from '@ever-works/plugin';

const listAllRecordingsMock = vi.fn();
const downloadTranscriptMock = vi.fn();
const clientFactoryMock = vi.fn();

/** Subclass overriding the client seam so no real SDK call ever happens. */
class TestZoomConnectorPlugin extends ZoomConnectorPlugin {
	protected override createClient(credentials: { accountId: string; clientId: string; clientSecret: string }) {
		clientFactoryMock(credentials);
		return {
			listAllRecordings: listAllRecordingsMock,
			downloadTranscript: downloadTranscriptMock
		};
	}
}

const SETTINGS = {
	accountId: 'acc_1',
	clientId: 'client_1',
	clientSecret: 'secret_1'
};

const DAY_MS = 86_400_000;
const EPOCH = new Date(0).toISOString();

function emptyPage(): ZoomRecordingsPage {
	return { meetings: [] };
}

function recordingMeeting(overrides: Record<string, unknown> = {}) {
	return {
		uuid: 'uuid-1',
		id: 123456,
		topic: 'Weekly sync',
		start_time: '2026-07-24T10:00:00Z',
		duration: 42,
		host_id: 'host-1',
		recording_files: [
			{
				id: 'file-mp4',
				file_type: 'MP4',
				play_url: 'https://example.zoom.us/rec/play/abc',
				download_url: 'https://example.zoom.us/rec/download/abc',
				status: 'completed'
			}
		],
		...overrides
	};
}

describe('ZoomConnectorPlugin', () => {
	let plugin: TestZoomConnectorPlugin;

	beforeEach(() => {
		plugin = new TestZoomConnectorPlugin();
		listAllRecordingsMock.mockReset();
		downloadTranscriptMock.mockReset();
		clientFactoryMock.mockReset();
	});

	it('declares the connector + event-source capabilities and secret-marked settings', () => {
		expect(plugin.id).toBe('zoom-connector');
		expect(plugin.category).toBe('connector');
		expect(plugin.capabilities).toEqual(['connector', 'event-source']);
		expect(plugin.providerName).toBe('zoom');
		expect(plugin.connector.direction).toBe('inbound');
		expect(plugin.connector.transport).toBe('poll');
		expect(plugin.connector.flags.inbound).toBe(true);
		expect(plugin.connector.flags.outboundMessage).toBe(false);
		const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
		expect(props.clientSecret['x-secret']).toBe(true);
		expect(plugin.settingsSchema.required).toEqual(['accountId', 'clientId', 'clientSecret']);
	});

	it('clampBackfillDays clamps to the 0–90 range and rejects garbage', () => {
		expect(clampBackfillDays(0)).toBe(0);
		expect(clampBackfillDays(-5)).toBe(0);
		expect(clampBackfillDays('nope')).toBe(0);
		expect(clampBackfillDays(14.9)).toBe(14);
		expect(clampBackfillDays(365)).toBe(90);
	});

	it('parseVttToText strips WEBVTT headers, cue indices and timing lines', () => {
		const vtt = [
			'WEBVTT',
			'',
			'1',
			'00:00:01.000 --> 00:00:04.000',
			'Alice: Welcome everyone.',
			'',
			'2',
			'00:00:05.000 --> 00:00:09.000',
			'Bob: Thanks, glad to be here.'
		].join('\n');
		expect(parseVttToText(vtt)).toBe('Alice: Welcome everyone.\nBob: Thanks, glad to be here.');
	});

	it('pullEvents throws EventSourceNotConfiguredError without full credentials', async () => {
		await expect(plugin.pullEvents({ since: EPOCH, settings: { accountId: 'a' } })).rejects.toMatchObject({
			name: 'EventSourceNotConfiguredError'
		});
		expect(listAllRecordingsMock).not.toHaveBeenCalled();
	});

	it('normalizes a completed recording into a zoom.recording envelope', async () => {
		listAllRecordingsMock.mockResolvedValueOnce({ meetings: [recordingMeeting()] });
		const result = await plugin.pullEvents({
			since: new Date(Date.now() - DAY_MS).toISOString(),
			settings: SETTINGS
		});
		expect(result.events).toHaveLength(1);
		const envelope = result.events[0];
		expect(envelope.source).toBe('zoom-connector');
		expect(envelope.kind).toBe('zoom.recording');
		expect(envelope.sourceEventId).toBe('uuid-1:recording');
		expect(envelope.occurredAt).toBe('2026-07-24T10:00:00Z');
		expect(envelope.subject).toMatchObject({ type: 'meeting', externalId: 'uuid-1', title: 'Weekly sync' });
		expect(envelope.sourceUrl).toBe('https://example.zoom.us/rec/play/abc');
		expect(envelope.payload).toMatchObject({
			meetingExternalId: 'uuid-1',
			meetingNumber: 123456,
			topic: 'Weekly sync',
			durationMinutes: 42,
			recordingCount: 1
		});
		expect(envelope.payload?.transcriptText).toBeUndefined();
	});

	it('downloads + parses the transcript when a completed TRANSCRIPT file exists', async () => {
		listAllRecordingsMock.mockResolvedValueOnce({
			meetings: [
				recordingMeeting({
					recording_files: [
						{
							id: 'file-vtt',
							file_type: 'TRANSCRIPT',
							download_url: 'https://example.zoom.us/rec/download/vtt',
							status: 'completed'
						},
						{
							id: 'file-mp4',
							file_type: 'MP4',
							play_url: 'https://example.zoom.us/rec/play/abc',
							status: 'completed'
						}
					]
				})
			]
		});
		downloadTranscriptMock.mockResolvedValueOnce('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nAlice: Hello world.');
		const result = await plugin.pullEvents({ since: new Date().toISOString(), settings: SETTINGS });
		expect(downloadTranscriptMock).toHaveBeenCalledWith('https://example.zoom.us/rec/download/vtt');
		expect(result.events[0].sourceEventId).toBe('uuid-1:transcript');
		expect(result.events[0].payload?.transcriptText).toBe('Alice: Hello world.');
	});

	it('truncates oversized transcripts to the envelope-safe cap', async () => {
		listAllRecordingsMock.mockResolvedValueOnce({
			meetings: [
				recordingMeeting({
					recording_files: [
						{
							file_type: 'TRANSCRIPT',
							download_url: 'https://example.zoom.us/rec/download/vtt',
							status: 'completed'
						}
					]
				})
			]
		});
		downloadTranscriptMock.mockResolvedValueOnce(`Alice: ${'a'.repeat(ZOOM_TRANSCRIPT_MAX_CHARS * 2)}`);
		const result = await plugin.pullEvents({ since: new Date().toISOString(), settings: SETTINGS });
		expect((result.events[0].payload?.transcriptText as string).length).toBe(ZOOM_TRANSCRIPT_MAX_CHARS);
	});

	it('degrades to a transcript-less envelope when the download fails', async () => {
		listAllRecordingsMock.mockResolvedValueOnce({
			meetings: [
				recordingMeeting({
					recording_files: [
						{
							file_type: 'TRANSCRIPT',
							download_url: 'https://example.zoom.us/rec/download/vtt',
							status: 'completed'
						}
					]
				})
			]
		});
		downloadTranscriptMock.mockRejectedValueOnce(new Error('HTTP 401'));
		const result = await plugin.pullEvents({ since: new Date().toISOString(), settings: SETTINGS });
		expect(result.events).toHaveLength(1);
		expect(result.events[0].sourceEventId).toBe('uuid-1:recording');
		expect(result.events[0].payload?.transcriptText).toBeUndefined();
	});

	it('round-trips the API page token through the pull cursor', async () => {
		listAllRecordingsMock.mockResolvedValueOnce({
			meetings: [recordingMeeting()],
			next_page_token: 'token-2'
		});
		const first = await plugin.pullEvents({ since: new Date().toISOString(), settings: SETTINGS });
		expect(first.nextCursor).toBeDefined();
		const cursor = JSON.parse(first.nextCursor as string);
		expect(cursor.n).toBe('token-2');

		listAllRecordingsMock.mockResolvedValueOnce(emptyPage());
		await plugin.pullEvents({
			since: new Date().toISOString(),
			cursor: first.nextCursor,
			settings: SETTINGS
		});
		expect(listAllRecordingsMock).toHaveBeenLastCalledWith(expect.objectContaining({ next_page_token: 'token-2' }));
	});

	it('chunks sweeps older than the 30-day window bound and advances chunk by chunk', async () => {
		const since = new Date(Date.now() - 75 * DAY_MS).toISOString();
		listAllRecordingsMock.mockResolvedValue(emptyPage());

		// Chunk 1: [since, since+30d].
		const first = await plugin.pullEvents({ since, settings: SETTINGS });
		const firstQuery = listAllRecordingsMock.mock.calls[0][0];
		expect(firstQuery.from).toBe(since.slice(0, 10));
		const chunk1To = new Date(Date.parse(since) + ZOOM_WINDOW_MAX_DAYS * DAY_MS);
		expect(firstQuery.to).toBe(chunk1To.toISOString().slice(0, 10));
		expect(first.nextCursor).toBeDefined();

		// Chunk 2 resumes where chunk 1 ended.
		const second = await plugin.pullEvents({ since, cursor: first.nextCursor, settings: SETTINGS });
		const secondQuery = listAllRecordingsMock.mock.calls[1][0];
		expect(secondQuery.from).toBe(chunk1To.toISOString().slice(0, 10));
		expect(second.nextCursor).toBeDefined();

		// Chunk 3 is the tail — the sweep completes with no cursor.
		const third = await plugin.pullEvents({ since, cursor: second.nextCursor, settings: SETTINGS });
		expect(third.nextCursor).toBeUndefined();
	});

	it('first pull with opt-in backfill widens the window; without it starts at now', async () => {
		listAllRecordingsMock.mockResolvedValue(emptyPage());

		await plugin.pullEvents({ since: EPOCH, settings: { ...SETTINGS, backfillDays: 7 } });
		const backfillQuery = listAllRecordingsMock.mock.calls[0][0];
		expect(backfillQuery.from).toBe(new Date(Date.now() - 7 * DAY_MS).toISOString().slice(0, 10));

		await plugin.pullEvents({ since: EPOCH, settings: SETTINGS });
		const freshQuery = listAllRecordingsMock.mock.calls[1][0];
		expect(freshQuery.from).toBe(new Date().toISOString().slice(0, 10));
	});

	it('caps backfill sweeps at the per-chunk page budget', async () => {
		listAllRecordingsMock.mockResolvedValue({ meetings: [], next_page_token: 'more' });
		let result = await plugin.pullEvents({ since: EPOCH, settings: { ...SETTINGS, backfillDays: 7 } });
		for (let page = 1; page < ZOOM_BACKFILL_MAX_PAGES; page += 1) {
			expect(result.nextCursor).toBeDefined();
			result = await plugin.pullEvents({ since: EPOCH, cursor: result.nextCursor, settings: SETTINGS });
		}
		// Budget spent — the cursor no longer carries a page token (the
		// sweep either advances to the next chunk or completes).
		const cursor = result.nextCursor ? JSON.parse(result.nextCursor) : undefined;
		expect(cursor?.n).toBeUndefined();
	});

	it('verifyConnection reports ok with credentials and fails cleanly without', async () => {
		listAllRecordingsMock.mockResolvedValueOnce(emptyPage());
		const ok = await plugin.verifyConnection({}, { settings: SETTINGS });
		expect(ok.valid).toBe(true);

		const missing = await plugin.verifyConnection({}, { settings: {} });
		expect(missing.valid).toBe(false);

		listAllRecordingsMock.mockRejectedValueOnce(new Error('invalid client'));
		const broken = await plugin.verifyConnection({}, { settings: SETTINGS });
		expect(broken.valid).toBe(false);
		expect(broken.message).toContain('invalid client');
	});

	it('send rejects loudly — Meetings v1 is transcript-first (bot-join is the follow-up)', async () => {
		await expect(
			plugin.send({ messageRef: 'ref-1', text: 'hello' } as never, { settings: SETTINGS })
		).rejects.toThrow(/not supported in v1/);
	});

	// `backfill()` capability method (audit item (l)).
	describe('backfill', () => {
		it('is exposed as the capability method, feature-detectable by callers', () => {
			expect(typeof plugin.backfill).toBe('function');
			expect(supportsEventSourceBackfill(plugin as never)).toBe(true);
		});

		it('⭐ sweeps an EXPLICIT window regardless of the settings backfillDays', async () => {
			listAllRecordingsMock.mockResolvedValue(emptyPage());
			const since = '2026-05-01T00:00:00.000Z';
			const until = '2026-05-10T00:00:00.000Z';

			// `backfillDays` is deliberately absent: history used to be
			// reachable ONLY through that first-pull setting.
			const result = await plugin.backfill({ since, until, settings: SETTINGS });

			const query = listAllRecordingsMock.mock.calls[0][0];
			expect(query.from).toBe('2026-05-01');
			expect(query.to).toBe('2026-05-10');
			expect(result.complete).toBe(true);
			expect(result.nextCursor).toBeUndefined();
		});

		it('chunks a long window and resumes from the returned cursor', async () => {
			listAllRecordingsMock.mockResolvedValue(emptyPage());
			const since = '2026-01-01T00:00:00.000Z';
			const until = new Date(Date.parse(since) + 3 * ZOOM_WINDOW_MAX_DAYS * DAY_MS).toISOString();

			const first = await plugin.backfill({ since, until, settings: SETTINGS });
			expect(first.nextCursor).toBeDefined();
			expect(first.complete).toBeUndefined();

			const second = await plugin.backfill({
				since,
				until,
				cursor: first.nextCursor,
				settings: SETTINGS
			});
			// The second call advanced past the first ≤30-day chunk.
			expect(listAllRecordingsMock.mock.calls[1][0].from).not.toBe(listAllRecordingsMock.mock.calls[0][0].from);
			expect(second.nextCursor).toBeDefined();
		});

		it('defaults `until` to now and normalizes an inverted window to a no-op', async () => {
			listAllRecordingsMock.mockResolvedValue(emptyPage());

			const empty = await plugin.backfill({
				since: '2026-07-01T00:00:00.000Z',
				until: '2026-06-01T00:00:00.000Z',
				settings: SETTINGS
			});
			expect(empty).toEqual({ events: [], complete: true });
			expect(listAllRecordingsMock).not.toHaveBeenCalled();

			await plugin.backfill({ since: new Date(Date.now() - DAY_MS).toISOString(), settings: SETTINGS });
			expect(listAllRecordingsMock.mock.calls[0][0].to).toBe(new Date().toISOString().slice(0, 10));
		});

		it('normalizes ingested recordings the same way the incremental sweep does', async () => {
			listAllRecordingsMock.mockResolvedValue({ meetings: [recordingMeeting()] });

			const result = await plugin.backfill({
				since: '2026-07-01T00:00:00.000Z',
				until: '2026-07-20T00:00:00.000Z',
				settings: SETTINGS
			});

			expect(result.events).toHaveLength(1);
			expect(result.events[0]).toMatchObject({
				source: 'zoom-connector',
				kind: 'zoom.recording',
				sourceEventId: 'uuid-1:recording'
			});
		});

		it('rejects a malformed window loudly instead of sweeping something arbitrary', async () => {
			await expect(plugin.backfill({ since: 'yesterday', settings: SETTINGS })).rejects.toThrow(/valid ISO 8601/);
			await expect(
				plugin.backfill({ since: '2026-07-01T00:00:00.000Z', until: 'soon', settings: SETTINGS })
			).rejects.toThrow(/valid ISO 8601/);
		});

		it('still requires credentials — an unconfigured source fails with the stable error name', async () => {
			await expect(plugin.backfill({ since: '2026-07-01T00:00:00.000Z', settings: {} })).rejects.toMatchObject({
				name: 'EventSourceNotConfiguredError'
			});
		});
	});
});
