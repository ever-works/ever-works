'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Cloud } from 'lucide-react';
import type { FleetCloudUsageView } from '@ever-works/contracts';
import { fleetCloudUsageAction } from '@/app/actions/fleet/cloud';
import type { FleetOverviewBlockProps } from '../registry';
import { cloudUsageRows, hourly, money } from './cloud.shared';

/**
 * Cloud computers (FL-17 P2, spec S8, FR-22 – FR-24, §5.7) — the **Cloud
 * computers** usage block: what the owner's cloud computers bill per hour
 * now, this month so far (machines destroyed this month included) and the
 * projected month, with a row per machine — every figure an estimate from the
 * provider's list prices, labelled so. Where the provider plugin can read the
 * account's own month-to-date figure it is shown beside the estimate and
 * labelled as the provider's (it covers the whole account). This is provider
 * money for machines: it is never added to model-spend Budgets (FR-24).
 *
 * Mounted on the hub Overview behind `FLEET_CLOUD_ENABLED`; FL-20's Usage tab
 * mounts the same component below its model-work cards (FL-20 spec §5.1).
 * Renders nothing while there is nothing to show.
 */
export default function CloudUsageBlock(_props: Partial<FleetOverviewBlockProps>) {
    const t = useTranslations('fleet.cloud.usage');
    const [usage, setUsage] = useState<FleetCloudUsageView | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let alive = true;
        void fleetCloudUsageAction().then((result) => {
            if (!alive) return;
            if (result.ok) setUsage(result.data);
            else setFailed(result.error.code !== 'not_found');
        });
        return () => {
            alive = false;
        };
    }, []);

    if (failed) {
        return (
            <p
                role="status"
                className="text-sm text-text-muted dark:text-text-muted-dark"
                data-testid="fleet-cloud-usage-failed"
            >
                {t('failed')}
            </p>
        );
    }
    const rows = cloudUsageRows(usage);
    if (!usage || rows.length === 0) return null;
    const currency = usage.currency;

    return (
        <section
            className="rounded-lg border border-border dark:border-border-dark p-4 text-sm"
            aria-labelledby="fleet-cloud-usage-title"
            data-testid="fleet-cloud-usage"
        >
            <h3 id="fleet-cloud-usage-title" className="mb-2 flex items-center gap-2 font-semibold">
                <Cloud className="h-4 w-4" aria-hidden="true" />
                {t('title')}
            </h3>
            <p className="tabular-nums" data-testid="fleet-cloud-usage-totals">
                {t('totals', {
                    hour: hourly(usage.hourlyCents, currency),
                    month: money(usage.monthToDateCents, currency),
                    projected: money(usage.projectedMonthCents, currency),
                })}
            </p>
            {(usage.providerMonthToDate ?? []).map((figure) => (
                <p
                    key={figure.providerPluginId}
                    className="mt-1 text-xs"
                    data-testid="fleet-cloud-usage-provider-mtd"
                >
                    {t('providerMtd', {
                        provider: figure.providerName,
                        amount: money(figure.monthToDateCents, currency),
                    })}
                </p>
            ))}
            <table className="mt-3 w-full text-left text-xs tabular-nums">
                <caption className="sr-only">{t('caption')}</caption>
                <thead className="text-text-muted dark:text-text-muted-dark">
                    <tr>
                        <th scope="col" className="py-1 pr-3 font-medium">
                            {t('columns.name')}
                        </th>
                        <th scope="col" className="py-1 pr-3 font-medium">
                            {t('columns.where')}
                        </th>
                        <th scope="col" className="py-1 pr-3 font-medium">
                            {t('columns.hourly')}
                        </th>
                        <th scope="col" className="py-1 pr-3 font-medium">
                            {t('columns.month')}
                        </th>
                        <th scope="col" className="py-1 font-medium">
                            {t('columns.state')}
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr
                            key={`${row.nodeId}:${row.destroyedAt ?? ''}`}
                            data-testid="fleet-cloud-usage-row"
                        >
                            <td className="py-1 pr-3">
                                {row.destroyedAt
                                    ? t('destroyedName', {
                                          name: row.name,
                                          date: row.destroyedAt.slice(0, 10),
                                      })
                                    : row.name}
                            </td>
                            <td className="py-1 pr-3">
                                {[row.providerName, row.regionId, row.sizeLabel]
                                    .filter(Boolean)
                                    .join(' · ')}
                            </td>
                            <td className="py-1 pr-3">{hourly(row.hourlyCents, currency)}</td>
                            <td className="py-1 pr-3">{money(row.monthToDateCents, currency)}</td>
                            <td className="py-1">
                                {row.destroyedAt
                                    ? t('states.destroyed')
                                    : t(`states.${row.state}` as Parameters<typeof t>[0])}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <p className="mt-2 text-xs text-text-muted dark:text-text-muted-dark">
                {t('disclaimer')}
            </p>
        </section>
    );
}
