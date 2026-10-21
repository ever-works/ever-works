'use client';

import { useTranslations } from 'next-intl';
import { CheckSquare } from 'lucide-react';
import type { FleetSessionTaskRef } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

/**
 * Tasks on computers (FL-15 P1, spec FR-10, CONTRACTS R-22) — the session
 * card's Task chip: `T-42`, linking to the Task. The card renders it only
 * when the session's Run carries a Task.
 */
export function SessionTaskChip({ task }: { task: FleetSessionTaskRef }) {
    const t = useTranslations('fleet.taskHandoff.chip');
    return (
        <Link
            href={ROUTES.DASHBOARD_TASK(task.id)}
            className="inline-flex items-center gap-1 rounded bg-surface-secondary dark:bg-surface-secondary-dark px-1.5 py-0.5 font-mono text-[11px] text-text-secondary dark:text-text-secondary-dark hover:underline"
            title={t('title', { slug: task.slug, title: task.title })}
            aria-label={t('title', { slug: task.slug, title: task.title })}
            data-testid="fleet-session-task-chip"
        >
            <CheckSquare className="h-3 w-3" aria-hidden="true" />
            {task.slug}
        </Link>
    );
}
