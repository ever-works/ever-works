'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { FleetLinkError, FleetUsagePricesView, FleetUsageView } from '@ever-works/contracts';
import { getFleetUsagePricesAction } from '@/app/actions/fleet/usage';

/**
 * Usage & cost on the fleet (FL-20 P3, spec U8, §0 "price list version
 * history") — the **Price list** panel at the foot of the Usage tab: which
 * version prices new figures and since when, every version ever published,
 * and the per-model rates (per million tokens, four classes) of the version
 * in effect. Figures keep the version they were priced at; the tab's
 * price-list line says when this period used an older one. Read-only; loads
 * on first open.
 */
export function UsagePriceHistory({ view }: { view: FleetUsageView }) {
    const t = useTranslations('fleet.usage.prices');
    const [open, setOpen] = useState(false);
    const [state, setState] = useState<{
        data: FleetUsagePricesView | null;
        error: FleetLinkError | null;
    } | null>(null);

    const toggle = () => {
        const next = !open;
        setOpen(next);
        if (next && !state) {
            void getFleetUsagePricesAction().then((result) =>
                setState(
                    result.ok
                        ? { data: result.data, error: null }
                        : { data: null, error: result.error },
                ),
            );
        }
    };

    const usd = (value: number) =>
        `$${value < 1 ? value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : value.toFixed(2)}`;

    return (
        <section
            className="rounded-lg border border-border dark:border-border-dark p-4 text-sm space-y-2"
            data-testid="fleet-usage-prices"
        >
            <button
                type="button"
                className="font-medium hover:underline"
                aria-expanded={open}
                onClick={toggle}
            >
                {t('title', {
                    version: view.priceList.version,
                    since: view.priceList.effectiveFrom,
                })}
            </button>
            {open && !state && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('loading')}</p>
            )}
            {open && state?.error && (
                <p role="alert" className="text-xs">
                    {state.error.hint || state.error.code}
                </p>
            )}
            {open && state?.data && (
                <div className="space-y-2">
                    <p
                        className="text-xs text-text-muted dark:text-text-muted-dark"
                        data-testid="fleet-usage-prices-history"
                    >
                        {t('history', {
                            versions: state.data.history
                                .map((entry) => `v${entry.version} (${entry.effectiveFrom})`)
                                .join(' · '),
                        })}
                    </p>
                    <table className="w-full text-xs tabular-nums">
                        <thead>
                            <tr className="text-left text-text-muted dark:text-text-muted-dark">
                                <th className="font-normal">{t('model')}</th>
                                <th className="font-normal">{t('in')}</th>
                                <th className="font-normal">{t('out')}</th>
                                <th className="font-normal">{t('cacheRead')}</th>
                                <th className="font-normal">{t('cacheWrite')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {state.data.entries.map((entry) => (
                                <tr key={entry.model}>
                                    <td className="font-mono">{entry.model}</td>
                                    <td>{usd(entry.perMillionUsd.in)}</td>
                                    <td>{usd(entry.perMillionUsd.out)}</td>
                                    <td>{usd(entry.perMillionUsd.cacheRead)}</td>
                                    <td>{usd(entry.perMillionUsd.cacheWrite)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('perMillion')}
                    </p>
                </div>
            )}
        </section>
    );
}
