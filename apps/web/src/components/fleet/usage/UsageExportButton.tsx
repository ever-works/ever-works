'use client';

import { useTranslations } from 'next-intl';
import { Download } from 'lucide-react';
import { fleetUsageCsv, fleetUsageCsvFilename, type FleetUsageView } from '@ever-works/contracts';

/**
 * Usage & cost on the fleet (FL-20 P3, spec §0 "export") — **Export CSV** on
 * the Usage tab: the object on screen (totals, by model, by computer, busiest
 * checkouts, sessions) as one CSV, built in the browser from the same
 * `FleetUsageView` (no second read), with the payer sentence as its last row.
 */
export function UsageExportButton({ view }: { view: FleetUsageView }) {
    const t = useTranslations('fleet.usage.tab');
    const download = () => {
        const blob = new Blob([fleetUsageCsv(view)], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fleetUsageCsvFilename(view);
        link.click();
        URL.revokeObjectURL(url);
    };
    return (
        <button
            type="button"
            onClick={download}
            className="inline-flex items-center gap-1 rounded-md border border-border dark:border-border-dark px-2 py-0.5"
            data-testid="fleet-usage-export"
        >
            <Download className="w-3 h-3" aria-hidden />
            {t('exportCsv')}
        </button>
    );
}
