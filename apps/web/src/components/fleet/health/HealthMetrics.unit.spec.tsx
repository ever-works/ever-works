import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FleetNodeView } from '@ever-works/contracts';

// The REAL English strings: a key a component asks for that `en.json` lacks
// fails the test instead of echoing (see `fleet-test-intl.ts`).
vi.mock('next-intl', async () => {
    const { testTranslations } = await import('./fleet-test-intl');
    return { useLocale: () => 'en-GB', useTranslations: testTranslations };
});

// The real server action module is server-only; the component takes the clear as a prop.
vi.mock('@/app/actions/settings/fleet', () => ({ clearFleetNodeModelThrottleAction: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({
        children,
        href,
        className,
    }: {
        children: React.ReactNode;
        href: string;
        className?: string;
    }) => (
        <a href={href} className={className}>
            {children}
        </a>
    ),
}));

import { HealthMetrics } from './overview/HealthMetrics';
import { HealthCells } from './HealthCells';
import { FixAction } from './FixAction';

const NOW = Date.parse('2026-10-18T09:41:00.000Z');
const FRESH = '2026-10-18T09:40:12.000Z';
const GIB = 1024 ** 3;

function node(overrides: Partial<FleetNodeView> = {}): FleetNodeView {
    return {
        id: 'n1',
        name: 'build-01',
        kind: 'node',
        status: 'online',
        platform: 'linux/x64',
        version: '0.3.0',
        capabilities: ['claude-code'],
        lastHeartbeatAt: FRESH,
        createdAt: null,
        persisted: true,
        minFreeDiskBytes: 5 * GIB,
        health: {
            at: FRESH,
            cpuPercent: 31.2,
            memPercent: 58,
            memUsedMiB: 9523,
            memTotalMiB: 16384,
            diskPercent: 40,
            diskFreeMiB: 118 * 1024,
            diskTotalMiB: 200 * 1024,
            loadAvg1: 1.93,
            cpuCores: 4,
            uptimeSec: 3 * 86_400 + 4 * 3_600,
            gpu: [
                {
                    vendor: 'nvidia',
                    name: 'RTX 4070',
                    utilPercent: 12,
                    memUsedMiB: 2048,
                    memTotalMiB: 8192,
                },
            ],
            pendingReboot: false,
            failedServices: 1,
        },
        ...overrides,
    };
}

const cards = () =>
    screen.getAllByTestId('fleet-health-card').map((card) => card.textContent ?? '');

describe('HealthMetrics (spec S2, §5.2)', () => {
    it('shows the six cards with the node’s own values', () => {
        render(<HealthMetrics node={node()} now={NOW} historyEnabled />);
        expect(cards()).toEqual([
            'CPU31%',
            'Memory58%9.3 GiB of 16 GiB',
            'Disk40%118 GiB freeNode floor 5 GiB',
            'GPURTX 407012% busy2 GiB of 8 GiB',
            'Load1.934 cores',
            'Services1 failed',
        ]);
        expect(screen.getByTestId('fleet-health-pending-reboot').textContent).toBe(
            'Pending reboot: no',
        );
        expect(screen.getByText('Up 3 d 4 h')).toBeTruthy();
        expect(screen.getByTestId('fleet-health-checked').textContent).toMatch(
            /^Checked .* \(48 s ago\)$/,
        );
        expect(screen.getByTestId('fleet-health-footprint').textContent).toContain(
            'about 10 000 samples a week',
        );
    });

    it('renders "—" with a hint for every fact the node did not report — never 0 (U8)', () => {
        render(<HealthMetrics node={node({ health: { at: FRESH, cpuPercent: 4 } })} now={NOW} />);
        const values = cards();
        expect(values[0]).toBe('CPU4%');
        expect(values.slice(1).every((value) => value.includes('—'))).toBe(true);
        expect(screen.getByTestId('fleet-health-pending-reboot').textContent).toBe(
            'Pending reboot: —',
        );
    });

    it('tells "No GPU" apart from "not known", and counts further GPUs', () => {
        const { rerender } = render(
            <HealthMetrics node={node({ health: { at: FRESH, gpu: null } })} now={NOW} />,
        );
        expect(cards()[3]).toBe('GPUNo GPU');
        rerender(
            <HealthMetrics
                node={node({
                    health: {
                        at: FRESH,
                        gpu: [
                            { vendor: 'nvidia', name: 'A' },
                            { vendor: 'nvidia', name: 'B' },
                            { vendor: 'intel', name: 'C' },
                        ],
                    },
                })}
                now={NOW}
            />,
        );
        expect(cards()[3]).toBe('GPUA+2 more');
    });

    it('says the node version reports no health when there is no snapshot (ACC-FL03-02)', () => {
        render(<HealthMetrics node={node({ health: null })} now={NOW} />);
        expect(screen.getByTestId('fleet-health-no-snapshot').textContent).toContain(
            'does not report health',
        );
        expect(screen.queryAllByTestId('fleet-health-card')).toHaveLength(0);
    });

    it('dims a 2 h-old snapshot and says it is stale, never "checked" (FR-5, FR-30)', () => {
        render(
            <HealthMetrics
                node={node({ health: { at: '2026-10-18T07:41:00.000Z', cpuPercent: 3 } })}
                now={NOW}
            />,
        );
        expect(screen.getByTestId('fleet-health-checked').textContent).toBe(
            'Last checked 2 h ago — values are stale',
        );
        expect(document.querySelector('[data-stale="true"]')).toBeTruthy();
    });

    it('an offline computer: values dimmed as stale, Refresh now disabled with the reason (U1)', () => {
        render(<HealthMetrics node={node({ status: 'offline' })} now={NOW} />);
        expect(document.querySelector('[data-stale="true"]')).toBeTruthy();
        const button = screen.getByRole('button', { name: 'Refresh now' }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        const reason = document.getElementById(button.getAttribute('aria-describedby') ?? '');
        expect(reason?.textContent).toBe('build-01 is offline');
        expect(screen.getByTestId('fleet-computer-state').getAttribute('data-state')).toBe(
            'offline',
        );
    });

    it('Refresh now waits for the node link, and says so', () => {
        render(<HealthMetrics node={node()} now={NOW} />);
        const button = screen.getByRole('button', { name: 'Refresh now' }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(
            document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent,
        ).toContain('arrives with the node link');
    });

    it('says history is off when the deployment keeps none (U10), and nothing when it is not known', () => {
        const { rerender } = render(
            <HealthMetrics node={node()} now={NOW} historyEnabled={false} />,
        );
        expect(screen.getByTestId('fleet-health-footprint').textContent).toBe(
            'History is switched off on this deployment.',
        );
        rerender(<HealthMetrics node={node()} now={NOW} />);
        expect(screen.queryByTestId('fleet-health-footprint')).toBeNull();
    });

    it('loading and error states, with Try again', () => {
        const onRetry = vi.fn();
        const { rerender } = render(<HealthMetrics node={node()} now={NOW} status="loading" />);
        expect(screen.getByTestId('fleet-health-loading').textContent).toBe('Loading health…');
        rerender(<HealthMetrics node={node()} now={NOW} status="error" onRetry={onRetry} />);
        expect(screen.getByTestId('fleet-health-error').textContent).toBe('Could not load health.');
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('heads the block with the state word beside the dot and its sentence (FR-9, spec S3)', () => {
        render(
            <HealthMetrics
                node={node({
                    workerState: 'throttled',
                    modelThrottles: [
                        {
                            provider: 'claude-code',
                            window: 'weekly',
                            until: '2026-10-19T01:00:00.000Z',
                            reason: 'x',
                            since: FRESH,
                        },
                    ],
                })}
                now={NOW}
                clearModelThrottle={vi.fn()}
            />,
        );
        const state = screen.getByTestId('fleet-computer-state');
        expect(state.getAttribute('data-state')).toBe('limited');
        expect(within(state).getByText('Limited')).toBeTruthy();
        expect(state.textContent).toMatch(/Waiting for Claude Code's limit to reset at /);
        expect(within(state).getByRole('button', { name: 'Clear limit now' })).toBeTruthy();
    });
});

describe('HealthCells (spec S1)', () => {
    it('reads cpu · mem · disk and when it was checked', () => {
        render(<HealthCells node={node()} now={NOW} />);
        expect(screen.getByTestId('fleet-health-cells').textContent).toBe(
            'cpu 31% · mem 58% · disk 40% checked 48 s ago',
        );
    });

    it('a node of an older version shows dashes and says health is not reported', () => {
        render(<HealthCells node={node({ health: null })} now={NOW} />);
        expect(screen.getByTestId('fleet-health-cells').textContent).toBe(
            'cpu — · mem — · disk — Health not reported by this node version',
        );
    });

    it('marks a stale snapshot', () => {
        render(
            <HealthCells
                node={node({ health: { at: '2026-10-18T07:41:00.000Z', cpuPercent: 3 } })}
                now={NOW}
            />,
        );
        const cells = screen.getByTestId('fleet-health-cells');
        expect(cells.getAttribute('data-stale')).toBe('true');
        expect(cells.textContent).toContain('values are stale');
    });
});

describe('FixAction (FR-8, FR-10)', () => {
    it('Clear limit now calls the existing clear for exactly that CLI and reports the outcome', async () => {
        const clear = vi.fn().mockResolvedValue({ success: true, error: null });
        const onDone = vi.fn();
        render(
            <FixAction
                nodeId="n1"
                nodeName="build-02"
                action={{ kind: 'clear-model-throttle', provider: 'claude-code' }}
                clearModelThrottle={clear}
                onDone={onDone}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Clear limit now' }));
        await waitFor(() =>
            expect(screen.getByRole('status').textContent).toContain('Limit cleared'),
        );
        expect(clear).toHaveBeenCalledWith('n1', 'claude-code');
        expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('clears every CLI when the state names several, and says so on failure', async () => {
        const clear = vi.fn().mockResolvedValue({ success: false, error: 'nope' });
        render(
            <FixAction
                nodeId="n1"
                nodeName="build-02"
                action={{ kind: 'clear-model-throttle' }}
                clearModelThrottle={clear}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Clear limits now' }));
        await waitFor(() =>
            expect(screen.getByRole('status').textContent).toBe(
                'Could not clear the limit. Try again.',
            ),
        );
        expect(clear).toHaveBeenCalledWith('n1', null);
    });

    it('a machine command is shown to copy — never a button that runs it (spec S4)', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        render(
            <FixAction
                nodeId="n1"
                nodeName="design-mac"
                action={{
                    kind: 'copy-command',
                    command: 'ever-works-node clear-quarantine --confirm-process-tree-stopped',
                }}
            />,
        );
        const block = screen.getByTestId('fleet-fix-command');
        expect(block.textContent).toContain(
            'On design-mac, after checking that no earlier job is still running there, run:',
        );
        expect(block.textContent).toContain(
            'ever-works-node clear-quarantine --confirm-process-tree-stopped',
        );
        fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
        await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied'));
        expect(writeText).toHaveBeenCalledWith(
            'ever-works-node clear-quarantine --confirm-process-tree-stopped',
        );
    });

    it('Change limits is a link to where limits are edited', () => {
        render(
            <FixAction
                nodeId="n1"
                nodeName="b"
                action={{ kind: 'change-limits' }}
                limitsHref="/fleet/computers/n1?tab=settings"
            />,
        );
        expect(
            screen.getByTestId('fleet-fix-change-limits').querySelector('a')?.getAttribute('href'),
        ).toContain('/fleet/computers/n1?tab=settings');
    });

    it('offers nothing for a state without a fix, and nothing for wake before the wake phase', () => {
        const { container, rerender } = render(
            <FixAction nodeId="n1" nodeName="b" action={null} />,
        );
        expect(container.textContent).toBe('');
        rerender(<FixAction nodeId="n1" nodeName="b" action={{ kind: 'wake' }} />);
        expect(container.textContent).toBe('');
    });
});
