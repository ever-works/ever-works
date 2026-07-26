import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { IngestedEvent } from '../../entities/ingested-event.entity';
import type { Meeting } from '../../entities/meeting.entity';
import {
    MEETING_RECORDING_EVENT_KINDS,
    MEETING_TRANSCRIPT_MAX_CHARS,
    MeetingsService,
} from '../meetings.service';

const meeting = (overrides: Partial<Meeting> = {}): Meeting =>
    ({
        id: 'meeting-1',
        userId: 'user-1',
        organizationId: null,
        workId: null,
        title: 'Weekly sync',
        startedAt: new Date('2026-07-24T10:00:00.000Z'),
        endedAt: null,
        source: 'zoom',
        externalId: 'uuid-1',
        participants: [],
        transcriptText: null,
        summary: null,
        sourceUrl: 'https://example.zoom.us/rec/play/abc',
        dedupeKey: 'abc',
        createdAt: new Date('2026-07-24T11:00:00.000Z'),
        ...overrides,
    }) as Meeting;

const recordingEvent = (overrides: Partial<IngestedEvent> = {}): IngestedEvent =>
    ({
        id: 'row-1',
        userId: 'user-1',
        organizationId: null,
        workId: 'work-9',
        source: 'zoom-connector',
        sourceEventId: 'uuid-1:transcript',
        kind: 'zoom.recording',
        occurredAt: new Date('2026-07-24T10:00:00.000Z'),
        actorName: null,
        subjectType: 'meeting',
        subjectExternalId: 'uuid-1',
        title: 'Weekly sync',
        sourceUrl: 'https://example.zoom.us/rec/play/abc',
        payload: {
            meetingExternalId: 'uuid-1',
            topic: 'Weekly sync',
            startTime: '2026-07-24T10:00:00.000Z',
            durationMinutes: 30,
            transcriptText: 'Alice: Hello.\nBob: Hi.',
        },
        processedAt: null,
        dedupeKey: 'k',
        createdAt: new Date('2026-07-24T11:00:00.000Z'),
        ...overrides,
    }) as IngestedEvent;

/**
 * Google Meet arrives through the google-workspace-connector's Drive
 * sweep (a Meet transcript Google Doc), NOT a Meet-specific connector —
 * same envelope shape, different kind.
 */
const meetRecordingEvent = (overrides: Partial<IngestedEvent> = {}): IngestedEvent =>
    ({
        id: 'row-2',
        userId: 'user-1',
        organizationId: null,
        workId: 'work-9',
        source: 'google-workspace-connector',
        sourceEventId: 'doc-7:2026-07-24T10:30:00.000Z:transcript',
        kind: 'google.meet-recording',
        occurredAt: new Date('2026-07-24T10:30:00.000Z'),
        actorName: null,
        subjectType: 'meeting',
        subjectExternalId: 'doc-7',
        title: 'Weekly sync - 2026/07/24 - Transcript',
        sourceUrl: 'https://docs.google.com/document/d/doc-7/edit',
        payload: {
            meetingExternalId: 'doc-7',
            provider: 'google-meet',
            topic: 'Weekly sync - 2026/07/24 - Transcript',
            startTime: '2026-07-24T10:00:00.000Z',
            transcriptText: 'Ada: Hello.\nBob: Hi.',
        },
        processedAt: null,
        dedupeKey: 'k2',
        createdAt: new Date('2026-07-24T11:00:00.000Z'),
        ...overrides,
    }) as IngestedEvent;

describe('MeetingsService', () => {
    let repository: {
        createIfNew: jest.Mock;
        findByUser: jest.Mock;
        findById: jest.Mock;
        attachTranscript: jest.Mock;
        attachSummary: jest.Mock;
        update: jest.Mock;
        delete: jest.Mock;
    };
    let eventIngest: { ingest: jest.Mock; registerKindProcessor: jest.Mock };
    let aiFacade: { createChatCompletion: jest.Mock };
    let agentMemory: { saveMemory: jest.Mock };

    const build = (opts: { withAi?: boolean; withMemory?: boolean } = {}) =>
        new MeetingsService(
            repository as never,
            eventIngest as never,
            (opts.withAi ?? true) ? (aiFacade as never) : undefined,
            (opts.withMemory ?? true) ? (agentMemory as never) : undefined,
        );

    beforeEach(() => {
        repository = {
            createIfNew: jest.fn(async (data) => ({ meeting: meeting(data), created: true })),
            findByUser: jest.fn(async () => []),
            findById: jest.fn(async () => meeting()),
            attachTranscript: jest.fn(async () => undefined),
            attachSummary: jest.fn(async () => undefined),
            update: jest.fn(async () => undefined),
            delete: jest.fn(async () => undefined),
        };
        eventIngest = {
            ingest: jest.fn(async () => ({ inserted: 1, duplicates: 0, rejected: 0 })),
            registerKindProcessor: jest.fn(),
        };
        aiFacade = {
            createChatCompletion: jest.fn(async () => ({
                choices: [{ message: { content: 'Summary: the team aligned on the launch.' } }],
            })),
        };
        agentMemory = { saveMemory: jest.fn(async () => ({ id: 'memory-1' })) };
    });

    describe('onModuleInit', () => {
        it('registers the recordings→Meetings kind processor on the ingest spine', () => {
            build().onModuleInit();

            expect(eventIngest.registerKindProcessor).toHaveBeenCalledWith(
                expect.objectContaining({ kinds: MEETING_RECORDING_EVENT_KINDS }),
            );
        });
    });

    describe('ingestTranscript', () => {
        it('stores the transcript, attaches the AI summary, saves memory and emits the envelope', async () => {
            const row = meeting({ workId: 'work-9' });

            const result = await build().ingestTranscript(row, 'Alice: Hello.\nBob: Hi.');

            expect(repository.attachTranscript).toHaveBeenCalledWith(
                'meeting-1',
                'Alice: Hello.\nBob: Hi.',
            );
            expect(repository.attachSummary).toHaveBeenCalledWith(
                'meeting-1',
                'Summary: the team aligned on the launch.',
            );
            expect(result.summary).toBe('Summary: the team aligned on the launch.');
            expect(result.memorySaved).toBe(true);
            expect(result.envelopeEmitted).toBe(true);

            // Memory carries provenance metadata + tags, scoped owner+Work.
            expect(agentMemory.saveMemory).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('Weekly sync'),
                    tags: expect.arrayContaining(['meeting', 'source:zoom', 'work:work-9']),
                    metadata: expect.objectContaining({
                        meetingId: 'meeting-1',
                        source: 'zoom',
                        sourceUrl: 'https://example.zoom.us/rec/play/abc',
                    }),
                }),
                { userId: 'user-1', workId: 'work-9' },
            );

            // Envelope: kind meeting.transcript, content-hashed identity,
            // provenance + Work routing hint.
            expect(eventIngest.ingest).toHaveBeenCalledWith('user-1', [
                expect.objectContaining({
                    source: 'meetings',
                    kind: 'meeting.transcript',
                    sourceEventId: expect.stringMatching(/^meeting-1:transcript:[0-9a-f]{16}$/),
                    sourceUrl: 'https://example.zoom.us/rec/play/abc',
                    workId: 'work-9',
                    payload: expect.objectContaining({
                        meetingId: 'meeting-1',
                        transcriptChars: 'Alice: Hello.\nBob: Hi.'.length,
                    }),
                }),
            ]);
        });

        it('summary failure is best-effort: memory + envelope still run, ingest never throws', async () => {
            aiFacade.createChatCompletion.mockRejectedValue(new Error('provider down'));

            const result = await build().ingestTranscript(meeting(), 'Alice: Hello.');

            expect(result.summary).toBeUndefined();
            expect(repository.attachSummary).not.toHaveBeenCalled();
            expect(result.memorySaved).toBe(true);
            expect(result.envelopeEmitted).toBe(true);
        });

        it('memory failure is best-effort: the transcript and envelope still land', async () => {
            agentMemory.saveMemory.mockRejectedValue(new Error('NoProviderError-ish outage'));

            const result = await build().ingestTranscript(meeting(), 'Alice: Hello.');

            expect(repository.attachTranscript).toHaveBeenCalled();
            expect(result.memorySaved).toBe(false);
            expect(result.envelopeEmitted).toBe(true);
        });

        it('envelope failure is best-effort: the transcript still lands', async () => {
            eventIngest.ingest.mockRejectedValue(new Error('db down'));

            const result = await build().ingestTranscript(meeting(), 'Alice: Hello.');

            expect(repository.attachTranscript).toHaveBeenCalled();
            expect(result.envelopeEmitted).toBe(false);
        });

        it('works without any facade wired (OSS bootstrap): transcript + envelope only', async () => {
            const result = await build({ withAi: false, withMemory: false }).ingestTranscript(
                meeting(),
                'Alice: Hello.',
            );

            expect(repository.attachTranscript).toHaveBeenCalled();
            expect(result.summary).toBeUndefined();
            expect(result.memorySaved).toBe(false);
            expect(result.envelopeEmitted).toBe(true);
        });

        it('caps stored transcripts at the service-level bound', async () => {
            await build().ingestTranscript(
                meeting(),
                'x'.repeat(MEETING_TRANSCRIPT_MAX_CHARS + 500),
            );

            const stored = repository.attachTranscript.mock.calls[0][1] as string;
            expect(stored.length).toBe(MEETING_TRANSCRIPT_MAX_CHARS);
        });
    });

    describe('owner scoping', () => {
        it('getForUser 404s other owners’ meetings exactly like missing ones', async () => {
            repository.findById.mockResolvedValue(meeting({ userId: 'user-2' }));
            await expect(build().getForUser('user-1', 'meeting-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );

            repository.findById.mockResolvedValue(null);
            await expect(build().getForUser('user-1', 'meeting-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('ingestTranscriptForUser refuses other owners’ meetings before any write', async () => {
            repository.findById.mockResolvedValue(meeting({ userId: 'user-2' }));

            await expect(
                build().ingestTranscriptForUser('user-1', 'meeting-1', 'text'),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(repository.attachTranscript).not.toHaveBeenCalled();
        });

        it('deleteForUser only deletes the caller’s own meeting', async () => {
            repository.findById.mockResolvedValue(meeting({ userId: 'user-2' }));

            await expect(build().deleteForUser('user-1', 'meeting-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(repository.delete).not.toHaveBeenCalled();
        });
    });

    describe('createForUser', () => {
        it('validates title and startedAt and defaults the source to manual', async () => {
            await expect(
                build().createForUser('user-1', { title: '  ', startedAt: new Date() }),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                build().createForUser('user-1', { title: 'Sync', startedAt: 'not-a-date' }),
            ).rejects.toBeInstanceOf(BadRequestException);

            await build().createForUser('user-1', {
                title: 'Sync',
                startedAt: '2026-07-24T10:00:00.000Z',
            });
            expect(repository.createIfNew).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'user-1', source: 'manual', title: 'Sync' }),
            );
        });

        it('runs the transcript pipeline when a transcript is supplied at creation', async () => {
            await build().createForUser('user-1', {
                title: 'Sync',
                startedAt: '2026-07-24T10:00:00.000Z',
                transcriptText: 'Alice: Hello.',
            });

            expect(repository.attachTranscript).toHaveBeenCalled();
            expect(eventIngest.ingest).toHaveBeenCalled();
        });
    });

    describe('processRecordingEvent (envelope → Meeting)', () => {
        it('turns a zoom.recording envelope into a deduped Meeting row + transcript ingest', async () => {
            await build().processRecordingEvent(recordingEvent());

            expect(repository.createIfNew).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user-1',
                    workId: 'work-9',
                    title: 'Weekly sync',
                    source: 'zoom',
                    externalId: 'uuid-1',
                    startedAt: new Date('2026-07-24T10:00:00.000Z'),
                    // durationMinutes 30 → endedAt = startedAt + 30 min.
                    endedAt: new Date('2026-07-24T10:30:00.000Z'),
                    sourceUrl: 'https://example.zoom.us/rec/play/abc',
                }),
            );
            expect(repository.attachTranscript).toHaveBeenCalledWith(
                expect.any(String),
                'Alice: Hello.\nBob: Hi.',
            );
        });

        it('skips transcript ingest when the envelope carries none or the same text', async () => {
            const { transcriptText: _dropped, ...payload } = recordingEvent().payload as Record<
                string,
                unknown
            >;
            await build().processRecordingEvent(recordingEvent({ payload }));
            expect(repository.attachTranscript).not.toHaveBeenCalled();

            // Idempotency: an existing meeting that already holds this exact
            // transcript is not re-ingested.
            repository.createIfNew.mockResolvedValue({
                meeting: meeting({ transcriptText: 'Alice: Hello.\nBob: Hi.' }),
                created: false,
            });
            await build().processRecordingEvent(recordingEvent());
            expect(repository.attachTranscript).not.toHaveBeenCalled();
        });

        it('skips envelopes with no meeting identity instead of crashing the drain', async () => {
            await build().processRecordingEvent(
                recordingEvent({ subjectExternalId: null, payload: { topic: 'x' } }),
            );
            expect(repository.createIfNew).not.toHaveBeenCalled();
        });

        it('registers google.meet-recording alongside zoom.recording (Meet rides Google Workspace)', () => {
            expect(MEETING_RECORDING_EVENT_KINDS).toContain('zoom.recording');
            expect(MEETING_RECORDING_EVENT_KINDS).toContain('google.meet-recording');
        });

        it('turns a google.meet-recording envelope into a google-meet Meeting + transcript ingest', async () => {
            await build().processRecordingEvent(meetRecordingEvent());

            expect(repository.createIfNew).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user-1',
                    workId: 'work-9',
                    title: 'Weekly sync - 2026/07/24 - Transcript',
                    // Source is derived from the envelope KIND, never hardcoded.
                    source: 'google-meet',
                    externalId: 'doc-7',
                    sourceUrl: 'https://docs.google.com/document/d/doc-7/edit',
                }),
            );
            expect(repository.attachTranscript).toHaveBeenCalledWith(
                expect.any(String),
                'Ada: Hello.\nBob: Hi.',
            );
        });

        it('falls back to the import source for an unrecognized recording kind', async () => {
            await build().processRecordingEvent(meetRecordingEvent({ kind: 'future.recording' }));

            expect(repository.createIfNew).toHaveBeenCalledWith(
                expect.objectContaining({ source: 'import' }),
            );
        });
    });
});
