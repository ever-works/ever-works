'use client';

import { useFormatter, useTranslations } from 'next-intl';
import type { AppStatusSnapshotView } from '@/lib/api/app-runtime.types';
import { useClientNow } from './app-ops-format';

export interface AppCronListProps {
    cron: AppStatusSnapshotView['cron'];
}

/**
 * Lane aw-ops (APW-06 T38, FR-46) — each scheduled call's last run and its result. Read-only:
 * a scheduled call runs on its own schedule.
 */
export function AppCronList({ cron }: AppCronListProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.cron');
    const format = useFormatter();
    const now = useClientNow();

    if (cron.length === 0) return null;

    const when = (iso?: string) => {
        if (!iso || now === null) return null;
        const at = new Date(iso);
        return Number.isNaN(at.getTime()) ? null : format.relativeTime(at, now);
    };

    return (
        <ul
            className="divide-y divide-card-border text-sm dark:divide-white/9"
            data-testid="app-cron-list"
        >
            {cron.map((entry) => {
                const scheduled = when(entry.lastScheduleAt);
                const succeeded = when(entry.lastSuccessAt);
                return (
                    <li
                        key={entry.name}
                        className="flex flex-wrap items-center justify-between gap-2 py-1.5"
                        data-testid="app-cron-row"
                    >
                        <code className="text-xs font-semibold">{entry.name}</code>
                        <span className="text-xs text-text-secondary">
                            {scheduled ? t('lastRun', { when: scheduled }) : t('neverRun')}
                            {succeeded ? ` · ${t('lastSuccess', { when: succeeded })}` : ''}
                            {entry.lastResult ? ` · ${entry.lastResult}` : ''}
                        </span>
                    </li>
                );
            })}
        </ul>
    );
}
