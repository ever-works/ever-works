import { buildMeetingTools } from '../agent-meeting-tools';

const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'meeting-1',
    userId: 'user-1',
    title: 'Weekly sync',
    startedAt: new Date('2026-07-24T10:00:00.000Z'),
    endedAt: new Date('2026-07-24T10:30:00.000Z'),
    source: 'zoom',
    workId: 'work-9',
    sourceUrl: 'https://example.zoom.us/rec/play/abc',
    participants: [{ name: 'Alice', email: 'alice@example.com' }],
    transcriptText: 'Alice: Hello.',
    summary: 'The team aligned on the launch.',
    ...overrides,
});

describe('buildMeetingTools', () => {
    let repository: { findByUser: jest.Mock; findById: jest.Mock };

    beforeEach(() => {
        repository = {
            findByUser: jest.fn(async () => [row()]),
            findById: jest.fn(async () => row()),
        };
    });

    const tools = () => buildMeetingTools({ userId: 'user-1', repository: repository as never });
    const tool = (name: string) => {
        const found = tools().find((t) => t.name === name);
        if (!found) throw new Error(`missing tool ${name}`);
        return found;
    };

    it('ships both meeting tools (program DoD: chat tools with the entity)', () => {
        expect(tools().map((t) => t.name)).toEqual(['list_meetings', 'get_meeting_summary']);
    });

    describe('list_meetings', () => {
        it('reads owner-scoped, passes filters through and maps rows to the view shape', async () => {
            const result = (await tool('list_meetings').invoke({
                workId: 'work-9',
                source: 'zoom',
                limit: 5,
            })) as { meetings: Record<string, unknown>[] };

            expect(repository.findByUser).toHaveBeenCalledWith('user-1', {
                workId: 'work-9',
                source: 'zoom',
                limit: 5,
            });
            expect(result.meetings).toHaveLength(1);
            expect(result.meetings[0]).toMatchObject({
                id: 'meeting-1',
                title: 'Weekly sync',
                startedAt: '2026-07-24T10:00:00.000Z',
                source: 'zoom',
                sourceUrl: 'https://example.zoom.us/rec/play/abc',
                hasTranscript: true,
                summary: 'The team aligned on the launch.',
            });
        });

        it('caps the limit at 50 and drops unknown source filters', async () => {
            await tool('list_meetings').invoke({ limit: 500, source: 'carrier-pigeon' });

            expect(repository.findByUser).toHaveBeenCalledWith('user-1', { limit: 50 });
        });

        it('returns a tool-shaped error instead of throwing', async () => {
            repository.findByUser.mockRejectedValue(new Error('db down'));

            expect(await tool('list_meetings').invoke({})).toEqual({ error: 'db down' });
        });
    });

    describe('get_meeting_summary', () => {
        it('returns the summary view for the caller’s own meeting', async () => {
            const result = (await tool('get_meeting_summary').invoke({
                meetingId: 'meeting-1',
            })) as { meeting: Record<string, unknown> };

            expect(result.meeting).toMatchObject({
                id: 'meeting-1',
                summary: 'The team aligned on the launch.',
                hasTranscript: true,
            });
        });

        it('treats other owners’ meetings exactly like missing ones (no existence leak)', async () => {
            repository.findById.mockResolvedValue(row({ userId: 'user-2' }));
            expect(await tool('get_meeting_summary').invoke({ meetingId: 'meeting-1' })).toEqual({
                error: 'Meeting meeting-1 not found',
            });

            repository.findById.mockResolvedValue(null);
            expect(await tool('get_meeting_summary').invoke({ meetingId: 'meeting-1' })).toEqual({
                error: 'Meeting meeting-1 not found',
            });
        });

        it('requires the meetingId argument', async () => {
            expect(await tool('get_meeting_summary').invoke({})).toEqual({
                error: 'meetingId is required',
            });
            expect(repository.findById).not.toHaveBeenCalled();
        });
    });
});
