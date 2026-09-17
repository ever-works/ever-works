import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { HomeBlock, HomeSpend } from '@ever-works/contracts';

import messages from '../../../messages/en.json';
import { ThisWeekPanel } from './ThisWeekPanel';

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

function spend(overrides: Partial<HomeSpend> = {}): HomeSpend {
    return {
        windowDays: 7,
        totalCents: 1842,
        currency: 'usd',
        runsCount: 61,
        avgPerRunCents: 30,
        scope: { kind: 'organization' },
        accountCap: {
            periodSpendCents: 3910,
            periodCapCents: 5000,
            percentUsed: 78.2,
            blocked: false,
            allowOverage: true,
        },
        everSpent: true,
        ...overrides,
    };
}

function renderPanel(
    block: HomeBlock<HomeSpend> | undefined,
    organizationName: string | null = 'Acme',
) {
    const errors: unknown[] = [];
    const utils = render(
        <NextIntlClientProvider
            locale="en"
            messages={messages}
            timeZone="UTC"
            onError={(e) => errors.push(e)}
        >
            <ThisWeekPanel block={block} organizationName={organizationName} />
        </NextIntlClientProvider>,
    );
    return { ...utils, errors };
}

describe('ThisWeekPanel', () => {
    it('shows the scoped 7-day headline and the account-wide cap bar (S5)', () => {
        const { errors } = renderPanel({ status: 'ok', data: spend() });

        expect(screen.getByTestId('home-this-week-total')).toHaveTextContent('$18.42');
        expect(screen.getByText('last 7 days in Acme')).toBeInTheDocument();
        expect(screen.getByText('61 runs · $0.30 avg per run')).toBeInTheDocument();
        const meter = screen.getByRole('meter');
        expect(meter).toHaveAttribute('data-tone', 'neutral');
        expect(screen.getByTestId('home-this-week-cap')).toHaveTextContent(
            '78% of your account-wide cap this billing period',
        );
        expect(errors).toEqual([]);
    });

    it('names Personal scope when no Organization is active', () => {
        renderPanel({ status: 'ok', data: spend({ scope: { kind: 'personal' } }) }, null);
        expect(screen.getByText('last 7 days in Personal')).toBeInTheDocument();
    });

    it('reads — for the average when there were no runs', () => {
        renderPanel({
            status: 'ok',
            data: spend({ runsCount: 0, avgPerRunCents: null, totalCents: 0 }),
        });
        expect(screen.getByText('0 runs · — avg per run')).toBeInTheDocument();
    });

    it('turns amber at 80 % and danger at 100 %, with the blocked or overage line', () => {
        const { unmount } = renderPanel({
            status: 'ok',
            data: spend({ accountCap: { ...spend().accountCap, percentUsed: 80 } }),
        });
        expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'warning');
        unmount();

        const blocked = renderPanel({
            status: 'ok',
            data: spend({
                accountCap: {
                    ...spend().accountCap,
                    percentUsed: 104,
                    blocked: true,
                    allowOverage: false,
                },
            }),
        });
        expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'danger');
        expect(screen.getByText('New runs are blocked.')).toBeInTheDocument();
        blocked.unmount();

        renderPanel({
            status: 'ok',
            data: spend({ accountCap: { ...spend().accountCap, percentUsed: 120 } }),
        });
        expect(screen.getByText('Overage is allowed.')).toBeInTheDocument();
    });

    it('always says account-wide beside the cap, never as a share of the headline', () => {
        renderPanel({ status: 'ok', data: spend() });
        const cap = screen.getByTestId('home-this-week-cap');
        expect(cap).toHaveTextContent('account-wide');
        expect(cap).toHaveTextContent('The cap applies across all your Organizations.');
    });

    it('offers to set a cap when none is set', () => {
        renderPanel({
            status: 'ok',
            data: spend({
                accountCap: { ...spend().accountCap, periodCapCents: null, percentUsed: null },
            }),
        });
        expect(screen.queryByRole('meter')).toBeNull();
        expect(screen.getByText(/No spend cap set\./)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /Set a cap/ })).toHaveAttribute(
            'href',
            '/settings/work-agent#account-budgets',
        );
    });

    it('links to account-wide spend with the 7-day window and says so to assistive technology', () => {
        renderPanel({ status: 'ok', data: spend() });
        const link = screen.getByRole('link', { name: /Manage spend/ });
        expect(link).toHaveAttribute('href', '/settings/usage?tab=costs&windowDays=7');
        expect(link).toHaveAccessibleDescription('Opens account-wide spend');
    });

    it('renders nothing for an account that never spent', () => {
        const { container } = renderPanel({ status: 'ok', data: spend({ everSpent: false }) });
        expect(container).toBeEmptyDOMElement();
    });

    it('renders its error card when the spend read failed', () => {
        renderPanel({ status: 'failed', errorKey: 'error', data: null });
        expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this week's spend.");
    });
});
