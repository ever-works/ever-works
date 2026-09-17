'use client';

import { useState, useSyncExternalStore } from 'react';
import { AlertTriangle, ArrowUpRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { ScheduleHealthSummary } from '@/lib/api/schedules';

const DISMISS_KEY = 'schedules-health-banner-dismissed';

const noopSubscribe = () => () => {};

function readDismissed(): boolean {
    try {
        return window.sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch {
        return false;
    }
}

/**
 * "N schedules will never run" — above the list whenever anything is flagged.
 *
 * Only renders once health is actually known (never a flash of "0
 * problems"), dismisses for the browser session and returns on the next
 * visit while anything is still flagged. Review expands a read-only list of
 * every flagged Schedule with the reason and, where a repair is automatic,
 * the exact before and after — nothing here writes.
 */
export function ScheduleHealthBanner({
    summary,
    failed,
}: {
    summary: ScheduleHealthSummary | null;
    failed?: boolean;
}) {
    const t = useTranslations('dashboard.schedules.health');
    const tErrors = useTranslations('dashboard.schedules.errors');
    // Read the session dismissal as an external store: `false` on the server
    // and during hydration, the stored value once mounted — no mismatch and
    // no state set inside an effect.
    const storedDismissed = useSyncExternalStore(noopSubscribe, readDismissed, () => false);
    const [dismissedNow, setDismissedNow] = useState(false);
    const [reviewing, setReviewing] = useState(false);
    const dismissed = storedDismissed || dismissedNow;

    if (failed) {
        return (
            <p
                role="status"
                data-testid="schedules-health-failed"
                className="text-xs text-text-muted dark:text-text-muted-dark"
            >
                {tErrors('healthFailed')}
            </p>
        );
    }
    if (!summary || summary.counts.neverRuns === 0 || dismissed) return null;

    const dismiss = () => {
        try {
            window.sessionStorage.setItem(DISMISS_KEY, '1');
        } catch {
            // Storage unavailable — dismiss for this render only.
        }
        setDismissedNow(true);
    };

    return (
        <section
            role="status"
            data-testid="schedules-health-banner"
            className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3"
        >
            <div className="flex flex-wrap items-center gap-3">
                <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
                <p className="flex-1 text-sm font-medium text-text dark:text-text-dark">
                    {t('bannerCount', { count: summary.counts.neverRuns })}
                </p>
                <button
                    type="button"
                    data-testid="schedules-health-review"
                    aria-expanded={reviewing}
                    onClick={() => setReviewing((open) => !open)}
                    className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:underline"
                >
                    {reviewing ? t('hideReview') : t('reviewAndFix')}
                </button>
                <button
                    type="button"
                    data-testid="schedules-health-dismiss"
                    onClick={dismiss}
                    className="rounded-md px-2 py-1 text-xs font-medium text-text-secondary hover:underline dark:text-text-secondary-dark"
                >
                    {t('dismiss')}
                </button>
            </div>

            {reviewing && (
                <div className="mt-3 space-y-2" data-testid="schedules-health-review-list">
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('reviewTitle')}
                    </h3>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('reviewLead')}
                    </p>
                    <ul className="divide-y divide-border rounded-md border border-border bg-card dark:divide-border-dark dark:border-border-dark dark:bg-card-primary-dark">
                        {summary.flagged.map((flag) => (
                            <li
                                key={flag.id}
                                className="space-y-1 px-3 py-2 text-xs"
                                data-testid={`schedules-health-flag-${flag.id}`}
                            >
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium text-text dark:text-text-dark">
                                        {flag.ownerName}
                                    </span>
                                    <span className="text-danger">
                                        {t(`reasons.${flag.reasonKey}`)}
                                    </span>
                                    <Link
                                        href={flag.ownerLink}
                                        className="ml-auto inline-flex items-center gap-1 text-primary hover:underline"
                                    >
                                        {t('open')}
                                        <ArrowUpRight className="h-3 w-3" />
                                    </Link>
                                </div>
                                {flag.repair === 'automatic' ? (
                                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 font-mono text-[11px] text-text-secondary dark:text-text-secondary-dark">
                                        <dt>{t('before')}</dt>
                                        <dd>{flag.before ?? '—'}</dd>
                                        <dt>{t('after')}</dt>
                                        <dd>
                                            {flag.afterKey
                                                ? t(`repairs.${flag.afterKey}`)
                                                : (flag.after ?? '—')}
                                        </dd>
                                    </dl>
                                ) : (
                                    <p className="text-text-muted dark:text-text-muted-dark">
                                        {flag.repair === 'choice'
                                            ? t('needsDecision')
                                            : t('needsEditing')}
                                    </p>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </section>
    );
}
