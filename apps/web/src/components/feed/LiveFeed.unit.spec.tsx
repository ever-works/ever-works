import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { FeedActorSummaryDto, FeedEntryDto, FeedPageDto } from '@ever-works/contracts';

import messages from '../../../messages/en.json';

const getFeedPage = vi.fn();
const getFeedActors = vi.fn();
const push = vi.fn();
let searchParams = new URLSearchParams('view=feed');

vi.mock('@/app/actions/feed', () => ({
    getFeedPage: (...args: unknown[]) => getFeedPage(...args),
    getFeedActors: (...args: unknown[]) => getFeedActors(...args),
}));
vi.mock('next/navigation', () => ({
    useSearchParams: () => searchParams,
}));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push }),
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));
vi.mock('@/components/ui/dialog', () => ({
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
        open ? <div role="dialog">{children}</div> : null,
    DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { LiveFeed } from './LiveFeed';
import { FEED_FILTER_STORAGE_KEY } from './feed-filters';

const RUN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const entry = (id: string, extra: Partial<FeedEntryDto> = {}): FeedEntryDto => ({
    id,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    kind: 'work',
    status: 'completed',
    actionType: 'agent_run_completed',
    actor: { kind: 'agent', agentId: 'a', label: 'Ivy' },
    narration: { key: 'agentRunCompleted', params: { actor: 'Ivy' } },
    target: { type: 'run', id: RUN },
    ...extra,
});

const page = (items: FeedEntryDto[]): FeedPageDto => ({
    items,
    nextCursor: null,
    hasMore: false,
    historyFloor: '2026-06-15T00:00:00.000Z',
});

const actor = (i: number): FeedActorSummaryDto => ({
    agentId: `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`,
    label: `Agent ${i}`,
    status: 'active',
    count: 30 - i,
    lastActivityAt: null,
});

function renderFeed(props: Partial<Parameters<typeof LiveFeed>[0]> = {}) {
    const onOpenActivityLog = vi.fn();
    const onFiltersChange = vi.fn();
    const utils = render(
        <NextIntlClientProvider
            locale="en"
            messages={messages}
            timeZone="UTC"
            onError={() => undefined}
        >
            <LiveFeed
                onOpenActivityLog={onOpenActivityLog}
                onFiltersChange={onFiltersChange}
                // A transport that never fires keeps timers out of these specs.
                transport={() => () => undefined}
                {...props}
            />
        </NextIntlClientProvider>,
    );
    return { ...utils, onOpenActivityLog, onFiltersChange };
}

describe('LiveFeed', () => {
    beforeEach(() => {
        searchParams = new URLSearchParams('view=feed');
        getFeedPage.mockReset();
        getFeedActors
            .mockReset()
            .mockResolvedValue({ success: true, data: { actors: [], windowHours: 168 } });
        push.mockReset();
        window.localStorage.clear();
    });
    afterEach(() => {
        window.localStorage.clear();
    });

    it('shows the never-anything empty state with both calls to action', async () => {
        getFeedPage.mockResolvedValue({ success: true, data: page([]) });
        renderFeed();

        expect(await screen.findByTestId('feed-empty')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Create an agent' })).toHaveAttribute(
            'href',
            '/agents/new',
        );
        expect(screen.getByRole('link', { name: 'Start a mission' })).toHaveAttribute(
            'href',
            '/missions/new',
        );
    });

    it('shows the load-error state with no partial list, retry and a way to the Activity log', async () => {
        getFeedPage
            .mockResolvedValueOnce({ success: false, error: 'load-failed' })
            .mockResolvedValueOnce({ success: true, data: page([entry('e1')]) });
        const { onOpenActivityLog } = renderFeed();

        expect(await screen.findByTestId('feed-error')).toBeInTheDocument();
        expect(screen.queryByTestId('feed-list')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Open the Activity log' }));
        expect(onOpenActivityLog).toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByTestId('feed-list')).toBeInTheDocument();
    });

    it('reads filters from the URL and reports changes for the page URL', async () => {
        searchParams = new URLSearchParams('view=feed&kinds=problem');
        getFeedPage.mockResolvedValue({ success: true, data: page([]) });
        const { onFiltersChange } = renderFeed();

        await screen.findByTestId('feed-empty-filtered');
        expect(getFeedPage).toHaveBeenCalledWith(
            expect.objectContaining({ kinds: ['problem'], cursor: null }),
        );
        expect(onFiltersChange).toHaveBeenLastCalledWith('kinds=problem');

        fireEvent.click(
            within(screen.getByTestId('feed-empty-filtered')).getByRole('button', {
                name: 'Clear filters',
            }),
        );
        await waitFor(() => expect(onFiltersChange).toHaveBeenLastCalledWith(''));
    });

    it('restores the last filters when the URL carries none, fetching only once', async () => {
        window.localStorage.setItem(
            FEED_FILTER_STORAGE_KEY,
            JSON.stringify({ agentIds: [], kinds: ['decision'], failedOnly: false }),
        );
        getFeedPage.mockResolvedValue({ success: true, data: page([]) });
        renderFeed();

        await screen.findByTestId('feed-empty-filtered');
        expect(getFeedPage).toHaveBeenCalledTimes(1);
        expect(getFeedPage).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['decision'] }));
    });

    it('toggles kinds with 1-5 and "only failed" with x from the keyboard', async () => {
        getFeedPage.mockResolvedValue({ success: true, data: page([entry('e1'), entry('e2')]) });
        renderFeed();
        await screen.findByTestId('feed-list');

        act(() => {
            fireEvent.keyDown(window, { key: '4' });
        });
        await waitFor(() =>
            expect(getFeedPage).toHaveBeenLastCalledWith(
                expect.objectContaining({ kinds: ['problem'] }),
            ),
        );

        act(() => {
            fireEvent.keyDown(window, { key: 'x' });
        });
        await waitFor(() =>
            expect(getFeedPage).toHaveBeenLastCalledWith(
                expect.objectContaining({ failedOnly: true }),
            ),
        );
        expect(await screen.findByTestId('feed-failed-count')).toHaveTextContent(
            '2 failures loaded',
        );
    });

    it('reports no kind chip as pressed while "Only failed" overrides the kinds', async () => {
        searchParams = new URLSearchParams('view=feed&kinds=problem&failed=1');
        getFeedPage.mockResolvedValue({ success: true, data: page([entry('e1')]) });
        renderFeed();
        await screen.findByTestId('feed-list');

        const problemChip = () =>
            screen
                .getAllByTestId('feed-kind-chip')
                .find((chip) => chip.getAttribute('data-kind') === 'problem')!;
        expect(problemChip()).toBeDisabled();
        expect(problemChip()).toHaveAttribute('aria-pressed', 'false');

        // Turning it off brings the stored kind selection back into effect.
        fireEvent.click(screen.getByTestId('feed-only-failed'));
        await waitFor(() => expect(problemChip()).toHaveAttribute('aria-pressed', 'true'));
        expect(problemChip()).not.toBeDisabled();
    });

    it('ignores shortcuts typed into a text field', async () => {
        getFeedPage.mockResolvedValue({ success: true, data: page([entry('e1')]) });
        renderFeed();
        await screen.findByTestId('feed-list');
        const calls = getFeedPage.mock.calls.length;

        const input = document.createElement('input');
        document.body.appendChild(input);
        fireEvent.keyDown(input, { key: '4' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(getFeedPage.mock.calls.length).toBe(calls);
        input.remove();
    });

    it('moves the selection with j/k and opens the selected entry with Enter or o', async () => {
        getFeedPage.mockResolvedValue({
            success: true,
            data: page([entry('e1'), entry('e2', { target: null })]),
        });
        renderFeed();
        await screen.findByTestId('feed-list');

        act(() => {
            fireEvent.keyDown(window, { key: 'j' });
        });
        const rows = screen.getAllByTestId('feed-entry');
        expect(rows[0]).toHaveAttribute('data-selected', 'true');

        act(() => {
            fireEvent.keyDown(document.body, { key: 'o' });
        });
        expect(push).toHaveBeenCalledWith(`/agents/activity/${RUN}`);

        act(() => {
            fireEvent.keyDown(window, { key: 'j' });
        });
        expect(screen.getAllByTestId('feed-entry')[1]).toHaveAttribute('data-selected', 'true');
        act(() => {
            fireEvent.keyDown(document.body, { key: 'Enter' });
        });
        // The second entry has no destination: nothing to open.
        expect(push).toHaveBeenCalledTimes(1);

        act(() => {
            fireEvent.keyDown(window, { key: 'Escape' });
        });
        expect(screen.getAllByTestId('feed-entry')[1]).not.toHaveAttribute('data-selected');
    });

    it('shows at most 12 agent chips and refuses a 21st selected agent with an inline message', async () => {
        const actors = Array.from({ length: 25 }, (_, i) => actor(i));
        const selected = actors.slice(0, 20).map((a) => a.agentId);
        searchParams = new URLSearchParams(`view=feed&agents=${selected.join(',')}`);
        getFeedPage.mockResolvedValue({ success: true, data: page([entry('e1')]) });
        renderFeed({ initialActors: actors });
        await screen.findByTestId('feed-list');

        // 12 top chips + the 8 selected agents outside them.
        expect(screen.getAllByTestId('feed-agent-chip')).toHaveLength(20);
        expect(screen.getByTestId('feed-agent-more')).toHaveTextContent('+13 more');

        fireEvent.click(screen.getByTestId('feed-agent-more'));
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('20 of 20 selected');
        fireEvent.click(screen.getByRole('checkbox', { name: /Agent 24/ }));
        expect(screen.getByRole('alert')).toHaveTextContent(
            'You can watch up to 20 agents at once.',
        );
        expect(getFeedPage).toHaveBeenCalledTimes(1);
    });

    it('renders a server-provided first page without fetching it again', async () => {
        getFeedPage.mockResolvedValue({ success: true, data: page([]) });
        searchParams = new URLSearchParams('view=feed&failed=1');
        renderFeed({ initialPage: page([entry('ssr')]) });

        expect(screen.getByTestId('feed-list')).toBeInTheDocument();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(getFeedPage).not.toHaveBeenCalled();
    });
});
