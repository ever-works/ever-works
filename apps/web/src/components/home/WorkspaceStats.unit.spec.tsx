import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { HomeBlock, HomeGlance } from '@ever-works/contracts';

import messages from '../../../messages/en.json';

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    useRouter: () => ({ refresh: vi.fn() }),
}));

import { WorkspaceStats } from './WorkspaceStats';

const glance = (data: HomeGlance): HomeBlock<HomeGlance> => ({ status: 'ok', data });

function renderStats(props: Parameters<typeof WorkspaceStats>[0]) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <WorkspaceStats {...props} />
        </NextIntlClientProvider>,
    );
}

describe('WorkspaceStats (owner 2026-09-18 — Today at a glance merged in)', () => {
    it('renders one `Your workspace` card holding a Today half and an All half', () => {
        renderStats({
            glance: glance({ needsYou: 3, workingNow: 2, doneToday: 7, failedToday: 1 }),
            totalMissions: 4,
            totalIdeas: 9,
            totalWorks: 6,
            totalItems: 61,
            activeWebsites: 2,
            monthSpendCents: 1842,
            monthSpendCurrency: 'usd',
            agentsTotal: 5,
            agentsActive: 3,
            tasksInProgress: 8,
            tasksBlocked: 1,
            teamsTotal: 2,
        });

        const card = screen.getByTestId('home-block-workspace');
        expect(within(card).getByRole('heading', { name: 'Your workspace' })).toBeInTheDocument();

        // Two sub-blocks, in order, inside the one card.
        const today = within(card).getByRole('heading', { name: 'Today' });
        const all = within(card).getByRole('heading', { name: 'All' });
        expect(today.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        // Today — the four time-bounded counters, each linked to its owner.
        expect(screen.getByTestId('home-glance-needsYou')).toHaveTextContent('3');
        expect(screen.getByTestId('home-glance-needsYou')).toHaveAttribute(
            'href',
            '/inbox?view=decisions',
        );
        // The Runs ledger is the Activity page's `Runs` view now, so each run
        // counter links straight there instead of via the retired `/runs`.
        expect(screen.getByTestId('home-glance-workingNow')).toHaveAttribute(
            'href',
            '/activity?view=runs&g=day&status=running',
        );
        expect(screen.getByTestId('home-glance-doneToday')).toHaveAttribute(
            'href',
            '/activity?view=runs&g=day&status=completed',
        );
        expect(screen.getByTestId('home-glance-failedToday')).toHaveAttribute(
            'href',
            '/activity?view=runs&g=day&status=failed',
        );
        expect(screen.getByTestId('home-glance-failedToday')).toHaveAttribute(
            'data-tone',
            'danger',
        );
        expect(screen.getByTestId('home-glance-doneToday')).toHaveAttribute('data-tone', 'neutral');

        // All — the account totals, unchanged.
        expect(within(card).getByText('Total Missions')).toBeInTheDocument();
        expect(within(card).getByText('Total Works')).toBeInTheDocument();
    });

    it('says so, with a Retry, when the Today counters could not be read', () => {
        const onRetry = vi.fn();
        renderStats({
            glance: { status: 'failed', errorKey: 'timeout', data: null },
            totalWorks: 6,
            onRetry,
        });

        const error = screen.getByTestId('home-glance-error');
        expect(error).toHaveTextContent("Couldn't load today at a glance.");
        within(error).getByRole('button', { name: 'Retry' }).click();
        expect(onRetry).toHaveBeenCalledTimes(1);

        // A broken Today half never takes the All half down with it.
        expect(screen.getByText('Total Works')).toBeInTheDocument();
        expect(screen.queryByTestId('home-glance-needsYou')).toBeNull();
    });

    it('shows a skeleton — never zeros — while the Today counters are still loading', () => {
        renderStats({ glance: undefined, totalWorks: 6 });

        expect(screen.getByTestId('home-glance-skeleton')).toBeInTheDocument();
        expect(screen.queryByTestId('home-glance-needsYou')).toBeNull();
        expect(screen.getByText('Total Works')).toBeInTheDocument();
    });
});
