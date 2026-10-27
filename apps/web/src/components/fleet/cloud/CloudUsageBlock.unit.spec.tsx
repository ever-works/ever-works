import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { FleetCloudUsageView } from '@ever-works/contracts';

/**
 * Cloud computers (FL-17 P2, T-26, spec S8, FR-23, §5.7) — the Cloud
 * computers usage block: totals (hourly now, this month with the destroyed
 * machine counted, projected), a row per machine with the destroyed one last,
 * the provider's own month-to-date labelled as the provider's, and the
 * estimate disclaimer; nothing at all when there is nothing to show.
 */

const actions = vi.hoisted(() => ({ fleetCloudUsageAction: vi.fn() }));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
}));
vi.mock('@/app/actions/fleet/cloud', () => actions);

import CloudUsageBlock from './CloudUsageBlock';

const USAGE: FleetCloudUsageView = {
    hourlyCents: 10.7,
    monthToDateCents: 1444,
    projectedMonthCents: 7200,
    currency: 'USD',
    estimate: true,
    computedAt: '2026-10-21T12:00:00.000Z',
    machines: [
        {
            nodeId: 'gone-1',
            name: 'build-tmp',
            providerName: 'Provider',
            regionId: 'nyc3',
            sizeLabel: '2 CPU',
            hourlyCents: 0,
            monthToDateCents: 312,
            sinceCreatedCents: 312,
            state: 'gone',
            destroyedAt: '2026-10-12T09:00:00.000Z',
        },
        {
            nodeId: 'n1',
            name: 'fra-nina',
            providerName: 'Provider',
            regionId: 'fra1',
            sizeLabel: '4 CPU',
            hourlyCents: 7.1,
            monthToDateCents: 1160,
            sinceCreatedCents: 1160,
            state: 'running',
            destroyedAt: null,
        },
    ],
    providerMonthToDate: [
        {
            providerPluginId: 'machines-plugin',
            providerName: 'Provider',
            monthToDateCents: 5000,
            computedAt: '2026-10-21T12:00:00.000Z',
        },
    ],
};

describe('CloudUsageBlock (FL-17 P2)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders the totals, the rows (destroyed last), the provider figure and the disclaimer', async () => {
        actions.fleetCloudUsageAction.mockResolvedValue({ ok: true, data: USAGE });
        render(<CloudUsageBlock />);
        await waitFor(() => expect(screen.getByTestId('fleet-cloud-usage')).toBeTruthy());
        expect(screen.getByTestId('fleet-cloud-usage-totals').textContent).toBe(
            'totals:$0.107,$14.44,$72',
        );
        const rows = screen.getAllByTestId('fleet-cloud-usage-row');
        expect(
            rows.map(
                (row) =>
                    row.textContent?.startsWith('fra-nina') ||
                    row.textContent?.startsWith('destroyedName'),
            ),
        ).toEqual([true, true]);
        expect(rows[1].textContent).toContain('destroyedName:build-tmp,2026-10-12');
        expect(rows[1].textContent).toContain('states.destroyed');
        expect(screen.getByTestId('fleet-cloud-usage-provider-mtd').textContent).toBe(
            'providerMtd:Provider,$50',
        );
        expect(screen.getByText('disclaimer')).toBeTruthy();
    });

    it('renders nothing when there is no cloud computer this month', async () => {
        actions.fleetCloudUsageAction.mockResolvedValue({
            ok: true,
            data: { ...USAGE, machines: [] },
        });
        const { container } = render(<CloudUsageBlock />);
        await waitFor(() => expect(actions.fleetCloudUsageAction).toHaveBeenCalled());
        expect(container.textContent).toBe('');
    });

    it('says so when the costs could not be loaded, and stays silent when cloud computers are off', async () => {
        actions.fleetCloudUsageAction.mockResolvedValue({
            ok: false,
            error: { code: 'internal', hint: '' },
        });
        render(<CloudUsageBlock />);
        await waitFor(() => expect(screen.getByTestId('fleet-cloud-usage-failed')).toBeTruthy());

        actions.fleetCloudUsageAction.mockResolvedValue({
            ok: false,
            error: { code: 'not_found', hint: '' },
        });
        const second = render(<CloudUsageBlock />);
        await waitFor(() => expect(actions.fleetCloudUsageAction).toHaveBeenCalledTimes(2));
        expect(second.container.textContent).toBe('');
    });
});
