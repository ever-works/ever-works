import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { FleetNodeHealthHistory, FleetNodeHealthHistoryPoint } from '@ever-works/contracts';

vi.mock('next-intl', async () => {
    const { testTranslations } = await import('./fleet-test-intl');
    return { useLocale: () => 'en-GB', useTranslations: testTranslations };
});

import { HealthHistoryChart } from './overview/HealthHistoryChart';
import { sparklineSegments } from './HealthSparkline';

/**
 * Computer health, second phase (FL-03, spec S6, §5.7, §5.8, FR-21, FR-22) —
 * the history chart's states and its text summary, and the card sparkline's
 * breaks.
 */

function point(at: string, cpu: number | null, overrides: Partial<FleetNodeHealthHistoryPoint> = {}) {
    return { at, cpu, mem: cpu === null ? null : 50, disk: cpu === null ? null : 40, cpuMax: cpu, memMax: null, diskMax: null, ...overrides };
}

function history(points: FleetNodeHealthHistoryPoint[]): FleetNodeHealthHistory {
    return {
        nodeId: 'n1',
        range: '1h',
        disabled: false,
        resolution: 'raw',
        from: '2026-10-21T09:00:00.000Z',
        to: '2026-10-21T10:00:00.000Z',
        bucketMs: 60_000,
        points,
    };
}

const visible = { cpu: true, mem: true, disk: true };

function renderChart(props: Partial<Parameters<typeof HealthHistoryChart>[0]> = {}) {
    return render(
        <HealthHistoryChart
            nodeName="build-01"
            range="1h"
            onRangeChange={vi.fn()}
            visible={visible}
            onToggle={vi.fn()}
            status="ready"
            history={null}
            {...props}
        />,
    );
}

describe('HealthHistoryChart', () => {
    it('says history is switched off on this deployment (U10)', () => {
        renderChart({ history: { nodeId: 'n1', range: '24h', disabled: true } });
        expect(screen.getByTestId('fleet-history-off')).toHaveTextContent('History is switched off on this deployment.');
        expect(screen.queryByTestId('fleet-history-plot')).toBeNull();
    });

    it('says when the first sample lands when there is none yet', () => {
        renderChart({ history: history([]) });
        expect(screen.getByTestId('fleet-history-empty')).toHaveTextContent(
            'No samples yet — the first one lands on the next check-in.',
        );
    });

    it('shows loading, then an error with Try again', () => {
        const onRetry = vi.fn();
        const { rerender } = renderChart({ status: 'loading' });
        expect(screen.getByTestId('fleet-history-loading')).toBeInTheDocument();
        rerender(
            <HealthHistoryChart
                nodeName="build-01"
                range="1h"
                onRangeChange={vi.fn()}
                visible={visible}
                onToggle={vi.fn()}
                status="error"
                history={null}
                onRetry={onRetry}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(onRetry).toHaveBeenCalled();
    });

    it('summarises each line in words, peak and its time included, gaps skipped (spec §5.8)', () => {
        renderChart({
            history: history([
                point('2026-10-21T09:00:00.000Z', 20),
                point('2026-10-21T09:05:00.000Z', null),
                point('2026-10-21T09:12:00.000Z', 42, { cpuMax: 78 }),
            ]),
        });
        const summary = screen.getByTestId('fleet-history-summary');
        expect(summary).toHaveTextContent(/CPU averaged 31% over the last hour, peak 78% at/);
        expect(summary).toHaveTextContent(/Memory averaged 50% over the last hour/);
        expect(screen.getByTestId('fleet-history-plot')).toBeInTheDocument();
    });

    it('offers the four ranges, the chosen one pressed, and reports a change', () => {
        const onRangeChange = vi.fn();
        renderChart({ history: history([point('2026-10-21T09:00:00.000Z', 5)]), onRangeChange });
        expect(screen.getByTestId('fleet-history-range-1h')).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(screen.getByTestId('fleet-history-range-7d'));
        expect(onRangeChange).toHaveBeenCalledWith('7d');
    });

    it('toggles a line', () => {
        const onToggle = vi.fn();
        renderChart({ history: history([point('2026-10-21T09:00:00.000Z', 5)]), onToggle });
        fireEvent.click(screen.getByTestId('fleet-history-toggle-disk'));
        expect(onToggle).toHaveBeenCalledWith('disk');
    });
});

describe('sparklineSegments', () => {
    it('breaks the line at a gap instead of dropping to zero', () => {
        const segments = sparklineSegments([
            point('a', 0),
            point('b', 100),
            point('gap', null),
            point('c', 50),
            point('d', 50),
        ]);
        expect(segments).toHaveLength(2);
        expect(segments[0]).toBe('0,16 16,0');
        expect(segments[1]).toBe('48,8 64,8');
    });

    it('answers nothing for no points', () => {
        expect(sparklineSegments([])).toEqual([]);
    });
});
