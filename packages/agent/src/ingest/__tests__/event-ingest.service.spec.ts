import type { IngestedEventEnvelope } from '@ever-works/contracts';
import { EventIngestService } from '../event-ingest.service';
import { ActivityActionType, ActivityStatus } from '../../entities/activity-log.types';
import type { IngestedEvent } from '../../entities/ingested-event.entity';

const envelope = (overrides: Partial<IngestedEventEnvelope> = {}): IngestedEventEnvelope => ({
    id: 'env-1',
    source: 'slack-connector',
    sourceEventId: 'evt-1',
    kind: 'slack.message',
    occurredAt: '2026-07-01T10:00:00.000Z',
    actor: { name: 'Ada' },
    subject: { type: 'channel', externalId: 'C123', title: 'general' },
    sourceUrl: 'https://example.com/archives/C123/p1',
    payload: { text: 'hello' },
    ...overrides,
});

const storedEvent = (overrides: Partial<IngestedEvent> = {}): IngestedEvent =>
    ({
        id: 'row-1',
        userId: 'user-1',
        organizationId: null,
        workId: null,
        source: 'slack-connector',
        sourceEventId: 'evt-1',
        kind: 'slack.message',
        occurredAt: new Date('2026-07-01T10:00:00.000Z'),
        actorName: 'Ada',
        subjectType: 'channel',
        subjectExternalId: 'C123',
        title: 'general',
        sourceUrl: 'https://example.com/archives/C123/p1',
        payload: { text: 'hello' },
        processedAt: null,
        dedupeKey: 'abc',
        createdAt: new Date('2026-07-01T10:00:05.000Z'),
        ...overrides,
    }) as IngestedEvent;

describe('EventIngestService', () => {
    let repository: {
        createIfNew: jest.Mock;
        findUnprocessed: jest.Mock;
        markProcessed: jest.Mock;
        findRecentByUser: jest.Mock;
    };
    let activityLog: { log: jest.Mock };
    let agentMemory: { saveMemory: jest.Mock };

    const build = (opts: { withMemory?: boolean } = { withMemory: true }) =>
        new EventIngestService(
            repository as never,
            activityLog as never,
            opts.withMemory ? (agentMemory as never) : undefined,
        );

    beforeEach(() => {
        repository = {
            createIfNew: jest.fn(async () => ({ event: storedEvent(), created: true })),
            findUnprocessed: jest.fn(async () => []),
            markProcessed: jest.fn(async () => undefined),
            findRecentByUser: jest.fn(async () => []),
        };
        activityLog = { log: jest.fn(async () => ({ id: 'activity-1' })) };
        agentMemory = { saveMemory: jest.fn(async () => ({ id: 'memory-1' })) };
    });

    describe('ingest', () => {
        it('maps the envelope onto the row shape (actor/subject flattened, occurredAt parsed)', async () => {
            const result = await build().ingest('user-1', [envelope()]);

            expect(result).toEqual({ inserted: 1, duplicates: 0, rejected: 0 });
            expect(repository.createIfNew).toHaveBeenCalledWith({
                userId: 'user-1',
                organizationId: null,
                workId: null,
                source: 'slack-connector',
                sourceEventId: 'evt-1',
                kind: 'slack.message',
                occurredAt: new Date('2026-07-01T10:00:00.000Z'),
                actorName: 'Ada',
                subjectType: 'channel',
                subjectExternalId: 'C123',
                title: 'general',
                sourceUrl: 'https://example.com/archives/C123/p1',
                payload: { text: 'hello' },
            });
        });

        it('counts duplicates instead of inserting the same event twice', async () => {
            repository.createIfNew
                .mockResolvedValueOnce({ event: storedEvent(), created: true })
                .mockResolvedValueOnce({ event: storedEvent(), created: false });

            const result = await build().ingest('user-1', [envelope(), envelope()]);

            expect(result).toEqual({ inserted: 1, duplicates: 1, rejected: 0 });
            expect(repository.createIfNew).toHaveBeenCalledTimes(2);
        });

        it('rejects envelopes whose serialized payload exceeds the 32 KB cap', async () => {
            const oversized = envelope({ payload: { blob: 'x'.repeat(33 * 1024) } });

            const result = await build().ingest('user-1', [oversized, envelope()]);

            expect(result).toEqual({ inserted: 1, duplicates: 0, rejected: 1 });
            expect(repository.createIfNew).toHaveBeenCalledTimes(1);
        });

        it('rejects envelopes with an unparseable occurredAt', async () => {
            const result = await build().ingest('user-1', [envelope({ occurredAt: 'not-a-date' })]);

            expect(result).toEqual({ inserted: 0, duplicates: 0, rejected: 1 });
            expect(repository.createIfNew).not.toHaveBeenCalled();
        });

        it('rejects envelopes missing the identity floor (source / sourceEventId / kind)', async () => {
            const result = await build().ingest('user-1', [
                envelope({ source: '' }),
                envelope({ sourceEventId: '' }),
                envelope({ kind: '' }),
            ]);

            expect(result).toEqual({ inserted: 0, duplicates: 0, rejected: 3 });
            expect(repository.createIfNew).not.toHaveBeenCalled();
        });
    });

    describe('processBatch', () => {
        it('writes an Activity row carrying the sourceUrl provenance and marks the row processed', async () => {
            const event = storedEvent();
            repository.findUnprocessed.mockResolvedValue([event]);

            const result = await build().processBatch(10);

            expect(result).toEqual({ processed: 1, activities: 1, memories: 1, failed: 0 });
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user-1',
                    actionType: ActivityActionType.EXTERNAL_EVENT_INGESTED,
                    action: 'slack.message',
                    status: ActivityStatus.COMPLETED,
                    summary: expect.stringContaining('slack.message'),
                    metadata: expect.objectContaining({
                        source: 'slack-connector',
                        sourceEventId: 'evt-1',
                        sourceUrl: 'https://example.com/archives/C123/p1',
                    }),
                }),
                // Feed orders by "when it happened".
                { createdAt: event.occurredAt },
            );
            expect(repository.markProcessed).toHaveBeenCalledWith('row-1');
        });

        it('saves a Memory observation with provenance tags scoped to the owner (and Work when routed)', async () => {
            repository.findUnprocessed.mockResolvedValue([storedEvent({ workId: 'work-9' })]);

            await build().processBatch(10);

            expect(agentMemory.saveMemory).toHaveBeenCalledWith(
                expect.objectContaining({
                    tags: expect.arrayContaining([
                        'ingested-event',
                        'source:slack-connector',
                        'kind:slack.message',
                        'work:work-9',
                    ]),
                    metadata: expect.objectContaining({
                        sourceUrl: 'https://example.com/archives/C123/p1',
                    }),
                }),
                { userId: 'user-1', workId: 'work-9' },
            );
        });

        it('memory failure is best-effort: the row is STILL marked processed', async () => {
            repository.findUnprocessed.mockResolvedValue([storedEvent()]);
            agentMemory.saveMemory.mockRejectedValue(new Error('memory backend down'));

            const result = await build().processBatch(10);

            expect(result).toEqual({ processed: 1, activities: 1, memories: 0, failed: 0 });
            expect(repository.markProcessed).toHaveBeenCalledWith('row-1');
        });

        it('runs without a memory facade at all (OSS / no provider wiring)', async () => {
            repository.findUnprocessed.mockResolvedValue([storedEvent()]);

            const result = await build({ withMemory: false }).processBatch(10);

            expect(result).toEqual({ processed: 1, activities: 1, memories: 0, failed: 0 });
            expect(repository.markProcessed).toHaveBeenCalledWith('row-1');
        });

        it('activity failure leaves the row unprocessed for retry and keeps draining the batch', async () => {
            const bad = storedEvent({ id: 'row-bad' });
            const good = storedEvent({ id: 'row-good' });
            repository.findUnprocessed.mockResolvedValue([bad, good]);
            activityLog.log
                .mockRejectedValueOnce(new Error('db write failed'))
                .mockResolvedValueOnce({ id: 'activity-2' });

            const result = await build().processBatch(10);

            expect(result).toEqual({ processed: 1, activities: 1, memories: 1, failed: 1 });
            expect(repository.markProcessed).not.toHaveBeenCalledWith('row-bad');
            expect(repository.markProcessed).toHaveBeenCalledWith('row-good');
        });

        it('passes the batch limit through to the unprocessed read', async () => {
            repository.findUnprocessed.mockResolvedValue([]);

            await build().processBatch(7);
            expect(repository.findUnprocessed).toHaveBeenCalledWith(7);

            await build().processBatch();
            expect(repository.findUnprocessed).toHaveBeenCalledWith(50);
        });
    });
});
