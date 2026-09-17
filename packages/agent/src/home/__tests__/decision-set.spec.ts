import type { InboxDecisionDto, InboxItemOption } from '@ever-works/contracts';
import {
    HomeDecisionsBuilder,
    toHomeDecisions,
    type HomeDecisionPage,
} from '../builders/decisions.builder';
import type { HomeBuildContext } from '../home-build-context';

const NOW = new Date('2026-09-14T07:04:00.000Z');
const HOUR = 60 * 60 * 1000;

function decision(overrides: Partial<InboxDecisionDto> = {}): InboxDecisionDto {
    return {
        id: 'item-1',
        kind: 'question',
        title: 'Which category for these items?',
        body: '',
        options: null,
        sourceType: 'agent-run',
        agentId: 'agent-1',
        agentRunId: null,
        taskId: null,
        workId: null,
        escalationId: null,
        proposalId: null,
        status: 'open',
        unread: true,
        answeredAt: null,
        answerText: null,
        answerOptionId: null,
        createdAt: new Date(NOW.getTime() - 20 * 60 * 1000).toISOString(),
        updatedAt: NOW.toISOString(),
        decision: {
            blocking: false,
            blockingReason: null,
            confidence: null,
            confidenceSource: null,
            reasonCode: null,
            attempted: [],
            actionType: null,
            riskFlags: [],
            agentName: 'Research',
            taskId: null,
            taskTitle: null,
            taskStatus: null,
            missionId: null,
            runStatus: null,
            dormant: false,
        },
        ...overrides,
    };
}

function page(items: InboxDecisionDto[], total = items.length, blocking = 0): HomeDecisionPage {
    return { items, total, counts: { open: total, blocking, lastRaisedAt: null } };
}

function options(count: number): InboxItemOption[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `o${index}`,
        label: `Option ${index}`,
    }));
}

function context(): HomeBuildContext {
    return {
        userId: 'user-1',
        scope: { tenantId: null, organizationId: null },
        timezone: 'UTC',
        day: {
            date: '2026-09-14',
            from: new Date('2026-09-14T00:00:00.000Z'),
            to: new Date('2026-09-15T00:00:00.000Z'),
        },
        now: NOW,
        memo: new Map(),
    };
}

describe('Home decision set', () => {
    it('previews at most 5 rows while the total stays exact (S17)', () => {
        const items = Array.from({ length: 5 }, (_, index) => decision({ id: `item-${index}` }));
        const result = toHomeDecisions(page([...items, decision({ id: 'extra' })], 14), 4, NOW);

        expect(result.rows).toHaveLength(5);
        expect(result.total).toBe(14);
        expect(result.overdueCount).toBe(4);
    });

    it('keeps the My Decisions order it was given', () => {
        const result = toHomeDecisions(
            page([decision({ id: 'blocking-first' }), decision({ id: 'then-oldest' })]),
            0,
            NOW,
        );
        expect(result.rows.map((row) => row.id)).toEqual(['blocking-first', 'then-oldest']);
    });

    it('never lists a notice as a decision', () => {
        const result = toHomeDecisions(
            page([
                decision({ id: 'notice', kind: 'notice' }),
                decision({ id: 'approval', kind: 'approval' }),
            ]),
            0,
            NOW,
        );
        expect(result.rows.map((row) => row.id)).toEqual(['approval']);
    });

    it('computes the waiting time from the build clock and carries the blocking flag', () => {
        const [row] = toHomeDecisions(
            page([
                decision({
                    createdAt: new Date(NOW.getTime() - 4 * 24 * HOUR).toISOString(),
                    decision: { ...decision().decision, blocking: true, agentName: 'Writer' },
                }),
            ]),
            1,
            NOW,
        ).rows;
        expect(row.waitingMs).toBe(4 * 24 * HOUR);
        expect(row.blocking).toBe(true);
        expect(row.agentName).toBe('Writer');
    });

    it('cuts titles to 120 characters on the server', () => {
        const [row] = toHomeDecisions(page([decision({ title: 'x'.repeat(300) })]), 0, NOW).rows;
        expect(row.title).toHaveLength(120);
        expect(row.title.endsWith('…')).toBe(true);
    });

    it.each([
        [0, false],
        [1, true],
        [3, true],
        [4, false],
    ])('offers inline choices only for 1-3 options (%i options)', (count, inline) => {
        const [row] = toHomeDecisions(
            page([decision({ options: count === 0 ? null : options(count) })]),
            0,
            NOW,
        ).rows;
        expect(row.options === null).toBe(!inline);
        if (inline) expect(row.options).toHaveLength(count);
    });

    it('never reports more overdue decisions than open ones', () => {
        expect(toHomeDecisions(page([], 2), 5, NOW).overdueCount).toBe(2);
    });

    describe('HomeDecisionsBuilder', () => {
        it('reads the queue once per build and counts decisions raised 72 hours ago or earlier', async () => {
            const inbox = {
                listDecisions: jest.fn().mockResolvedValue(page([decision()], 3, 1)),
            };
            const inboxItems = {
                listDecisionsForUser: jest
                    .fn()
                    .mockResolvedValue({ rows: [], total: 2, hasMore: false }),
            };
            const builder = new HomeDecisionsBuilder(inbox as never, inboxItems as never);
            const ctx = context();

            const [result, openCount] = await Promise.all([
                builder.build(ctx),
                builder.openCount(ctx),
            ]);

            expect(inbox.listDecisions).toHaveBeenCalledTimes(1);
            expect(inbox.listDecisions).toHaveBeenCalledWith('user-1', { limit: 5 });
            expect(inboxItems.listDecisionsForUser).toHaveBeenCalledWith('user-1', {
                createdAtOrBefore: new Date(NOW.getTime() - 72 * HOUR),
                limit: 1,
            });
            expect(result).toMatchObject({ total: 3, overdueCount: 2, blockingCount: 1 });
            expect(openCount).toBe(3);
        });

        it('reports its source as unavailable when the Inbox is not wired', async () => {
            const builder = new HomeDecisionsBuilder();
            await expect(builder.build(context())).rejects.toMatchObject({
                name: 'HomeSourceUnavailableError',
            });
        });
    });
});
