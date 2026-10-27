import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FLEET_USAGE_PAYER_NOTE, type FleetSessionUsage } from '@ever-works/contracts';
import en from '../../../../messages/en.json';
import { SessionCostChip } from '../sessions/SessionCostChip';
import { RunReceiptFleetCostLine } from '../../runs/RunReceiptFleetCostLine';
import { computerUsageLineState, sessionCostChipModel, usageAge, usageMoney } from './usage.shared';

// The real English messages, so the payer sentence is asserted VERBATIM (FR-9, ACC-FL20-07).
vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string, vars?: Record<string, unknown>) => {
        let node: unknown = en;
        for (const part of `${namespace}.${key}`.split('.')) node = (node as Record<string, unknown>)?.[part];
        let text = typeof node === 'string' ? node : key;
        for (const [name, value] of Object.entries(vars ?? {})) text = text.replace(`{${name}}`, String(value));
        return text;
    },
}));

/** FL-20 T-17, T-18 — the session chip, the receipt line and the pure helpers behind them. */

const usage = (byModel: FleetSessionUsage['byModel']): FleetSessionUsage => ({
    byModel,
    priceListVersion: 1,
    unknownModels: [],
    requests: 3,
    firstAt: null,
    lastAt: null,
    updatedAt: '2026-10-21T00:00:00.000Z',
});

describe('fleet.usage.payerNote', () => {
    it('is the contracts sentence, verbatim', () => {
        expect(en.fleet.usage.payerNote).toBe(FLEET_USAGE_PAYER_NOTE);
    });
});

describe('SessionCostChip', () => {
    it('shows the list-price cost with the payer sentence as its tooltip', () => {
        render(<SessionCostChip costCents={42} tokens={null} />);
        const chip = screen.getByTestId('fleet-session-cost-chip');
        expect(chip.textContent).toBe('$0.42 · list');
        expect(chip.getAttribute('title')).toBe(FLEET_USAGE_PAYER_NOTE);
    });

    it('says tokens only (with the model) when nothing could be priced — never $0', () => {
        render(
            <SessionCostChip
                costCents={null}
                tokens={usage({ 'local-7b': { in: 1000, out: 500, cacheRead: 0, cacheWrite: 0, requests: 3, costCents: null } })}
            />,
        );
        const chip = screen.getByTestId('fleet-session-cost-chip');
        expect(chip.textContent).toBe('tokens only · local-7b · 2 k');
        expect(chip.textContent).not.toContain('$');
    });

    it('renders nothing before the scan reported the session', () => {
        const { container } = render(<SessionCostChip costCents={null} tokens={null} />);
        expect(container.textContent).toBe('');
    });
});

describe('RunReceiptFleetCostLine', () => {
    it('names the computer, the cost, the version and the token classes, then the payer sentence', () => {
        render(
            <RunReceiptFleetCostLine
                usage={{
                    nodeId: 'n1',
                    nodeName: 'build-01',
                    costCents: 42,
                    tokens: { in: 61_000, out: 9_000, cacheRead: 200_000, cacheWrite: 12_000 },
                    requests: 9,
                    priceListVersion: 1,
                    unknownModels: [],
                    note: FLEET_USAGE_PAYER_NOTE,
                }}
            />,
        );
        const line = screen.getByTestId('run-receipt-fleet-cost-line');
        expect(line.textContent).toContain(
            'Model work on build-01 · $0.42 at list price (v1) · 61 k in · 9 k out · 212 k cache',
        );
        expect(line.textContent).toContain(FLEET_USAGE_PAYER_NOTE);
    });

    it('renders nothing for a Run without scanned usage', () => {
        const { container } = render(<RunReceiptFleetCostLine usage={null} />);
        expect(container.textContent).toBe('');
    });
});

describe('usage.shared', () => {
    it('never formats a missing figure as $0.00', () => {
        expect(usageMoney(null)).toBeNull();
        expect(usageMoney(0)).toBe('$0.00');
        expect(usageMoney(0.4)).toBe('<$0.01');
        expect(sessionCostChipModel({ costCents: null, tokens: null })).toBeNull();
    });

    it('reads the scan age and the three Overview states', () => {
        const now = Date.parse('2026-10-21T12:00:00.000Z');
        expect(usageAge('2026-10-21T11:56:00.000Z', now)).toBe('4 min');
        expect(usageAge('2026-10-19T12:00:00.000Z', now)).toBe('2 d');
        expect(computerUsageLineState(null, null, now)).toEqual({ kind: 'unsupported' });
        expect(
            computerUsageLineState({ state: 'off', online: true, lastScanAt: null, backlogPct: null, hint: 'x' }, null, now),
        ).toEqual({ kind: 'off' });
        expect(
            computerUsageLineState(
                { state: 'on', online: false, lastScanAt: '2026-10-21T11:56:00.000Z', backlogPct: 58, hint: null },
                2210,
                now,
            ),
        ).toEqual({ kind: 'on', cost: '$22.10', age: '4 min', online: false, scannedPct: 42 });
    });
});
