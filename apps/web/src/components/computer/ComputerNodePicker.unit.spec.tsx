import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComputerNodeOption } from '@ever-works/contracts';
import { ComputerNodePicker } from './ComputerNodePicker';

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
        `${namespace}.${key}${values ? `:${Object.values(values).join(',')}` : ''}`,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({
        children,
        href,
        ...rest
    }: {
        children: React.ReactNode;
        href: string;
        'data-testid'?: string;
    }) => (
        <a href={href} data-testid={rest['data-testid']}>
            {children}
        </a>
    ),
}));

function node(over: Partial<ComputerNodeOption>): ComputerNodeOption {
    return {
        id: 'node',
        name: 'node',
        kind: 'desktop-node',
        status: 'online',
        platform: 'linux/x64',
        lastHeartbeatAt: new Date(1_000_000 - 4000).toISOString(),
        servableChannels: ['screen', 'terminal'],
        channelReasons: {},
        watchable: true,
        unwatchableReason: null,
        boundToAgent: false,
        controlPolicy: 'owner',
        ...over,
    };
}

const NODES = [
    node({ id: 'pinned', name: 'studio-imac', boundToAgent: true }),
    node({
        id: 'build',
        name: 'build-box-01',
        servableChannels: ['terminal'],
        channelReasons: { screen: 'no-browser' },
    }),
    node({
        id: 'old',
        name: 'old-mini',
        status: 'offline',
        watchable: false,
        unwatchableReason: 'offline',
        servableChannels: [],
    }),
    node({
        id: 'nuc',
        name: 'office-nuc',
        watchable: false,
        unwatchableReason: 'not-attended',
        servableChannels: [],
    }),
    node({
        id: 'k8s',
        name: 'prod-worker-3',
        kind: 'k8s',
        watchable: false,
        unwatchableReason: 'cluster',
        servableChannels: [],
    }),
];

describe('ComputerNodePicker', () => {
    it('lists every computer in the order given, each naming its state in words', async () => {
        render(
            <ComputerNodePicker
                agentId="agent-1"
                agentName="Ops"
                nodes={NODES}
                selectedNodeId="pinned"
                onSelect={vi.fn()}
                now={1_000_000}
            />,
        );
        await userEvent.click(screen.getByTestId('computer-node-picker-trigger'));

        const options = screen.getAllByRole('option');
        expect(options.map((option) => option.textContent)).toEqual([
            expect.stringContaining('studio-imac'),
            expect.stringContaining('build-box-01'),
            expect.stringContaining('old-mini'),
            expect.stringContaining('office-nuc'),
            expect.stringContaining('prod-worker-3'),
        ]);
        expect(options[0].textContent).toContain('nodePicker.pinnedBadge:Ops');
        expect(options[1].textContent).toContain('nodePicker.capabilitiesTerminal');
        expect(options[1].textContent).toContain('nodePicker.reasonNoBrowser');
        expect(options[2].textContent).toContain('nodePicker.reasonOffline');
        expect(options[3].textContent).toContain('nodePicker.reasonNotAttended');
        expect(options[4].textContent).toContain('nodePicker.reasonCluster');
        expect(options[0]).toHaveAttribute('aria-selected', 'true');
    });

    it('says picking a computer does not change where the work runs, and links to the pin', async () => {
        render(
            <ComputerNodePicker
                agentId="agent-1"
                agentName="Ops"
                nodes={NODES}
                selectedNodeId="pinned"
                onSelect={vi.fn()}
            />,
        );
        await userEvent.click(screen.getByTestId('computer-node-picker-trigger'));
        expect(screen.getByText(/nodePicker\.heading:Ops/)).toBeInTheDocument();
        expect(screen.getByText(/nodePicker\.pinnedNote:Ops,studio-imac/)).toBeInTheDocument();
        expect(screen.getByTestId('computer-node-picker-capabilities-link')).toHaveAttribute(
            'href',
            '/agents/agent-1/capabilities',
        );
    });

    it('hands the chosen computer to the page and closes', async () => {
        const onSelect = vi.fn();
        render(
            <ComputerNodePicker
                agentId="agent-1"
                agentName="Ops"
                nodes={NODES}
                selectedNodeId="pinned"
                onSelect={onSelect}
            />,
        );
        await userEvent.click(screen.getByTestId('computer-node-picker-trigger'));
        await userEvent.click(screen.getByTestId('computer-node-option-build'));
        expect(onSelect).toHaveBeenCalledWith('build');
        expect(screen.queryByTestId('computer-node-picker')).not.toBeInTheDocument();
    });
});
