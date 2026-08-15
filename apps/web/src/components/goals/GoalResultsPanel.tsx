'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { GoalSession } from '@/lib/api/goals';
import { formatDateTime } from './goal-ui';
import { formatCents } from './goal-loop-ui';

/**
 * Autonomy layer — the Results tab: the latest session's summary.
 *
 * The summary is agent-authored markdown-ish prose. It is rendered as
 * PRE-WRAPPED TEXT rather than through a markdown renderer on purpose:
 * this string comes from a model, and handing untrusted model output to
 * an HTML renderer on a page that also carries operator controls is not a
 * trade worth making for slightly nicer headings.
 */
export function GoalResultsPanel({ sessions }: { sessions: GoalSession[] }) {
    const t = useTranslations('dashboard.goalDetail.results');

    // Sessions arrive oldest-first (creation order); the newest one that
    // actually produced a summary is what "latest result" means. A newer
    // run that crashed before summarizing must not hide the last real one.
    const latest = [...sessions].reverse().find((session) => Boolean(session.summary));

    if (!latest) {
        return (
            <div className="rounded-lg border border-dashed border-border/70 dark:border-border-dark/70 p-8 text-center">
                <p className="text-sm font-medium text-text dark:text-text-dark">{t('empty')}</p>
                <p className="mx-auto mt-1 max-w-xl text-xs text-text-muted dark:text-text-muted-dark">
                    {t('emptyHint')}
                </p>
            </div>
        );
    }

    return (
        <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                    {latest.iteration !== null
                        ? t('titleWithIteration', { n: latest.iteration })
                        : t('title')}
                </h2>
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-text-muted dark:text-text-muted-dark">
                    {latest.finishedAt ? (
                        <time dateTime={latest.finishedAt} suppressHydrationWarning>
                            {formatDateTime(latest.finishedAt)}
                        </time>
                    ) : null}
                    <span>
                        {t('cost')}: {formatCents(latest.costCents)}
                    </span>
                    <Link href={`/tasks/${latest.taskId}`} className="text-info hover:underline">
                        {latest.taskSlug}
                    </Link>
                </div>
            </div>
            <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-text-secondary dark:text-text-secondary-dark">
                {latest.summary}
            </pre>
        </section>
    );
}
