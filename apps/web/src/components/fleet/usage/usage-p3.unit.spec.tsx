import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FLEET_USAGE_PAYER_NOTE, type FleetUsageView } from '@ever-works/contracts';
import en from '../../../../messages/en.json';
import { UsagePriceHistory } from './UsagePriceHistory';

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
vi.mock('@/app/actions/fleet/usage', () => ({
    getFleetUsagePricesAction: vi.fn(async () => ({
        ok: true,
        data: {
            version: 2,
            effectiveFrom: '2026-12-01',
            entries: [
                {
                    model: 'claude-sonnet-4-5',
                    provider: 'claude-code',
                    perMillionUsd: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
                },
            ],
            history: [
                { version: 1, effectiveFrom: '2026-10-26' },
                { version: 2, effectiveFrom: '2026-12-01' },
            ],
            note: 'n',
        },
    })),
}));

/** FL-20 P3 T-28 — the price-list version history panel on the Usage tab. */

const view = {
    days: 7,
    priceList: { version: 2, effectiveFrom: '2026-12-01', versionsUsed: [1, 2] },
    note: FLEET_USAGE_PAYER_NOTE,
} as unknown as FleetUsageView;

describe('UsagePriceHistory', () => {
    it('loads on first open and lists every version and the rates in effect', async () => {
        render(<UsagePriceHistory view={view} />);
        fireEvent.click(screen.getByText('Price list v2 — in effect since 2026-12-01'));
        await waitFor(() => expect(screen.getByTestId('fleet-usage-prices-history')).toBeTruthy());
        expect(screen.getByTestId('fleet-usage-prices-history').textContent).toContain(
            'v1 (2026-10-26) · v2 (2026-12-01)',
        );
        const table = screen.getByTestId('fleet-usage-prices').textContent ?? '';
        expect(table).toContain('claude-sonnet-4-5');
        expect(table).toContain('$15.00');
        expect(table).toContain('$0.3');
    });
});
