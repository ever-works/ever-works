'use client';

import { useTranslations } from 'next-intl';
import type { RunLedgerGranularity } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

export type RunsEmptyVariant = 'never' | 'window' | 'filters';

/**
 * Runs ledger (AW-09) — the three empty answers, which are different
 * answers: the workspace has never run anything, nothing ran in this window,
 * or the filters exclude everything that did. The calendar controls stay on
 * screen in every case, so an empty page never looks broken.
 */
export function RunsEmptyState({
    variant,
    granularity,
    onClearFilters,
}: {
    variant: RunsEmptyVariant;
    granularity: RunLedgerGranularity;
    onClearFilters: () => void;
}) {
    const t = useTranslations('dashboard.runsPage.empty');
    const tFilters = useTranslations('dashboard.runsPage.filters');

    return (
        <div
            className="rounded-lg border border-dashed border-border/80 dark:border-border-dark/80 p-8 text-center space-y-3"
            data-testid="runs-empty"
            data-variant={variant}
        >
            {variant === 'never' && (
                <>
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('neverTitle')}
                    </p>
                    <p className="text-xs text-text-muted max-w-md mx-auto">{t('neverBody')}</p>
                    <div className="flex flex-wrap justify-center gap-2">
                        <Link
                            href={ROUTES.DASHBOARD_AGENTS}
                            className="text-xs text-primary hover:underline"
                        >
                            {t('createAgent')}
                        </Link>
                        <span className="text-text-muted">·</span>
                        <Link
                            href={`${ROUTES.DASHBOARD_ACTIVITY}?view=schedules`}
                            className="text-xs text-primary hover:underline"
                        >
                            {t('createSchedule')}
                        </Link>
                    </div>
                </>
            )}
            {variant === 'window' && (
                <>
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {granularity === 'week'
                            ? t('weekTitle')
                            : granularity === 'month'
                              ? t('monthTitle')
                              : t('dayTitle')}
                    </p>
                    <p className="text-xs text-text-muted">{t('windowBody')}</p>
                </>
            )}
            {variant === 'filters' && (
                <>
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('filtersTitle')}
                    </p>
                    <Button variant="secondary" size="sm" onClick={onClearFilters}>
                        {tFilters('clear')}
                    </Button>
                </>
            )}
        </div>
    );
}
