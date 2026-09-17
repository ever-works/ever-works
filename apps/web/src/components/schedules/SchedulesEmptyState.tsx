'use client';

import { CalendarX, SearchX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

/**
 * The two empty states of the workspace list.
 *
 *  - `nothing` — the workspace has no Schedule at all: say what a Schedule
 *    is and offer the three ways in, each to the screen that already owns
 *    that setting (a Task's recurrence, an Agent's heartbeat, a Work's
 *    update schedule).
 *  - `filtered` — the filters match nothing: say so, state the unfiltered
 *    total so the owner knows the list is not actually empty, and clear.
 */
export function SchedulesEmptyState(
    props:
        | { variant: 'nothing' }
        | { variant: 'filtered'; unfilteredTotal: number; onClear: () => void },
) {
    const t = useTranslations('dashboard.schedules');

    if (props.variant === 'filtered') {
        return (
            <div
                data-testid="schedules-empty-filtered"
                className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center dark:border-border-dark"
            >
                <SearchX
                    className="mb-3 h-6 w-6 text-text-muted dark:text-text-muted-dark"
                    aria-hidden="true"
                />
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('filters.noMatchTitle')}
                </h3>
                <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                    {t('filters.unfilteredTotal', { total: props.unfilteredTotal })}
                </p>
                <button
                    type="button"
                    onClick={props.onClear}
                    className="mt-3 text-xs font-medium text-primary hover:underline"
                >
                    {t('filters.clear')}
                </button>
            </div>
        );
    }

    const links = [
        { href: ROUTES.DASHBOARD_TASKS, label: t('emptyWorkspace.recurringTask') },
        { href: ROUTES.DASHBOARD_AGENTS, label: t('emptyWorkspace.heartbeat') },
        { href: ROUTES.DASHBOARD_WORKS, label: t('emptyWorkspace.workUpdates') },
    ];

    return (
        <div
            data-testid="schedules-empty-nothing"
            className="flex flex-col items-center justify-center py-16 text-center"
        >
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-secondary dark:bg-surface-secondary-dark">
                <CalendarX
                    className="h-7 w-7 text-text-muted dark:text-text-muted-dark"
                    aria-hidden="true"
                />
            </div>
            <h3 className="mb-1 text-lg font-semibold text-text dark:text-text-dark">
                {t('empty.title')}
            </h3>
            <p className="max-w-md text-sm text-text-muted dark:text-text-muted-dark">
                {t('emptyWorkspace.description')}
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
                {links.map((link) => (
                    <Link
                        key={link.href}
                        href={link.href}
                        className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text hover:bg-surface-secondary dark:border-border-dark dark:text-text-dark dark:hover:bg-surface-secondary-dark"
                    >
                        {link.label}
                    </Link>
                ))}
            </div>
        </div>
    );
}
