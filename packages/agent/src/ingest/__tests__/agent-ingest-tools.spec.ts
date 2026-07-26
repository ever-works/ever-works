import { buildIngestEventTools } from '../agent-ingest-tools';
import type { IngestedEvent } from '../../entities/ingested-event.entity';
import type { IngestedEventRepository } from '../ingested-event.repository';

const row = (overrides: Partial<IngestedEvent> = {}): IngestedEvent =>
    ({
        id: 'row-1',
        userId: 'user-1',
        source: 'slack-connector',
        sourceEventId: 'evt-1',
        kind: 'slack.message',
        occurredAt: new Date('2026-07-01T10:00:00.000Z'),
        actorName: 'Ada',
        title: 'general',
        sourceUrl: 'https://example.com/archives/C123/p1',
        workId: null,
        payload: {},
        processedAt: new Date('2026-07-01T10:05:00.000Z'),
        dedupeKey: 'abc',
        createdAt: new Date('2026-07-01T10:00:05.000Z'),
        ...overrides,
    }) as IngestedEvent;

describe('buildIngestEventTools — list_recent_events', () => {
    let findRecentByUser: jest.Mock;

    const tool = () => {
        findRecentByUser = findRecentByUser ?? jest.fn(async () => [row()]);
        const repository = { findRecentByUser } as unknown as IngestedEventRepository;
        const tools = buildIngestEventTools({ userId: 'user-1', repository });
        const found = tools.find((t) => t.name === 'list_recent_events');
        if (!found) throw new Error('list_recent_events tool not built');
        return found;
    };

    beforeEach(() => {
        findRecentByUser = jest.fn(async () => [row()]);
    });

    it('reads owner-scoped rows and maps them with the sourceUrl provenance', async () => {
        const result = (await tool().invoke({})) as { events: Array<Record<string, unknown>> };

        expect(findRecentByUser).toHaveBeenCalledWith('user-1', { limit: 20 });
        expect(result.events).toEqual([
            expect.objectContaining({
                id: 'row-1',
                source: 'slack-connector',
                kind: 'slack.message',
                occurredAt: '2026-07-01T10:00:00.000Z',
                actorName: 'Ada',
                title: 'general',
                sourceUrl: 'https://example.com/archives/C123/p1',
                processed: true,
            }),
        ]);
    });

    it('pushes the source filter into the query so the page is never starved', async () => {
        findRecentByUser.mockResolvedValue([row({ id: 'b' })]);

        const result = (await tool().invoke({ source: 'slack-connector', limit: 5 })) as {
            events: Array<{ id: string }>;
        };

        expect(findRecentByUser).toHaveBeenCalledWith('user-1', {
            limit: 5,
            source: 'slack-connector',
        });
        expect(result.events.map((e) => e.id)).toEqual(['b']);
    });

    it('pushes the workId filter into the query — the per-Work activity feed', async () => {
        findRecentByUser.mockResolvedValue([row({ id: 'w', workId: 'work-1' })]);

        const result = (await tool().invoke({ workId: 'work-1' })) as {
            events: Array<{ id: string; workId?: string }>;
        };

        expect(findRecentByUser).toHaveBeenCalledWith('user-1', { limit: 20, workId: 'work-1' });
        expect(result.events[0].workId).toBe('work-1');
    });

    it('caps the limit at 50 and floors it at 1', async () => {
        await tool().invoke({ limit: 500 });
        expect(findRecentByUser).toHaveBeenLastCalledWith('user-1', { limit: 50 });

        await tool().invoke({ limit: -3 });
        expect(findRecentByUser).toHaveBeenLastCalledWith('user-1', { limit: 1 });
    });

    it('returns a tool-shaped error instead of throwing', async () => {
        findRecentByUser.mockRejectedValue(new Error('db down'));

        const result = await tool().invoke({});

        expect(result).toEqual({ error: 'db down' });
    });
});
