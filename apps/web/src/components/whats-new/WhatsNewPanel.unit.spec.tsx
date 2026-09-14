import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import type { ChangelogEntryDto, ChangelogListResponseDto } from '@ever-works/contracts/api';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${JSON.stringify(values)}` : key,
    useLocale: () => 'en',
}));

// The panel navigates through the workspace-aware router; only next-intl's
// primitives underneath it are replaced, so Organization scoping runs for real.
const navigation = vi.hoisted(() => ({ pathname: '/dashboard', push: vi.fn() }));
const push = navigation.push;
vi.mock('next-intl/navigation', () => ({
    createNavigation: () => ({
        Link: () => null,
        getPathname: vi.fn(),
        redirect: vi.fn(),
        usePathname: () => navigation.pathname,
        useRouter: () => ({
            back: vi.fn(),
            forward: vi.fn(),
            refresh: vi.fn(),
            // The wrapper always forwards an options slot; record it only when set.
            push: (href: unknown, options?: unknown) =>
                options === undefined ? navigation.push(href) : navigation.push(href, options),
            replace: vi.fn(),
            prefetch: vi.fn(),
        }),
    }),
}));
vi.mock('next-intl/routing', () => ({
    defineRouting: (value: unknown) => value,
}));

const getChangelog = vi.fn();
const markChangelogRead = vi.fn();
const markAllChangelogRead = vi.fn();
vi.mock('@/app/actions/changelog', () => ({
    getChangelog: (...args: unknown[]) => getChangelog(...args),
    markChangelogRead: (...args: unknown[]) => markChangelogRead(...args),
    markAllChangelogRead: (...args: unknown[]) => markAllChangelogRead(...args),
}));

import { WhatsNewPanel } from './WhatsNewPanel';
import { READ_BATCH_WINDOW_MS, READ_DWELL_MS } from './use-changelog-read-tracker';

/** Replace IntersectionObserver with one the test drives by hand; returns a restore function. */
function recordIntersections() {
    const original = window.IntersectionObserver;
    const observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = [];
    class RecordingObserver {
        targets: Element[] = [];
        constructor(readonly callback: IntersectionObserverCallback) {
            observers.push(this);
        }
        observe(target: Element) {
            this.targets.push(target);
        }
        unobserve() {}
        disconnect() {}
    }
    // @ts-expect-error — test double
    window.IntersectionObserver = RecordingObserver;
    return {
        showFully(target: Element) {
            const observer = observers.find((candidate) => candidate.targets.includes(target));
            if (!observer) throw new Error('card is not watched');
            observer.callback(
                [
                    {
                        target,
                        isIntersecting: true,
                        intersectionRatio: 1,
                    } as unknown as IntersectionObserverEntry,
                ],
                observer as unknown as IntersectionObserver,
            );
        },
        restore() {
            window.IntersectionObserver = original;
        },
    };
}

function entry(overrides: Partial<ChangelogEntryDto> = {}): ChangelogEntryDto {
    return {
        slug: 'stop-the-whole-fleet',
        title: 'Stop your whole fleet in one step',
        body: 'A single control drains every node.',
        category: 'connections',
        kind: 'new',
        publishedAt: '2026-09-05T09:00:00.000Z',
        pinned: false,
        cta: null,
        isRead: false,
        ...overrides,
    };
}

function page(overrides: Partial<ChangelogListResponseDto> = {}): ChangelogListResponseDto {
    return {
        entries: [entry()],
        nextCursor: null,
        total: 1,
        unreadCount: 1,
        categoriesWithEntries: ['connections'],
        ...overrides,
    };
}

/** The shell's side of the contract: an opener button, open state and the count. */
function Harness({ initialCount = 3 }: { initialCount?: number | null }) {
    const [open, setOpen] = useState(false);
    const [count, setCount] = useState<number | null>(initialCount);
    return (
        <>
            <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
                open
            </button>
            <output data-testid="count">{String(count)}</output>
            <WhatsNewPanel
                open={open}
                onClose={() => setOpen(false)}
                unreadCount={count}
                onUnreadCountChange={setCount}
            />
        </>
    );
}

async function openPanel() {
    const opener = screen.getByTestId('opener');
    opener.focus();
    fireEvent.click(opener);
    return screen.findByRole('dialog');
}

/**
 * What's new (AW-14) — the slide-over. Its failure modes are the ones a
 * reader would notice: a spinner that never ends, an empty state that lies
 * about why it is empty, an error with no way out, a badge that shows a
 * stale number, or focus lost after closing (spec S-10, S-12, S-13, FR-35,
 * FR-51).
 */
describe('WhatsNewPanel', () => {
    beforeEach(() => {
        navigation.pathname = '/dashboard';
        push.mockReset();
        getChangelog.mockReset();
        markChangelogRead.mockReset();
        markAllChangelogRead.mockReset();
        getChangelog.mockResolvedValue({ success: true, data: page() });
        markChangelogRead.mockResolvedValue({ success: true, unreadCount: 0 });
        markAllChangelogRead.mockResolvedValue({ success: true, unreadCount: 0 });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('FR-30: does not fetch or render anything until it is opened', () => {
        render(<Harness />);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(getChangelog).not.toHaveBeenCalled();
    });

    it('renders three skeleton cards, and no text, while the first page loads', async () => {
        getChangelog.mockReturnValue(new Promise(() => undefined));
        render(<Harness />);
        const dialog = await openPanel();

        expect(within(dialog).getAllByTestId('whats-new-skeleton')).toHaveLength(3);
        expect(within(dialog).queryByTestId('whats-new-list')).not.toBeInTheDocument();
        expect(getChangelog).toHaveBeenCalledWith({ category: undefined });
    });

    it('renders the loaded entries and adopts the unfiltered unread count from the response', async () => {
        getChangelog.mockResolvedValue({ success: true, data: page({ unreadCount: 1 }) });
        render(<Harness initialCount={null} />);
        const dialog = await openPanel();

        expect(await within(dialog).findByText('Stop your whole fleet in one step')).toBeVisible();
        expect(screen.getByTestId('count')).toHaveTextContent('1');
        expect(within(dialog).getByTestId('whats-new-subtitle')).toHaveTextContent(
            'subtitleUnreadOne',
        );
    });

    it('S-13: an empty catalogue renders the global empty state, not an error', async () => {
        getChangelog.mockResolvedValue({
            success: true,
            data: page({ entries: [], total: 0, unreadCount: 0, categoriesWithEntries: [] }),
        });
        render(<Harness initialCount={0} />);
        const dialog = await openPanel();

        const empty = await within(dialog).findByTestId('whats-new-empty');
        expect(empty).toHaveTextContent('empty.title');
        expect(empty).toHaveTextContent('empty.description');
        expect(within(dialog).queryByTestId('whats-new-error')).not.toBeInTheDocument();
    });

    it('S-12: a filter that matches nothing renders its own copy and "Show all" clears it', async () => {
        getChangelog.mockImplementation(async ({ category }: { category?: string }) => ({
            success: true,
            data: category
                ? page({ entries: [], categoriesWithEntries: ['connections', 'costs'] })
                : page({ categoriesWithEntries: ['connections', 'costs'] }),
        }));
        render(<Harness />);
        const dialog = await openPanel();
        await within(dialog).findByTestId('whats-new-list');

        fireEvent.click(within(dialog).getByTestId('whats-new-filter-costs'));

        const filtered = await within(dialog).findByTestId('whats-new-empty-filtered');
        expect(filtered).toHaveTextContent('emptyFiltered.title');
        expect(filtered).toHaveTextContent('filters.costs');
        expect(getChangelog).toHaveBeenLastCalledWith({ category: 'costs' });

        fireEvent.click(within(filtered).getByText('emptyFiltered.action'));
        await within(dialog).findByTestId('whats-new-list');
        expect(getChangelog).toHaveBeenLastCalledWith({ category: undefined });
    });

    it('FR-38: changing the filter never changes the badge count', async () => {
        getChangelog.mockImplementation(async ({ category }: { category?: string }) => ({
            success: true,
            data: category
                ? page({
                      entries: [],
                      unreadCount: 4,
                      categoriesWithEntries: ['connections', 'costs'],
                  })
                : page({ unreadCount: 4, categoriesWithEntries: ['connections', 'costs'] }),
        }));
        render(<Harness initialCount={4} />);
        const dialog = await openPanel();
        await within(dialog).findByTestId('whats-new-list');

        fireEvent.click(within(dialog).getByTestId('whats-new-filter-costs'));
        await within(dialog).findByTestId('whats-new-empty-filtered');

        expect(screen.getByTestId('count')).toHaveTextContent('4');
    });

    it('FR-37: a category with no entries is disabled, not hidden', async () => {
        render(<Harness />);
        const dialog = await openPanel();
        await within(dialog).findByTestId('whats-new-list');

        const knowledge = within(dialog).getByTestId('whats-new-filter-knowledge');
        expect(knowledge).toBeDisabled();
        expect(knowledge).toHaveAttribute('title', 'filters.emptyTooltip');
        expect(within(dialog).getByTestId('whats-new-filter-connections')).toBeEnabled();
    });

    it('S-10: a failed load shows the error state with a working retry and hides the badge', async () => {
        getChangelog
            .mockResolvedValueOnce({ success: false, error: 'boom' })
            .mockResolvedValueOnce({ success: true, data: page({ unreadCount: 1 }) });
        render(<Harness initialCount={3} />);
        const dialog = await openPanel();

        const error = await within(dialog).findByTestId('whats-new-error');
        expect(error).toHaveTextContent('error.title');
        expect(screen.getByTestId('count')).toHaveTextContent('null');

        fireEvent.click(within(error).getByText('error.retry'));

        expect(await within(dialog).findByTestId('whats-new-list')).toBeVisible();
        expect(getChangelog).toHaveBeenCalledTimes(2);
        expect(screen.getByTestId('count')).toHaveTextContent('1');
    });

    it('FR-46: a round trip that rejects outright still lands in the error state, never an endless skeleton', async () => {
        getChangelog.mockRejectedValue(new Error('Failed to fetch'));
        render(<Harness initialCount={2} />);
        const dialog = await openPanel();

        expect(await within(dialog).findByTestId('whats-new-error')).toBeVisible();
        expect(within(dialog).queryByTestId('whats-new-skeleton')).not.toBeInTheDocument();
    });

    it('FR-19: "Mark all as read" clears the count and every card, and confirms inline', async () => {
        getChangelog.mockResolvedValue({
            success: true,
            data: page({
                entries: [
                    entry(),
                    entry({ slug: 'approve-agent-merges-in-inbox', title: 'Approve' }),
                ],
                unreadCount: 2,
            }),
        });
        render(<Harness initialCount={2} />);
        const dialog = await openPanel();
        await within(dialog).findByTestId('whats-new-list');

        await act(async () => {
            fireEvent.click(within(dialog).getByTestId('whats-new-mark-all'));
        });

        expect(markAllChangelogRead).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('count')).toHaveTextContent('0');
        for (const card of within(dialog).getAllByTestId('whats-new-entry')) {
            expect(card).toHaveAttribute('data-read', 'true');
        }
        expect(within(dialog).getByRole('status')).toHaveTextContent('markedAllRead');
    });

    it('S-20: a refused "Mark all as read" changes nothing and offers a retry', async () => {
        markAllChangelogRead.mockResolvedValue({ success: false, error: 'Too Many Requests' });
        render(<Harness initialCount={1} />);
        const dialog = await openPanel();
        await within(dialog).findByTestId('whats-new-list');

        await act(async () => {
            fireEvent.click(within(dialog).getByTestId('whats-new-mark-all'));
        });

        expect(await within(dialog).findByTestId('whats-new-error')).toBeVisible();
        expect(screen.getByTestId('count')).toHaveTextContent('1');
    });

    it('FR-42: following a call-to-action closes the panel, navigates in-app and marks the entry read', async () => {
        getChangelog.mockResolvedValue({
            success: true,
            data: page({
                entries: [entry({ cta: { label: 'Open fleet', href: '/settings/fleet' } })],
            }),
        });
        render(<Harness />);
        const dialog = await openPanel();

        fireEvent.click(await within(dialog).findByTestId('whats-new-entry-cta'));

        expect(push).toHaveBeenCalledWith('/settings/fleet');
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(markChangelogRead).toHaveBeenCalledWith(['stop-the-whole-fleet']);
    });

    it('FR-42: a call-to-action followed inside an Organization stays in that Organization', async () => {
        navigation.pathname = '/org/acme/dashboard';
        getChangelog.mockResolvedValue({
            success: true,
            data: page({
                entries: [entry({ cta: { label: 'Open fleet', href: '/settings/fleet' } })],
            }),
        });
        render(<Harness />);
        const dialog = await openPanel();

        fireEvent.click(await within(dialog).findByTestId('whats-new-entry-cta'));

        expect(push).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenCalledWith('/org/acme/settings/fleet');
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(markChangelogRead).toHaveBeenCalledWith(['stop-the-whole-fleet']);
    });

    it('S-2: a read write still outstanding when "Mark all as read" succeeds cannot put a stale count back on the badge', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const observers = recordIntersections();
        try {
            getChangelog.mockResolvedValue({
                success: true,
                data: page({
                    entries: [
                        entry(),
                        entry({ slug: 'approve-agent-merges-in-inbox', title: 'Approve' }),
                    ],
                    unreadCount: 2,
                }),
            });
            let settleWrite: (result: { success: boolean; unreadCount?: number }) => void = () =>
                undefined;
            markChangelogRead.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        settleWrite = resolve;
                    }),
            );
            render(<Harness initialCount={2} />);
            const dialog = await openPanel();
            await within(dialog).findByTestId('whats-new-list');

            const [first] = within(dialog).getAllByTestId('whats-new-entry');
            act(() => observers.showFully(first));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(READ_DWELL_MS + READ_BATCH_WINDOW_MS);
            });
            expect(markChangelogRead).toHaveBeenCalledWith(['stop-the-whole-fleet']);

            await act(async () => {
                fireEvent.click(within(dialog).getByTestId('whats-new-mark-all'));
            });
            await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));

            // The per-entry write was counted before "Mark all" landed.
            await act(async () => {
                settleWrite({ success: true, unreadCount: 1 });
                await vi.advanceTimersByTimeAsync(0);
            });
            expect(screen.getByTestId('count')).toHaveTextContent('0');
        } finally {
            observers.restore();
        }
    });

    it('S-2: an entry seen for a second loses its dot in place, and the write lands in the badge', async () => {
        const original = window.IntersectionObserver;
        const observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = [];
        class RecordingObserver {
            targets: Element[] = [];
            constructor(readonly callback: IntersectionObserverCallback) {
                observers.push(this);
            }
            observe(target: Element) {
                this.targets.push(target);
            }
            unobserve() {}
            disconnect() {}
        }
        // @ts-expect-error — test double
        window.IntersectionObserver = RecordingObserver;
        try {
            getChangelog.mockResolvedValue({
                success: true,
                data: page({
                    entries: [
                        entry(),
                        entry({ slug: 'older-entry', title: 'Older', isRead: true }),
                    ],
                    unreadCount: 1,
                }),
            });
            markChangelogRead.mockResolvedValue({ success: true, unreadCount: 0 });
            render(<Harness initialCount={1} />);
            const dialog = await openPanel();
            await within(dialog).findByTestId('whats-new-list');

            const [unread, older] = within(dialog).getAllByTestId('whats-new-entry');
            const observer = observers.find((candidate) => candidate.targets.includes(unread));
            expect(observer, 'the unread card is watched').toBeDefined();
            expect(observer?.targets).not.toContain(older);

            act(() => {
                observer?.callback(
                    [
                        {
                            target: unread,
                            isIntersecting: true,
                            intersectionRatio: 1,
                        } as unknown as IntersectionObserverEntry,
                    ],
                    observer as unknown as IntersectionObserver,
                );
            });

            await waitFor(() => expect(unread).toHaveAttribute('data-read', 'true'), {
                timeout: 3000,
            });
            expect(within(dialog).getAllByTestId('whats-new-entry')[0]).toBe(unread);

            fireEvent.keyDown(dialog, { key: 'Escape' });
            await waitFor(() =>
                expect(markChangelogRead).toHaveBeenCalledWith(['stop-the-whole-fleet']),
            );
            await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
        } finally {
            window.IntersectionObserver = original;
        }
    });

    it('FR-51: Escape closes the panel and returns focus to the control that opened it', async () => {
        render(<Harness />);
        const dialog = await openPanel();
        await within(dialog).findByTestId('whats-new-list');

        fireEvent.keyDown(dialog, { key: 'Escape' });

        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        await waitFor(() => expect(screen.getByTestId('opener')).toHaveFocus());
    });

    it('FR-35: the filter resets to All every time the panel opens', async () => {
        getChangelog.mockImplementation(async () => ({
            success: true,
            data: page({ categoriesWithEntries: ['connections', 'costs'] }),
        }));
        render(<Harness />);
        let dialog = await openPanel();
        await within(dialog).findByTestId('whats-new-list');
        fireEvent.click(within(dialog).getByTestId('whats-new-filter-costs'));
        await waitFor(() => expect(getChangelog).toHaveBeenLastCalledWith({ category: 'costs' }));

        fireEvent.keyDown(dialog, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

        dialog = await openPanel();
        await within(dialog).findByTestId('whats-new-list');
        expect(getChangelog).toHaveBeenLastCalledWith({ category: undefined });
        expect(within(dialog).getByTestId('whats-new-filter-all')).toHaveAttribute(
            'aria-checked',
            'true',
        );
    });
});
