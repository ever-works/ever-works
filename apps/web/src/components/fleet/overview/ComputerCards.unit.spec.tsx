import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { FleetNodeView } from '@ever-works/contracts';
import { ComputerCards } from './ComputerCards';

/**
 * Fleet hub (FL-01, FR-7 – FR-9, FR-38, ACC-FL01-04 / -05) — the computer
 * cards: order, nesting under a host, "—" without a snapshot, the state word
 * beside every dot, and the shared chip.
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

const recent = new Date(Date.now() - 60_000).toISOString();

const node = (over: Partial<FleetNodeView> & { health?: unknown } = {}): FleetNodeView =>
    ({
        id: over.name ?? 'n',
        name: 'n',
        kind: 'node',
        status: 'online',
        platform: 'linux/x64',
        version: '1.0.0',
        capabilities: [],
        lastHeartbeatAt: recent,
        createdAt: null,
        persisted: true,
        ...over,
    }) as FleetNodeView;

const cards = () => screen.getAllByTestId(/^fleet-computer-card-(?!state|favourite|health|shared|host)/);

describe('ComputerCards', () => {
    it('lists favourites first, then online by most recent check, then the rest', () => {
        render(
            <ComputerCards
                nodes={[
                    node({ id: 'w', name: 'win-lab', status: 'offline', lastHeartbeatAt: '2026-10-01T00:00:00.000Z' }),
                    node({ id: 'b2', name: 'build-02' }),
                    node({ id: 'b1', name: 'build-01', isFavorite: true, lastHeartbeatAt: '2026-10-17T00:00:00.000Z' }),
                ]}
            />,
        );
        expect(cards().map((card) => card.getAttribute('data-testid'))).toEqual([
            'fleet-computer-card-b1',
            'fleet-computer-card-b2',
            'fleet-computer-card-w',
        ]);
        expect(within(cards()[0]).getByTestId('fleet-computer-card-favourite')).toBeInTheDocument();
        expect(screen.getByTestId('fleet-computer-count')).toHaveTextContent('count:3,2');
    });

    it('shows "—" and no number when the computer has no health snapshot', () => {
        render(<ComputerCards nodes={[node({ id: 'a', name: 'a' })]} />);
        const health = screen.getByTestId('fleet-computer-card-health');
        expect(health).toHaveTextContent('overview.computers.noValue');
        expect(health.textContent).not.toMatch(/\d+%/);
    });

    it('shows the snapshot’s numbers when there is one', () => {
        render(
            <ComputerCards
                nodes={[node({ id: 'a', name: 'a', health: { cpuPercent: 31, memPercent: 58, diskPercent: 40, at: recent } })]}
            />,
        );
        expect(screen.getByTestId('fleet-computer-card-health')).toHaveTextContent('31%');
    });

    it('nests a VM under its host with the "VM on" subtitle (FR-9)', () => {
        render(
            <ComputerCards
                nodes={[
                    node({ id: 'h', name: 'build-01' }),
                    node({ id: 'v', name: 'win-11-vm', status: 'offline', hostNodeId: 'h', virtualKind: 'vm' }),
                ]}
            />,
        );
        const host = screen.getByTestId('fleet-computer-card-h').closest('li') as HTMLElement;
        expect(within(host).getByTestId('fleet-computer-card-v')).toBeInTheDocument();
        expect(within(host).getByTestId('fleet-computer-card-host')).toHaveTextContent('overview.computers.nestedVm:build-01');
    });

    it('always says the state in words beside the dot, and marks a shared computer', () => {
        render(
            <ComputerCards
                nodes={[
                    node({ id: 'q', name: 'q', workerState: 'quarantined' }),
                    node({ id: 's', name: 's', viewerRole: 'org-member' }),
                ]}
            />,
        );
        expect(within(screen.getByTestId('fleet-computer-card-q')).getByTestId('fleet-computer-card-state')).toHaveTextContent(
            'states.quarantined',
        );
        expect(within(screen.getByTestId('fleet-computer-card-s')).getByTestId('fleet-computer-card-shared')).toBeInTheDocument();
        expect(within(screen.getByTestId('fleet-computer-card-q')).queryByTestId('fleet-computer-card-shared')).toBeNull();
    });

    it('links each card to the computer’s page', () => {
        render(<ComputerCards nodes={[node({ id: 'n1', name: 'build-01' })]} />);
        expect(screen.getByTestId('fleet-computer-card-n1')).toHaveAttribute('href', '/fleet/computers/n1');
    });
});
