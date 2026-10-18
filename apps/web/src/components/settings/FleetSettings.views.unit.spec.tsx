import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { FleetNodeView } from '@/lib/api/fleet';
import { FleetSettings } from './FleetSettings';

/**
 * Fleet hub (FL-01, FR-10, FR-11, FR-15, ACC-FL01-06) — the one Settings →
 * Fleet component, three ways: `all` (today's page, byte for byte), `policies`
 * (Settings with the hub on: every policy, the link card, no machine table)
 * and `computers` (the hub's Computers tab: the table, Add, drawer, clusters).
 */

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    usePathname: () => '/',
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/settings/fleet', () => ({
    createFleetEnrollmentTokenAction: vi.fn(),
    deleteFleetNodeAction: vi.fn(),
    drainFleetNodeAction: vi.fn(),
    getFleetNodeDetailAction: vi.fn(),
    listFleetEnrollmentTokensAction: vi.fn(),
    revokeFleetEnrollmentTokenAction: vi.fn(),
    rotateFleetNodeCredentialAction: vi.fn(),
    updateFleetNodeAction: vi.fn(),
    setFleetNodeLimitCeilingAction: vi.fn(),
    clearFleetNodeModelThrottleAction: vi.fn(),
}));
vi.mock('./FleetKillSwitchBanner', () => ({
    FleetKillSwitchBanner: () => <div data-testid="stub-kill-switch" />,
}));
vi.mock('./FleetPanicControls', () => ({
    FleetPanicControls: () => <div data-testid="stub-panic" />,
}));
vi.mock('./FleetExecutionPreferences', () => ({
    FleetExecutionPreferences: () => <div data-testid="stub-preferences" />,
}));
vi.mock('./FleetCostCeiling', () => ({ FleetCostCeiling: () => <div data-testid="stub-cost" /> }));
vi.mock('./FleetTokensSection', () => ({
    FleetTokensSection: () => <div data-testid="stub-tokens" />,
}));
vi.mock('./FleetNodeDrawer', () => ({ FleetNodeDrawer: () => null }));
vi.mock('./FleetEnrollHandoff', () => ({ FleetEnrollHandoff: () => null }));

const node: FleetNodeView = {
    id: 'n1',
    name: 'build-01',
    kind: 'node',
    status: 'online',
    platform: 'linux/x64',
    version: '1.0.0',
    capabilities: [],
    lastHeartbeatAt: null,
    createdAt: null,
    persisted: true,
};

const base = {
    initialNodes: [node],
    loadError: null,
    initialTokens: [],
    tokensError: null,
    apiBaseUrl: 'http://localhost:3100',
    desktopDownloadUrl: 'https://example.test/d',
    nodeDownloadUrl: 'https://example.test/n',
    initialPreferences: [],
    preferencesError: null,
};

const POLICY_SECTIONS = ['stub-panic', 'stub-preferences', 'stub-cost', 'stub-tokens'];

describe('FleetSettings views', () => {
    it('all (default): today’s page — table, policies, banner, clusters, no link card', () => {
        render(<FleetSettings {...base} hubLinkCard={<div data-testid="link-card" />} />);
        expect(screen.getByTestId('fleet-nodes-table')).toBeInTheDocument();
        expect(screen.getByTestId('fleet-add-node')).toBeInTheDocument();
        expect(screen.getByTestId('stub-kill-switch')).toBeInTheDocument();
        expect(screen.getByTestId('fleet-cluster-section')).toBeInTheDocument();
        for (const id of POLICY_SECTIONS) expect(screen.getByTestId(id)).toBeInTheDocument();
        expect(screen.queryByTestId('link-card')).toBeNull();
        expect(screen.getByTestId('fleet-settings')).not.toHaveAttribute('data-view');
    });

    it('policies: every policy and the link card where the table was, no machines (FR-11)', () => {
        render(
            <FleetSettings
                {...base}
                view="policies"
                hubLinkCard={<div data-testid="link-card" />}
            />,
        );
        expect(screen.getByTestId('link-card')).toBeInTheDocument();
        expect(screen.getByTestId('stub-kill-switch')).toBeInTheDocument();
        for (const id of POLICY_SECTIONS) expect(screen.getByTestId(id)).toBeInTheDocument();
        expect(screen.queryByTestId('fleet-nodes-table')).toBeNull();
        expect(screen.queryByTestId('fleet-empty-state')).toBeNull();
        expect(screen.queryByTestId('fleet-cluster-section')).toBeNull();
        expect(screen.queryByTestId('fleet-add-node')).toBeNull();
    });

    it('computers: the table and clusters, no policies and no second banner (FR-10)', () => {
        render(<FleetSettings {...base} view="computers" />);
        expect(screen.getByTestId('fleet-nodes-table')).toBeInTheDocument();
        expect(screen.getByTestId('fleet-cluster-section')).toBeInTheDocument();
        expect(screen.queryByTestId('stub-kill-switch')).toBeNull();
        for (const id of POLICY_SECTIONS) expect(screen.queryByTestId(id)).toBeNull();
    });

    it('computers: renders the hub’s star column only when it is passed', () => {
        const { rerender } = render(<FleetSettings {...base} view="computers" />);
        expect(screen.queryByTestId('star-n1')).toBeNull();
        rerender(
            <FleetSettings
                {...base}
                view="computers"
                favorites={{
                    columnLabel: 'Favourite',
                    renderToggle: (row) => <button data-testid={`star-${row.id}`}>★</button>,
                }}
            />,
        );
        expect(screen.getByTestId('star-n1')).toBeInTheDocument();
    });

    it('computers: ?add= opens the Add flow and tells the page so it can drop the parameter', async () => {
        const onAddOpened = vi.fn();
        render(
            <FleetSettings
                {...base}
                view="computers"
                openAddKind="node"
                onAddOpened={onAddOpened}
            />,
        );
        await waitFor(() => expect(onAddOpened).toHaveBeenCalledTimes(1));
        expect(screen.getByTestId('fleet-add-name')).toBeInTheDocument();
    });
});

describe('FleetSettings views — review of PR 2', () => {
    it('policies: says a failed machine read, so the panic controls never pass it for "nothing to drain"', () => {
        render(<FleetSettings {...base} loadError="Could not load nodes" view="policies" />);
        expect(screen.getByText('Could not load nodes')).toBeInTheDocument();
    });

    it('computers: orders the rows it keeps through the hub’s orderNodes (a star re-sorts at once)', () => {
        const second: FleetNodeView = { ...node, id: 'n2', name: 'design-mac' };
        const { rerender } = render(
            <FleetSettings {...base} initialNodes={[node, second]} view="computers" />,
        );
        const rowIds = () =>
            screen.getAllByTestId(/^fleet-node-row-/).map((row) => row.getAttribute('data-testid'));
        expect(rowIds()).toEqual(['fleet-node-row-n1', 'fleet-node-row-n2']);
        rerender(
            <FleetSettings
                {...base}
                initialNodes={[node, second]}
                view="computers"
                orderNodes={(rows) => [...rows].reverse()}
            />,
        );
        expect(rowIds()).toEqual(['fleet-node-row-n2', 'fleet-node-row-n1']);
    });

    it('computers: renders the hub’s Open page action beside Details', () => {
        render(
            <FleetSettings
                {...base}
                view="computers"
                favorites={{
                    columnLabel: 'Favourite',
                    renderToggle: () => null,
                    renderOpen: (row) => (
                        <a data-testid={`open-${row.id}`} href={`/fleet/computers/${row.id}`} />
                    ),
                }}
            />,
        );
        expect(screen.getByTestId('open-n1')).toHaveAttribute('href', '/fleet/computers/n1');
    });
});
