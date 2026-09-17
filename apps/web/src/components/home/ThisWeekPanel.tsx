'use client';

import { Wallet } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import type { HomeBlock, HomeSpend } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { HomeBlockShell } from './HomeBlockShell';
import { formatCount, HOME_SPEND_WINDOW_DAYS, homeCapTone } from './home.shared';

/** The costs surface with the 7-day window already selected. */
export const HOME_MANAGE_SPEND_HREF = `${ROUTES.DASHBOARD_USAGE_COSTS}&windowDays=${HOME_SPEND_WINDOW_DAYS}`;

/** Where the account-wide cap is set. */
export const HOME_SET_CAP_HREF = `${ROUTES.DASHBOARD_SETTINGS_WORK_AGENT}#account-budgets`;

const CAP_TONE_CLASS = {
    neutral: 'bg-primary',
    warning: 'bg-warning',
    danger: 'bg-danger',
} as const;

interface ThisWeekPanelProps {
    block: HomeBlock<HomeSpend> | undefined;
    /** The active Organization's name; null in personal scope or while unknown. */
    organizationName: string | null;
    onRetry?: () => void;
}

/**
 * Home (AW-19) — the last 7 days of AI spend in the active scope, and —
 * visually separate and always labelled account-wide — how far this billing
 * period has eaten into the account-wide cap. The cap is enforced across every
 * Organization, so it is never presented as a share of the scoped headline.
 *
 * Renders nothing for an account that has never recorded any spend.
 */
export function ThisWeekPanel({ block, organizationName, onRetry }: ThisWeekPanelProps) {
    const t = useTranslations('dashboard.home');
    const format = useFormatter();
    const data = block?.status === 'ok' ? block.data : null;

    if (data && !data.everSpent) return null;

    const state = !block ? 'loading' : block.status === 'failed' || !data ? 'failed' : 'ready';
    const money = (cents: number) =>
        format.number(cents / 100, {
            style: 'currency',
            currency: (data?.currency || 'usd').toUpperCase(),
        });
    const scope =
        data?.scope.kind === 'organization'
            ? (organizationName ?? t('thisWeek.organizationScope'))
            : t('thisWeek.personalScope');

    const cap = data?.accountCap;
    const percent = cap && cap.percentUsed !== null ? Math.max(0, cap.percentUsed) : null;
    const tone = percent !== null ? homeCapTone(percent) : 'neutral';

    return (
        <HomeBlockShell
            blockId="thisWeek"
            title={t('thisWeek.title')}
            icon={Wallet}
            state={state}
            failedLabel={t('block.names.thisWeek')}
            onRetry={onRetry}
            skeletonRows={3}
            headerAction={
                <Link
                    href={HOME_MANAGE_SPEND_HREF}
                    aria-describedby="home-this-week-manage-description"
                    className="font-medium text-primary hover:underline"
                >
                    {t('thisWeek.manage')} →
                    <span id="home-this-week-manage-description" className="sr-only">
                        {t('thisWeek.manageDescription')}
                    </span>
                </Link>
            }
        >
            {data && cap ? (
                <div>
                    <p
                        className="text-2xl font-semibold tabular-nums text-text dark:text-text-dark"
                        data-testid="home-this-week-total"
                    >
                        {money(data.totalCents)}
                    </p>
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                        {t('thisWeek.window', { scope })}
                    </p>
                    <p className="mt-1 text-sm text-text dark:text-text-dark">
                        {t('thisWeek.runs', {
                            count: data.runsCount,
                            avg:
                                data.avgPerRunCents === null
                                    ? t('thisWeek.noAverage')
                                    : money(data.avgPerRunCents),
                        })}
                    </p>

                    <div
                        className="mt-3 border-t border-border/40 pt-3 dark:border-white/8"
                        data-testid="home-this-week-cap"
                    >
                        {percent !== null ? (
                            <>
                                <div
                                    role="meter"
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={Math.min(100, Math.round(percent))}
                                    aria-label={t('thisWeek.capBar', {
                                        percent: formatCount(Math.round(percent)),
                                    })}
                                    data-tone={tone}
                                    className="h-2 w-full overflow-hidden rounded-full bg-surface-secondary dark:bg-white/8"
                                >
                                    <div
                                        className={cn('h-full rounded-full', CAP_TONE_CLASS[tone])}
                                        style={{ width: `${Math.min(100, percent)}%` }}
                                    />
                                </div>
                                <p
                                    className={cn(
                                        'mt-1 text-xs',
                                        tone === 'danger'
                                            ? 'text-danger'
                                            : tone === 'warning'
                                              ? 'text-warning'
                                              : 'text-text-secondary dark:text-text-secondary-dark',
                                    )}
                                >
                                    {t('thisWeek.capBar', {
                                        percent: formatCount(Math.round(percent)),
                                    })}
                                </p>
                                {percent >= 100 ? (
                                    <p className="text-xs font-medium text-text dark:text-text-dark">
                                        {cap.blocked
                                            ? t('thisWeek.blocked')
                                            : t('thisWeek.overage')}
                                    </p>
                                ) : null}
                            </>
                        ) : (
                            <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                {t('thisWeek.noCap')}{' '}
                                <Link
                                    href={HOME_SET_CAP_HREF}
                                    className="font-medium text-primary hover:underline"
                                >
                                    {t('thisWeek.setCap')} →
                                </Link>
                            </p>
                        )}
                        <p className="mt-1 text-[11px] text-text-muted dark:text-text-muted-dark">
                            {t('thisWeek.capScopeNote')}
                        </p>
                    </div>
                </div>
            ) : null}
        </HomeBlockShell>
    );
}
