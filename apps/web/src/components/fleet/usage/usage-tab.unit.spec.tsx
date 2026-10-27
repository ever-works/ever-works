import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FLEET_USAGE_PAYER_NOTE, type FleetUsageView } from '@ever-works/contracts';
import en from '../../../../messages/en.json';
import {
    UsageByComputer,
    UsageByModel,
    UsageCatchingUp,
    UsagePeriodControl,
    UsageSessionsBreakdown,
    UsageTotals,
} from './UsageBlocks';
import { ScheduleUsageCost } from '../schedules/ScheduleUsageCost';
import {
    usagePeriodForKey,
    usagePeriodFrom,
    usagePriceListLine,
    usageTabState,
} from './usage-tab.shared';

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string, vars?: Record<string, unknown>) => {
        let node: unknown = en;
        for (const part of `${namespace}.${key}`.split('.'))
            node = (node as Record<string, unknown>)?.[part];
        let text = typeof node === 'string' ? node : key;
        for (const [name, value] of Object.entries(vars ?? {}))
            text = text.split(`{${name}}`).join(String(value));
        return text;
    },
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('@/app/actions/fleet/usage', () => ({
    rescanFleetUsageAction: vi.fn(async () => ({ ok: true, data: { jobId: 'j' } })),
}));

/** FL-20 P2 T-25 … T-27 — the hub Usage tab's blocks, the period keys, the schedule cost. */

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const zero = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };

function view(overrides: Partial<FleetUsageView> = {}): FleetUsageView {
    return {
        days: 30,
        from: '2026-09-21T12:00:00.000Z',
        to: '2026-10-21T12:00:00.000Z',
        nodeId: null,
        model: null,
        totals: {
            costCents: 4120,
            tokens: { in: 18_000_000, out: 400_000, cacheRead: 0, cacheWrite: 0 },
            requests: 1212,
            topModel: 'claude-sonnet-4-5',
        },
        byModel: [
            {
                model: 'claude-sonnet-4-5',
                provider: 'claude-code',
                tokens: zero,
                requests: 912,
                costCents: 3140,
            },
            { model: 'local-7b', provider: 'codex', tokens: zero, requests: 12, costCents: null },
        ],
        byNode: [
            {
                nodeId: 'n1',
                name: 'build-01',
                scan: {
                    state: 'on',
                    online: true,
                    lastScanAt: '2026-10-21T11:56:00.000Z',
                    backlogPct: 0,
                    hint: null,
                },
                costCents: 2210,
                tokens: zero,
                requests: 900,
            },
            {
                nodeId: 'n2',
                name: 'design-mac',
                scan: {
                    state: 'on',
                    online: false,
                    lastScanAt: '2026-10-19T12:00:00.000Z',
                    backlogPct: 0,
                    hint: null,
                },
                costCents: 420,
                tokens: zero,
                requests: 12,
            },
            {
                nodeId: 'n3',
                name: 'laptop',
                scan: {
                    state: 'off',
                    online: true,
                    lastScanAt: null,
                    backlogPct: null,
                    hint: 'Usage scan is off — run `ever-works-node start --usage-scan` on laptop',
                },
                costCents: null,
                tokens: zero,
                requests: 0,
            },
        ],
        busiestCheckouts: [],
        sessions: {
            agents: [{ agentId: 'a1', name: 'Nina', sessions: 14, costCents: 900 }],
            owner: { sessions: 9, costCents: 100 },
            other: { sessions: 7, costCents: 50 },
        },
        unknownModels: { models: ['local-7b'], requests: 12 },
        excluded: { nodes: 0, otherHidden: false },
        catchingUp: { nodeId: 'n1', nodeName: 'build-01', scannedPct: 42 },
        priceList: { version: 1, effectiveFrom: '2026-10-26', versionsUsed: [1] },
        note: FLEET_USAGE_PAYER_NOTE,
        ...overrides,
    };
}

describe('usage-tab.shared', () => {
    it('reads the period from the URL and the keys 1-4', () => {
        expect(usagePeriodFrom('30')).toBe(30);
        expect(usagePeriodFrom('14')).toBe(7);
        expect(usagePeriodFrom(null)).toBe(7);
        expect(['1', '2', '3', '4', '5'].map(usagePeriodForKey)).toEqual([1, 7, 30, 90, null]);
    });

    it('is empty only when no computer reports, and names older price-list versions (U8)', () => {
        expect(usageTabState(view())).toBe('ready');
        expect(usageTabState(view({ byNode: [view().byNode[2]] }))).toBe('empty');
        expect(
            usagePriceListLine(
                view({
                    priceList: { version: 2, effectiveFrom: '2026-12-01', versionsUsed: [1, 2] },
                }),
            ),
        ).toEqual({
            key: 'priceListMixed',
            values: { versions: 'v1', version: '2', since: '2026-12-01' },
        });
    });
});

describe('the Usage tab blocks', () => {
    it('states the totals with the payer sentence right beneath, and the unknown-model exclusion (FR-8, FR-9, S5)', () => {
        render(<UsageTotals view={view()} />);
        const totals = screen.getByTestId('fleet-usage-totals');
        expect(totals.textContent).toContain('$41.20 at list price');
        expect(totals.textContent).toContain(FLEET_USAGE_PAYER_NOTE);
        expect(screen.getByTestId('fleet-usage-unknown-models').textContent).toContain(
            'excludes 12 requests on unknown models',
        );
    });

    it('keeps an offline computer with its scan age and shows the opt-in hint for one with the scan off (FR-13, U1, U2)', () => {
        const onNode = vi.fn();
        render(<UsageByComputer view={view()} nodes={[]} onNode={onNode} now={NOW} />);
        const text = screen.getByTestId('fleet-usage-by-computer').textContent ?? '';
        expect(text).toContain('scanned 4 min ago');
        expect(text).toContain('offline · scanned 2 d ago');
        expect(text).toContain(
            'Usage scan is off — run `ever-works-node start --usage-scan` on laptop',
        );
        fireEvent.click(screen.getByText('design-mac'));
        expect(onNode).toHaveBeenCalledWith('n2');
    });

    it('filters by a model, shows tokens only for an unknown one, the catching-up line and the sessions breakdown', () => {
        const onModel = vi.fn();
        render(
            <>
                <UsageByModel view={view()} onModel={onModel} />
                <UsageCatchingUp view={view()} />
                <UsageSessionsBreakdown view={view()} />
            </>,
        );
        expect(screen.getByTestId('fleet-usage-by-model').textContent).toContain('tokens only');
        fireEvent.click(screen.getByText('claude-sonnet-4-5'));
        expect(onModel).toHaveBeenCalledWith('claude-sonnet-4-5');
        expect(screen.getByTestId('fleet-usage-catching-up').textContent).toContain(
            'catching up · 42 % scanned on build-01',
        );
        expect(screen.getByTestId('fleet-usage-sessions').textContent).toContain(
            'other (not started from Ever Works) 7',
        );
    });

    it('switches periods from the control', () => {
        const onChange = vi.fn();
        render(<UsagePeriodControl days={7} onChange={onChange} />);
        fireEvent.click(screen.getByTestId('fleet-usage-period-90'));
        expect(onChange).toHaveBeenCalledWith(90);
    });
});

describe('ScheduleUsageCost (FR-16)', () => {
    it('shows the last run and the 30-day total at list price', () => {
        render(
            <ScheduleUsageCost
                cost={{
                    taskId: 't',
                    lastRun: { runId: 'r', at: '2026-10-20T08:00:00.000Z', costCents: 42 },
                    last30DaysCents: 610,
                    runs30Days: 4,
                }}
            />,
        );
        const cost = screen.getByTestId('fleet-schedule-usage-cost');
        expect(cost.textContent).toBe('last run $0.42 · 30 d $6.10 · list');
        expect(cost.getAttribute('title')).toBe(FLEET_USAGE_PAYER_NOTE);
    });

    it('shows nothing for a Task that never ran', () => {
        const { container } = render(
            <ScheduleUsageCost
                cost={{ taskId: 't', lastRun: null, last30DaysCents: null, runs30Days: 0 }}
            />,
        );
        expect(container.textContent).toBe('');
    });
});
