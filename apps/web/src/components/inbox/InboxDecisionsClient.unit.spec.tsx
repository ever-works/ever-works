import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
    InboxDecision,
    InboxDecisionContext,
    InboxDecisionCounts,
    InboxDecisionFilters,
} from '@/lib/api/inbox.shared';

/**
 * My Decisions — the Inbox's decision view. What is pinned here:
 *
 *   - the queue keeps the API's ranking and says, in words, what is
 *     blocking and what was never scored;
 *   - the header counts are absent until known — never a `0` that reads as
 *     "nothing needs you" — and a failed read is an error, never an empty
 *     queue;
 *   - an empty open queue picks the honest empty state (never had one /
 *     quiet for two weeks / filtered);
 *   - the position walker and `j` / `k` walk the queue; whichever decision
 *     is on screen (first row, deep link, walked to) records that it was
 *     seen;
 *   - "Load more" follows the server's cursor, never a row count, and
 *     drops a page that no longer continues the list on screen;
 *   - answering says what happened to the work and announces it politely.
 */

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const actions = vi.hoisted(() => ({
    reply: vi.fn(),
    counts: vi.fn(),
    list: vi.fn(),
    setRead: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => {
        const translate = (key: string, values?: Record<string, unknown>) =>
            values ? `${ns}.${key} ${JSON.stringify(values)}` : `${ns}.${key}`;
        translate.has = () => false;
        return translate;
    },
}));
vi.mock('sonner', () => ({ toast: toasts }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    useRouter: () => nav,
}));
vi.mock('@/components/ui/show-datetime', () => ({
    ShowDateTime: ({ value }: { value?: string | null }) => <span>{value}</span>,
}));
vi.mock('@/app/actions/dashboard/inbox', () => ({
    replyToInboxItemAction: actions.reply,
    getInboxDecisionCountsAction: actions.counts,
    listInboxDecisionsAction: actions.list,
    setInboxItemReadAction: actions.setRead,
}));

import { InboxDecisionsClient } from './InboxDecisionsClient';

function context(overrides: Partial<InboxDecisionContext> = {}): InboxDecisionContext {
    return {
        blocking: false,
        blockingReason: null,
        confidence: null,
        confidenceSource: null,
        reasonCode: null,
        attempted: [],
        actionType: null,
        riskFlags: [],
        agentName: 'Researcher',
        taskId: null,
        taskTitle: null,
        taskStatus: null,
        missionId: null,
        runStatus: null,
        dormant: false,
        ...overrides,
    };
}

function decision(
    id: string,
    overrides: Partial<InboxDecision> = {},
    ctx: Partial<InboxDecisionContext> = {},
): InboxDecision {
    return {
        id,
        kind: 'escalation',
        title: `Decision ${id}`,
        body: `What happened in ${id}`,
        options: null,
        sourceType: 'escalation',
        agentId: 'agent-1',
        agentRunId: 'run-1',
        taskId: null,
        workId: null,
        escalationId: `esc-${id}`,
        proposalId: null,
        status: 'open',
        unread: false,
        answeredAt: null,
        answerText: null,
        answerOptionId: null,
        createdAt: '2026-09-03T10:00:00.000Z',
        updatedAt: '2026-09-03T10:00:00.000Z',
        ...overrides,
        decision: context(ctx),
    };
}

const OPEN: InboxDecisionFilters = { tab: 'open' };

function renderClient(
    props: Partial<{
        decisions: InboxDecision[];
        total: number;
        counts: InboxDecisionCounts | null;
        nextCursor: string | null;
        filters: InboxDecisionFilters;
        selectedId: string;
        loadError: string | null;
    }> = {},
) {
    const view = render(clientElement(props));
    return {
        ...view,
        rerenderClient: (next: Parameters<typeof clientElement>[0]) =>
            view.rerender(clientElement(next)),
    };
}

function clientElement(
    props: Partial<{
        decisions: InboxDecision[];
        total: number;
        counts: InboxDecisionCounts | null;
        nextCursor: string | null;
        filters: InboxDecisionFilters;
        selectedId: string;
        loadError: string | null;
    }> = {},
) {
    const decisions = props.decisions ?? [];
    return (
        <InboxDecisionsClient
            decisions={decisions}
            total={props.total ?? decisions.length}
            counts={props.counts === undefined ? null : props.counts}
            {...('nextCursor' in props ? { nextCursor: props.nextCursor } : {})}
            filters={props.filters ?? OPEN}
            selectedId={props.selectedId}
            loadError={props.loadError ?? null}
        />
    );
}

function listPage(data: InboxDecision[], meta: { total: number; nextCursor?: string | null }) {
    return {
        data,
        meta: {
            limit: 25,
            offset: 0,
            openCount: meta.total,
            blockingCount: 0,
            lastRaisedAt: null,
            ...meta,
        },
    };
}

beforeEach(() => {
    nav.push.mockReset();
    nav.refresh.mockReset();
    actions.reply.mockReset();
    actions.counts.mockReset().mockResolvedValue(null);
    actions.list.mockReset();
    actions.setRead.mockReset().mockResolvedValue(undefined);
    toasts.success.mockReset();
    toasts.error.mockReset();
    window.sessionStorage.clear();
});

describe('InboxDecisionsClient — the queue', () => {
    it('keeps the ranked order and labels blocking, scored and unscored decisions', () => {
        renderClient({
            decisions: [
                decision('a', {}, { blocking: true, blockingReason: 'run-parked' }),
                decision('b', {}, { confidence: 0.82, confidenceSource: 'heuristic' }),
                decision('c', { kind: 'approval' }),
            ],
            counts: { open: 3, blocking: 1, lastRaisedAt: '2026-09-03T10:00:00.000Z' },
        });

        const rows = screen.getAllByTestId('decision-row');
        expect(rows.map((row) => row.textContent)).toEqual([
            expect.stringContaining('Decision a'),
            expect.stringContaining('Decision b'),
            expect.stringContaining('Decision c'),
        ]);
        expect(rows[0].getAttribute('data-blocking')).toBe('true');
        expect(rows[0].textContent).toContain('dashboard.inbox.decisions.card.blocking');
        expect(rows[1].textContent).toContain('card.confidence {"percent":82}');
        expect(rows[2].textContent).toContain('dashboard.inbox.decisions.card.notScored');

        expect(screen.getByTestId('decisions-open-count').textContent).toContain('{"count":3}');
        expect(screen.getByTestId('decisions-blocking-count').textContent).toContain('{"count":1}');
        // The first decision is already open, so it can be answered without a click.
        expect(screen.getByTestId('decision-detail').textContent).toContain('Decision a');
        expect(screen.getByTestId('decision-position').textContent).toContain(
            '{"index":1,"total":3}',
        );
        expect(screen.getByTestId('decision-blocking').textContent).toContain(
            'card.blockingRunParked',
        );
    });

    it('shows no counts at all while they are unknown — never a 0', () => {
        renderClient({ decisions: [decision('a')], counts: null });
        expect(screen.queryByTestId('decisions-counts')).toBeNull();
    });

    it('renders a failed read as an error with the last known count, never as an empty queue', () => {
        window.sessionStorage.setItem('ever-works:inbox-decisions:last-known-open', '4');
        renderClient({ loadError: 'API down' });

        expect(screen.getByTestId('decisions-error')).toBeTruthy();
        expect(screen.getByTestId('decisions-last-known').textContent).toContain('{"count":4}');
        expect(screen.queryByTestId('decisions-list')).toBeNull();
        expect(screen.queryByTestId('decisions-empty-first-run')).toBeNull();
        expect(screen.queryByTestId('decisions-empty-clear')).toBeNull();

        fireEvent.click(screen.getByTestId('decisions-retry'));
        expect(nav.refresh).toHaveBeenCalledTimes(1);
    });

    it('explains decisions to a workspace that never had one', () => {
        renderClient({ counts: { open: 0, blocking: 0, lastRaisedAt: null } });
        expect(screen.getByTestId('decisions-empty-first-run').textContent).toContain(
            'empty.firstRunTitle',
        );
    });

    it('does not celebrate an empty queue that has been quiet for two weeks', () => {
        renderClient({
            counts: { open: 0, blocking: 0, lastRaisedAt: '2020-01-01T00:00:00.000Z' },
        });
        const quiet = screen.getByTestId('decisions-empty-quiet');
        expect(quiet.textContent).toContain('empty.quietBody');
        expect(quiet.textContent).toContain('empty.quietFootnote');
    });

    it('says a filtered queue matched nothing, and offers to clear the filters', () => {
        renderClient({
            counts: { open: 5, blocking: 0, lastRaisedAt: '2026-09-03T10:00:00.000Z' },
            filters: { tab: 'open', kind: 'approval' },
        });
        expect(screen.getByTestId('decisions-empty-filtered')).toBeTruthy();
        expect(screen.getByTestId('decisions-clear-filters').getAttribute('href')).toBe(
            '/inbox?view=decisions',
        );
    });

    it('puts a filter change in the URL', () => {
        renderClient({ decisions: [decision('a')], filters: { tab: 'answered' } });
        fireEvent.change(screen.getByTestId('decisions-filter-kind'), {
            target: { value: 'approval' },
        });
        expect(nav.push).toHaveBeenCalledWith('/inbox?view=decisions&tab=answered&kind=approval');
    });

    it('loads the next page on request and never auto-loads it', async () => {
        actions.list.mockResolvedValue({
            data: [decision('b')],
            meta: {
                total: 2,
                limit: 25,
                offset: 1,
                openCount: 2,
                blockingCount: 0,
                lastRaisedAt: null,
            },
        });
        renderClient({ decisions: [decision('a')], total: 2 });
        expect(actions.list).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId('decisions-load-more'));

        await waitFor(() => expect(screen.getAllByTestId('decision-row')).toHaveLength(2));
        expect(actions.list).toHaveBeenCalledWith({ tab: 'open', limit: 25, offset: 1 });
        expect(screen.queryByTestId('decisions-load-more')).toBeNull();
    });

    it('pages by cursor, so a decision answered elsewhere never drops the next one out of reach', async () => {
        // A and B are on screen out of five; B is then answered elsewhere, so
        // the live total is four when "Load more" is pressed.
        actions.list
            .mockResolvedValueOnce(
                listPage([decision('c'), decision('d')], { total: 4, nextCursor: 'after-d' }),
            )
            .mockResolvedValueOnce(listPage([decision('e')], { total: 4, nextCursor: null }));
        renderClient({
            decisions: [decision('a'), decision('b')],
            total: 5,
            nextCursor: 'after-b',
        });

        fireEvent.click(screen.getByTestId('decisions-load-more'));
        await waitFor(() => expect(screen.getAllByTestId('decision-row')).toHaveLength(4));
        expect(actions.list).toHaveBeenLastCalledWith({
            tab: 'open',
            limit: 25,
            cursor: 'after-b',
        });

        // Four rows held against a total of four, yet E is still waiting:
        // the server's cursor, not the count, decides whether more follows.
        fireEvent.click(screen.getByTestId('decisions-load-more'));
        await waitFor(() => expect(screen.getAllByTestId('decision-row')).toHaveLength(5));
        expect(actions.list).toHaveBeenLastCalledWith({
            tab: 'open',
            limit: 25,
            cursor: 'after-d',
        });
        expect(screen.queryByTestId('decisions-load-more')).toBeNull();
    });

    it('offers no "Load more" once the server says nothing follows, whatever the count says', () => {
        renderClient({ decisions: [decision('a')], total: 3, nextCursor: null });
        expect(screen.queryByTestId('decisions-load-more')).toBeNull();
    });

    it('drops a page that arrives after the list was re-read, and continues from the fresh list', async () => {
        let resolvePage: (value: unknown) => void = () => undefined;
        actions.list.mockReturnValueOnce(
            new Promise((resolve) => {
                resolvePage = resolve;
            }),
        );
        const { rerenderClient } = renderClient({
            decisions: [decision('a')],
            total: 3,
            nextCursor: 'after-a',
        });

        fireEvent.click(screen.getByTestId('decisions-load-more'));
        // An answer re-reads the first page from the server meanwhile.
        rerenderClient({
            decisions: [decision('x'), decision('a')],
            total: 3,
            nextCursor: 'after-a-fresh',
        });
        await act(async () => {
            resolvePage(listPage([decision('b'), decision('c')], { total: 3, nextCursor: null }));
        });

        expect(screen.getAllByTestId('decision-row').map((row) => row.textContent)).toEqual([
            expect.stringContaining('Decision x'),
            expect.stringContaining('Decision a'),
        ]);

        actions.list.mockResolvedValueOnce(
            listPage([decision('b')], { total: 3, nextCursor: null }),
        );
        await waitFor(() =>
            expect((screen.getByTestId('decisions-load-more') as HTMLButtonElement).disabled).toBe(
                false,
            ),
        );
        fireEvent.click(screen.getByTestId('decisions-load-more'));
        await waitFor(() => expect(screen.getAllByTestId('decision-row')).toHaveLength(3));
        expect(actions.list).toHaveBeenLastCalledWith({
            tab: 'open',
            limit: 25,
            cursor: 'after-a-fresh',
        });
    });
});

describe('InboxDecisionsClient — walking and answering', () => {
    it('walks the queue with the position walker and j / k, recording the first view', () => {
        renderClient({
            decisions: [decision('a'), decision('b', { unread: true }), decision('c')],
        });

        fireEvent.click(screen.getByTestId('decision-next'));
        expect(screen.getByTestId('decision-detail').textContent).toContain('Decision b');
        expect(actions.setRead).toHaveBeenCalledWith('b', false);

        fireEvent.keyDown(window, { key: 'j' });
        expect(screen.getByTestId('decision-position').textContent).toContain('{"index":3');

        fireEvent.keyDown(window, { key: 'k' });
        expect(screen.getByTestId('decision-detail').textContent).toContain('Decision b');
    });

    it('selects the deep-linked decision', () => {
        renderClient({ decisions: [decision('a'), decision('b')], selectedId: 'b' });
        expect(screen.getByTestId('decision-detail').textContent).toContain('Decision b');
    });

    it('records the first view of the decision on screen without a click: first row or deep link', () => {
        const unreadPair = () => [decision('a', { unread: true }), decision('b', { unread: true })];
        const first = renderClient({ decisions: unreadPair() });

        expect(actions.setRead).toHaveBeenCalledTimes(1);
        expect(actions.setRead).toHaveBeenCalledWith('a', false);
        const [rowA, rowB] = screen.getAllByTestId('decision-row');
        expect(rowA.querySelector('[aria-label="dashboard.inbox.unreadDot"]')).toBeNull();
        expect(rowB.querySelector('[aria-label="dashboard.inbox.unreadDot"]')).not.toBeNull();
        first.unmount();

        actions.setRead.mockClear();
        renderClient({ decisions: unreadPair(), selectedId: 'b' });
        expect(actions.setRead).toHaveBeenCalledTimes(1);
        expect(actions.setRead).toHaveBeenCalledWith('b', false);
    });

    it('sends the read flip once while a decision stays on screen, and again when it comes back', () => {
        const { rerenderClient } = renderClient({
            decisions: [decision('a', { unread: true }), decision('b')],
        });
        expect(actions.setRead).toHaveBeenCalledTimes(1);

        // A re-read that still carries the old unread flag changes nothing.
        rerenderClient({ decisions: [decision('a', { unread: true }), decision('b')] });
        expect(actions.setRead).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByTestId('decision-next'));
        expect(actions.setRead).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByTestId('decision-previous'));
        expect(actions.setRead).toHaveBeenCalledTimes(2);
        expect(actions.setRead).toHaveBeenLastCalledWith('a', false);
    });

    it('says the work picked back up, announces it, and keeps the answered decision in view', async () => {
        const open = decision(
            'a',
            {
                kind: 'question',
                sourceType: 'agent-run',
                escalationId: null,
                options: [
                    { id: 'pro', label: 'Pro', recommended: true },
                    { id: 'standard', label: 'Standard' },
                ],
            },
            { blocking: true, blockingReason: 'run-parked', agentName: 'Researcher' },
        );
        actions.reply.mockResolvedValue({
            item: { ...open, status: 'answered', answerOptionId: 'pro' },
            routed: 'resumed',
            runId: 'run-2',
            restart: 'resumed',
        });
        renderClient({ decisions: [open] });

        expect(screen.getByTestId('decision-pending-line').textContent).toContain(
            'detail.pendingOne',
        );
        const pro = screen.getByText('Pro').closest('label')?.querySelector('input');
        fireEvent.click(pro as HTMLInputElement);
        await act(async () => {
            fireEvent.click(screen.getByTestId('inbox-send-reply'));
        });

        await waitFor(() =>
            expect(screen.getByTestId('decision-outcome').getAttribute('data-outcome')).toBe(
                'resumed',
            ),
        );
        expect(actions.reply).toHaveBeenCalledWith('a', { optionId: 'pro', requireReason: true });
        expect(screen.getByTestId('decisions-live-region').textContent).toContain(
            'resolution.resumed {"agent":"Researcher"}',
        );
        expect(screen.getByTestId('inbox-answer')).toBeTruthy();
        expect(nav.refresh).toHaveBeenCalled();
    });

    it('offers the Task as the manual restart when the automatic one failed', async () => {
        const open = decision('a', {}, { taskId: 'task-1', taskTitle: 'Refresh pricing' });
        actions.reply.mockResolvedValue({
            item: { ...open, status: 'answered', answerText: 'Go ahead' },
            routed: 'escalation-resolved',
            restart: 'failed',
        });
        renderClient({ decisions: [open] });

        fireEvent.change(screen.getByTestId('inbox-reply-textarea'), {
            target: { value: 'Go ahead' },
        });
        await act(async () => {
            fireEvent.click(screen.getByTestId('inbox-send-reply'));
        });

        await waitFor(() => expect(screen.getByTestId('decision-run-now')).toBeTruthy());
        expect(screen.getByTestId('decision-run-now').getAttribute('href')).toBe('/tasks/task-1');
        expect(toasts.error).toHaveBeenCalled();
    });
});
