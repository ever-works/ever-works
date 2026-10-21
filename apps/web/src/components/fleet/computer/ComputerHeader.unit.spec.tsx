import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FleetNodeView } from '@ever-works/contracts';

/**
 * Fleet hub (FL-01, FR-16, FR-21, spec §5.8, T-22) — the computer page's
 * header: the state in words beside the dot (never the dot alone), the OS and
 * when it last checked in, New session and Desktop disabled naming the epics
 * that bring them, and the ⋯ menu in its slot.
 */

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
    useLocale: () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));
vi.mock('@/components/ui/tooltip', () => ({
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../modules', () => ({}));

import { ComputerHeader } from './ComputerHeader';

const node = (over: Partial<FleetNodeView> = {}): FleetNodeView =>
    ({
        id: 'n1',
        name: 'build-01',
        kind: 'node',
        status: 'online',
        platform: 'linux/x64',
        version: '1.0.0',
        capabilities: [],
        lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString(),
        createdAt: null,
        persisted: true,
        viewerRole: 'owner',
        ...over,
    }) as FleetNodeView;

describe('ComputerHeader', () => {
    it.each([
        ['online', 'states.online'],
        ['paused', 'states.paused'],
        ['disabled', 'states.disabled'],
    ] as const)('says the state in words for %s', (status, word) => {
        render(<ComputerHeader node={node({ status })} />);
        expect(screen.getByTestId('fleet-computer-state')).toHaveTextContent(word);
    });

    it('says when an offline computer was last seen', () => {
        render(<ComputerHeader node={node({ status: 'offline' })} />);
        expect(screen.getByTestId('fleet-computer-state')).toHaveTextContent('states.offlineSince');
    });

    it('names the computer, its OS and the epics that bring New session and Desktop', () => {
        render(<ComputerHeader node={node()} />);
        expect(screen.getByTestId('fleet-computer-name')).toHaveTextContent('build-01');
        expect(screen.getByTestId('fleet-computer-facts')).toHaveTextContent('os.linux');
        expect(screen.getByTestId('fleet-computer-new-session')).toBeDisabled();
        expect(screen.getByTestId('fleet-computer-new-session')).toHaveTextContent(
            'computer.header.newSessionArrives:FL-04',
        );
        expect(screen.getByTestId('fleet-computer-desktop')).toBeDisabled();
        expect(screen.getByTestId('fleet-computer-desktop')).toHaveTextContent(
            'computer.header.desktopArrives:FL-07',
        );
    });

    it('renders the ⋯ menu in its slot, after the actions', () => {
        render(<ComputerHeader node={node()} menu={<button data-testid="stub-menu">⋯</button>} />);
        const actions = screen.getByTestId('fleet-computer-actions');
        expect(actions.lastElementChild).toBe(screen.getByTestId('stub-menu'));
    });

    it('says "Shared with you" on someone else’s computer', () => {
        render(<ComputerHeader node={node({ viewerRole: 'org-member' })} />);
        expect(screen.getByText('overview.computers.sharedWithYou')).toBeInTheDocument();
    });
});
