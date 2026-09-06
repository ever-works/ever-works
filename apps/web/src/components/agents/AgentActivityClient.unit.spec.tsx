import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentActivityClient } from './AgentActivityClient';

const listAgentRunsAction = vi.fn();
const listAgentEventsAction = vi.fn();
const getAgentRunDetailAction = vi.fn();
const cancelAgentRunAction = vi.fn();

vi.mock('@/app/actions/agents', () => ({
    listAgentRunsAction: (...args: unknown[]) => listAgentRunsAction(...args),
    listAgentEventsAction: (...args: unknown[]) => listAgentEventsAction(...args),
    getAgentRunDetailAction: (...args: unknown[]) => getAgentRunDetailAction(...args),
    cancelAgentRunAction: (...args: unknown[]) => cancelAgentRunAction(...args),
}));

const AGENT_ID = 'agent-1';
const PAGE_SIZE = 25;

/** Runs are newest-first, one minute apart — run-0 is the most recent. */
function makeRun(index: number) {
    const createdAt = new Date(Date.UTC(2026, 0, 1, 12, 0) - index * 60_000).toISOString();
    return {
        id: `run-${index}`,
        status: 'failed',
        triggerKind: 'task',
        startedAt: createdAt,
        finishedAt: createdAt,
        durationMs: 1200,
        summary: `summary for run ${index}`,
        errorMessage: null,
        taskId: 'task-1',
        createdAt,
    };
}

function makeDetail(index: number) {
    return { ...makeRun(index), chatMessageId: null, memorySessionId: null, logs: [] };
}

/** `total` runs exist; the server-rendered page holds the newest 25. */
function renderFeed(total: number, focusRunId: string | null) {
    const all = Array.from({ length: total }, (_, i) => makeRun(i));
    return render(
        <AgentActivityClient
            agentId={AGENT_ID}
            initial={{
                data: all.slice(0, PAGE_SIZE),
                meta: { total, limit: PAGE_SIZE, offset: 0 },
            }}
            initialEvents={[]}
            focusRunId={focusRunId}
        />,
    );
}

const runRow = (id: string) => document.getElementById(`run-${id}`);

beforeEach(() => {
    vi.clearAllMocks();
    // jsdom implements neither; both are called on deep-link arrival.
    Element.prototype.scrollIntoView = vi.fn();
});

describe('AgentActivityClient deep links', () => {
    it('opens and scrolls to a run that is on the first page', async () => {
        getAgentRunDetailAction.mockResolvedValue(makeDetail(3));

        renderFeed(30, 'run-3');

        await waitFor(() => {
            expect(getAgentRunDetailAction).toHaveBeenCalledWith(AGENT_ID, 'run-3');
        });
        expect(runRow('run-3')).toHaveAttribute('aria-expanded', 'true');
        await waitFor(() => {
            expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
        });
    });

    // The regression this suite exists for: the "View logs" link carries
    // only a run id, and a busy Agent pushes yesterday's failure past the
    // 25 rows the page server-renders.
    it('pins a run that is older than the first page of 25', async () => {
        getAgentRunDetailAction.mockResolvedValue(makeDetail(40));

        renderFeed(60, 'run-40');

        // Not in the server-rendered page…
        expect(screen.queryAllByText('summary for run 40')).toHaveLength(0);

        // …so it is fetched by id and folded into the feed. The summary
        // shows up twice: the row itself, and its expanded detail panel.
        await waitFor(() => {
            expect(screen.getAllByText('summary for run 40').length).toBeGreaterThan(0);
        });
        expect(getAgentRunDetailAction).toHaveBeenCalledWith(AGENT_ID, 'run-40');
        expect(runRow('run-40')).toHaveAttribute('aria-expanded', 'true');
        await waitFor(() => {
            expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
        });
    });

    it('sorts a pinned older run below the rows it predates', async () => {
        getAgentRunDetailAction.mockResolvedValue(makeDetail(40));

        renderFeed(60, 'run-40');

        await waitFor(() => expect(runRow('run-40')).toBeInTheDocument());
        const ids = Array.from(document.querySelectorAll('tr[id^="run-"]')).map((el) => el.id);
        expect(ids[0]).toBe('run-run-0');
        expect(ids[ids.length - 1]).toBe('run-run-40');
    });

    it('renders the feed normally when the linked run cannot be resolved', async () => {
        // Another Agent's run, or one that has since been purged: the
        // Agent-scoped detail endpoint rejects it.
        getAgentRunDetailAction.mockRejectedValue(new Error('404'));

        renderFeed(30, 'run-99');

        await waitFor(() => {
            expect(getAgentRunDetailAction).toHaveBeenCalledWith(AGENT_ID, 'run-99');
        });
        expect(runRow('run-99')).toBeNull();
        expect(screen.getByText('summary for run 0')).toBeInTheDocument();
        expect(document.querySelectorAll('tr[id^="run-"]')).toHaveLength(PAGE_SIZE);
    });

    it('leaves the feed untouched without a ?run= link', async () => {
        renderFeed(30, null);

        expect(getAgentRunDetailAction).not.toHaveBeenCalled();
        expect(document.querySelectorAll('tr[id^="run-"]')).toHaveLength(PAGE_SIZE);
    });

    // The pin belongs to the arrival, not to every page browsed after it.
    // Paging away while the detail request is still in flight used to let
    // the late response re-pin the old run onto the new page.
    it('does not pin the deep-linked run when the caller pages away before its detail resolves', async () => {
        // run-55 lives on page 3 of 60 runs, so neither the page it arrives
        // on (1) nor the page it is about to leave for (2) contains it.
        let resolveDetail!: (detail: unknown) => void;
        getAgentRunDetailAction.mockReturnValue(
            new Promise((resolve) => {
                resolveDetail = resolve;
            }),
        );
        listAgentRunsAction.mockResolvedValue({
            data: Array.from({ length: PAGE_SIZE }, (_, i) => makeRun(PAGE_SIZE + i)),
            meta: { total: 60, limit: PAGE_SIZE, offset: PAGE_SIZE },
        });
        listAgentEventsAction.mockResolvedValue({ data: [] });

        renderFeed(60, 'run-55');

        await waitFor(() => {
            expect(getAgentRunDetailAction).toHaveBeenCalledWith(AGENT_ID, 'run-55');
        });
        // Still in flight, so nothing is pinned yet.
        expect(runRow('run-55')).toBeNull();

        // Queried by text, not by role: `getByRole` resolves the accessibility
        // tree for every node, and a 25-row feed is ~780 of them, to find the
        // two pagination buttons. Measured in this suite: 959 ms for the role
        // query against 53 ms for the text query, which made this the only
        // test here to outgrow the 30 s limit on a runner shared with the 33
        // e2e shards (CI 2026-09-03, PR #2297: "Test timed out in 30000ms").
        // The tag and enabled assertions below keep what the role query
        // implied — an operable pagination button — without that cost.
        const next = screen.getByText('Next');
        expect(next).toBeInstanceOf(HTMLButtonElement);
        expect(next).toBeEnabled();
        await userEvent.click(next);
        await waitFor(() => {
            expect(screen.getByText('summary for run 25')).toBeInTheDocument();
        });

        // The request the caller left behind now lands.
        await act(async () => {
            resolveDetail(makeDetail(55));
        });

        expect(runRow('run-55')).toBeNull();
        expect(screen.queryAllByText('summary for run 55')).toHaveLength(0);
        // The page the caller actually asked for is intact.
        expect(document.querySelectorAll('tr[id^="run-"]')).toHaveLength(PAGE_SIZE);
    });
});
