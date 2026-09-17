import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));
vi.mock('@/lib/help/help-telemetry', () => ({ captureHelpEvent: vi.fn() }));

import { EmptyState } from '@/components/common/EmptyState';
import { AttentionSection } from '@/components/dashboard/AttentionSection';
import { JobRuntimeDegradedBanner } from '@/components/dashboard/JobRuntimeDegradedBanner';
import type { AttentionItem } from '@/components/dashboard/dashboard-signals.types';
import { HelpCenterProvider } from './HelpCenterProvider';

/**
 * The surfaces that point at the manual (AW-25, spec FR-23): each one opens the
 * Help drawer at its article through the shell, and each one looks exactly as
 * before when there is no shell to open Help in.
 */

const onOpenTarget = vi.fn();
const inShell = (ui: ReactNode) =>
    render(<HelpCenterProvider onOpenTarget={onOpenTarget}>{ui}</HelpCenterProvider>);

beforeEach(() => {
    onOpenTarget.mockReset();
    window.localStorage.clear();
});

describe('shared EmptyState', () => {
    it('renders "How this works" after the primary action when given a help target', () => {
        const onClick = vi.fn();
        inShell(
            <EmptyState
                title="No works"
                action={{ label: 'Create', onClick }}
                helpTarget="creating-a-work"
            />,
        );
        const buttons = screen.getAllByRole('button');
        expect(buttons.map((button) => button.textContent)).toEqual(['Create', 'howThisWorks']);
        fireEvent.click(buttons[1]);
        expect(onOpenTarget).toHaveBeenCalledWith('creating-a-work');
        expect(onClick).not.toHaveBeenCalled();
    });

    it('is unchanged for every existing call site that passes no help target', () => {
        inShell(<EmptyState title="No works" action={{ label: 'Create', onClick: vi.fn() }} />);
        expect(screen.queryByTestId('help-link')).toBeNull();
    });
});

describe('degraded background work banner', () => {
    it('carries "Why am I seeing this?" to the job runtime article', async () => {
        inShell(<JobRuntimeDegradedBanner configured={false} />);
        const link = await screen.findByTestId('help-link');
        expect(link).toHaveTextContent('whyAmISeeingThis');
        fireEvent.click(link);
        expect(onOpenTarget).toHaveBeenCalledWith('job-runtimes#settings--job-runtime');
        // The banner's own dismissal is untouched.
        fireEvent.click(screen.getByTestId('job-runtime-banner-dismiss'));
        await waitFor(() => expect(screen.queryByTestId('job-runtime-degraded-banner')).toBeNull());
    });
});

describe('home attention items', () => {
    const items: AttentionItem[] = [
        { id: 'a', kind: 'agent-error', severity: 'danger', href: '/agents/a', label: 'Scout' },
        { id: 't', kind: 'task-blocked', severity: 'warning', href: '/tasks/t', label: 'T-1' },
        { id: 'g', kind: 'generation-failed', severity: 'danger', href: '/works/w', label: 'Site' },
        {
            id: 'b',
            kind: 'budget-exceeded',
            severity: 'danger',
            href: '/settings/usage',
            label: 'Account',
        },
    ] as AttentionItem[];

    it('gives every kind its own "Why am I seeing this?" without nesting it inside the card link', () => {
        inShell(<AttentionSection items={items} />);
        const links = screen.getAllByTestId('help-link');
        expect(links.map((link) => link.getAttribute('data-help-target'))).toEqual([
            'approvals-and-escalations#auto-pause-after-n-failures',
            'tasks#what-can-refuse-a-transition',
            'activity#the-log-view',
            'budgets-and-usage#what-happens-when-a-cap-is-hit',
        ]);
        for (const link of links) expect(link.closest('a')).toBeNull();
        expect(screen.getAllByRole('link').map((card) => card.getAttribute('href'))).toEqual([
            '/agents/a',
            '/tasks/t',
            '/works/w',
            '/settings/usage',
        ]);
    });
});
