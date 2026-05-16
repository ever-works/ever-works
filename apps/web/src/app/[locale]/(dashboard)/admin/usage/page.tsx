import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { adminUsageAPI, type AdminUsageResponse } from '@/lib/api/budgets';

export const metadata: Metadata = {
    title: 'Platform usage',
};

function formatCents(cents: number, currency = 'usd'): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency.toUpperCase(),
        maximumFractionDigits: 2,
    }).format(cents / 100);
}

/**
 * EW-602 — Self-hosted platform-admin view: cross-user × cross-Work
 * spend for the current billing period. Lives at /admin/usage.
 *
 * The backend's IsPlatformAdminGuard returns 403 to non-admin users.
 * Here we treat any fetch failure as "not allowed" and 404 the page,
 * which keeps the route invisible to regular users without leaking
 * its existence via a distinctive error message.
 */
export default async function AdminUsagePage() {
    const t = await getTranslations('dashboard.adminUsage');
    let data: AdminUsageResponse;
    try {
        data = await adminUsageAPI.list();
    } catch {
        notFound();
    }

    return (
        <div className="space-y-6">
            <header>
                <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h1>
                <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('description')}
                </p>
            </header>

            <div className="rounded-md p-1 border border-card-border dark:border-border-dark">
                <div className="rounded-sm p-5 bg-card dark:bg-surface-secondary-dark border border-card-border dark:border-border-dark">
                    <div className="flex items-baseline justify-between mb-4">
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {t('periodLabel', { period: data.periodLabel })}
                        </p>
                        <p className="text-sm font-medium text-text dark:text-text-dark">
                            {t('totalSpend', { amount: formatCents(data.totalSpendCents) })}
                        </p>
                    </div>

                    {data.rows.length === 0 ? (
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {t('empty')}
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-xs uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                        <th className="pb-2">{t('columnUser')}</th>
                                        <th className="pb-2">{t('columnEmail')}</th>
                                        <th className="pb-2">{t('columnWork')}</th>
                                        <th className="pb-2 text-right">{t('columnUnits')}</th>
                                        <th className="pb-2 text-right">{t('columnCost')}</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-card-border dark:divide-border-dark">
                                    {data.rows.map((row) => (
                                        <tr key={`${row.userId}:${row.workId}`}>
                                            <td className="py-2 text-text dark:text-text-dark">
                                                {row.username}
                                            </td>
                                            <td className="py-2 text-text-muted dark:text-text-muted-dark">
                                                {row.email ?? '—'}
                                            </td>
                                            <td className="py-2 text-text dark:text-text-dark">
                                                {row.workName}
                                            </td>
                                            <td className="py-2 text-right text-text dark:text-text-dark">
                                                {row.units.toLocaleString()}
                                            </td>
                                            <td className="py-2 text-right text-text dark:text-text-dark">
                                                {formatCents(row.costCents)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
