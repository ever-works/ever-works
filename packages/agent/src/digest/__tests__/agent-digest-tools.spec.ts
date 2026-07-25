import { buildDigestTools } from '../agent-digest-tools';
import type { ComposedDigest } from '../digest.types';

const composed = (period: 'daily' | 'weekly'): ComposedDigest => ({
    period,
    since: '2026-07-24T07:15:00.000Z',
    until: '2026-07-25T07:15:00.000Z',
    quiet: false,
    markdown: `# Your ${period} digest`,
    text: `${period === 'daily' ? 'Daily' : 'Weekly'} digest: 1 task done.`,
    counts: {
        runsCompleted: 0,
        runsFailed: 0,
        tasksDone: 1,
        tasksInReview: 0,
        prsOpened: 0,
        eventsBySource: {},
        eventsTotal: 0,
        goalsTracked: 0,
    },
});

describe('buildDigestTools — get_digest', () => {
    let digestService: { composeDigest: jest.Mock };

    beforeEach(() => {
        digestService = {
            composeDigest: jest.fn(async (_userId: string, opts: { period: 'daily' | 'weekly' }) =>
                composed(opts.period),
            ),
        };
    });

    it('exposes a single owner-scoped read tool with the descriptor shape', () => {
        const tools = buildDigestTools({ userId: 'user-1', digestService });

        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe('get_digest');
        expect(tools[0].parameters.type).toBe('object');
        expect(tools[0].parameters.properties.period.type).toBe('string');
        expect(tools[0].parameters.required).toEqual([]);
    });

    it('defaults to the daily period and composes for the bound user only', async () => {
        const tools = buildDigestTools({ userId: 'user-1', digestService });

        const result = (await tools[0].invoke({})) as ComposedDigest;

        expect(digestService.composeDigest).toHaveBeenCalledWith('user-1', { period: 'daily' });
        expect(result.period).toBe('daily');
        expect(result.markdown).toContain('daily digest');
    });

    it('passes an explicit weekly period through', async () => {
        const tools = buildDigestTools({ userId: 'user-1', digestService });

        const result = (await tools[0].invoke({ period: 'weekly' })) as ComposedDigest;

        expect(digestService.composeDigest).toHaveBeenCalledWith('user-1', { period: 'weekly' });
        expect(result.period).toBe('weekly');
    });

    it('rejects unknown periods without calling the service', async () => {
        const tools = buildDigestTools({ userId: 'user-1', digestService });

        const result = await tools[0].invoke({ period: 'hourly' });

        expect(result).toEqual({
            error: 'Invalid period "hourly": expected "daily" or "weekly".',
        });
        expect(digestService.composeDigest).not.toHaveBeenCalled();
    });

    it('maps service failures to the { error } tool contract', async () => {
        digestService.composeDigest.mockRejectedValue(new Error('compose blew up'));
        const tools = buildDigestTools({ userId: 'user-1', digestService });

        const result = await tools[0].invoke({});

        expect(result).toEqual({ error: 'compose blew up' });
    });
});
