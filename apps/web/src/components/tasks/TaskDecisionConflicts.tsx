'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { ExternalLink, ScrollText } from 'lucide-react';
import type { DecisionConflictDto } from '@ever-works/contracts';
import { getTaskDecisionConflictsAction } from '@/app/actions/tasks';

/**
 * Re-litigation guard (memory upgrades M6) — the Task-side surface.
 *
 * Lists the `class=decision, status=accepted` Knowledge Base documents
 * that this Task's title + description appear to re-open, as computed by
 * the API's deterministic `term-overlap/v1` heuristic (no LLM, no
 * embeddings — see `DecisionConflictService`).
 *
 * **Informational only.** Nothing here blocks, disables, or gates any
 * Task action; the banner exists so the operator finds out that the
 * question is already settled BEFORE spending a run on it, and can click
 * straight through to the decision to read the rationale.
 *
 * It re-checks whenever `refreshKey` changes — the Task detail client
 * bumps that after a description save, which is exactly the "or its
 * description is edited" half of the requirement.
 */

export interface TaskDecisionConflictsProps {
    readonly taskId: string;
    /** Bump to re-run the check (e.g. after the description is saved). */
    readonly refreshKey?: number;
    /**
     * Pre-computed conflicts. When provided the component renders them
     * directly and skips the initial fetch — used by the unit specs.
     */
    readonly initialConflicts?: DecisionConflictDto[];
}

export function TaskDecisionConflicts({
    taskId,
    refreshKey = 0,
    initialConflicts,
}: TaskDecisionConflictsProps) {
    const t = useTranslations('dashboard.tasksPage.decisionConflicts');
    const [conflicts, setConflicts] = useState<DecisionConflictDto[]>(initialConflicts ?? []);

    useEffect(() => {
        // The very first render uses `initialConflicts` when supplied;
        // every explicit refresh still re-fetches.
        if (initialConflicts !== undefined && refreshKey === 0) return;
        let cancelled = false;
        void (async () => {
            const report = await getTaskDecisionConflictsAction(taskId);
            if (cancelled) return;
            setConflicts(report.conflicts ?? []);
        })();
        return () => {
            cancelled = true;
        };
    }, [taskId, refreshKey, initialConflicts]);

    // Silent by default — the overwhelmingly common case is "no settled
    // decision touches this Task", and a banner that renders an empty
    // state would be pure noise on every Task page.
    if (conflicts.length === 0) return null;

    return (
        <section
            data-testid="task-decision-conflicts"
            role="status"
            className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4"
        >
            <div className="flex items-center gap-2">
                <ScrollText
                    className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300"
                    aria-hidden="true"
                />
                <h2 className="text-sm font-medium text-amber-900 dark:text-amber-200">
                    {t('title', { count: conflicts.length })}
                </h2>
            </div>
            <p className="mt-1 text-xs text-amber-800/90 dark:text-amber-200/80">{t('subtitle')}</p>
            <ul className="mt-3 space-y-2">
                {conflicts.map((conflict) => (
                    <li
                        key={conflict.documentId}
                        data-testid={`task-decision-conflict-${conflict.documentId}`}
                        data-signal={conflict.signal}
                        className="rounded-lg border border-amber-500/30 bg-card/60 p-2.5 dark:bg-card-primary-dark/40"
                    >
                        <div className="flex items-start gap-2">
                            <span
                                className={cn(
                                    'mt-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                                    conflict.signal === 'strong'
                                        ? 'bg-amber-500/25 text-amber-900 dark:text-amber-200'
                                        : 'bg-amber-500/10 text-amber-800 dark:text-amber-300/90',
                                )}
                            >
                                {t(`signal.${conflict.signal}`)}
                            </span>
                            <div className="min-w-0 flex-1">
                                {conflict.workId ? (
                                    <Link
                                        href={`${ROUTES.DASHBOARD_WORK_KB(conflict.workId)}/${conflict.path}`}
                                        data-testid={`task-decision-conflict-${conflict.documentId}-link`}
                                        className="inline-flex items-center gap-1 text-sm font-medium text-text hover:underline dark:text-text-dark"
                                    >
                                        {conflict.title}
                                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                                    </Link>
                                ) : (
                                    <span className="text-sm font-medium text-text dark:text-text-dark">
                                        {conflict.title}
                                    </span>
                                )}
                                {conflict.rationale ? (
                                    <p className="mt-0.5 text-xs text-text-secondary dark:text-text-secondary-dark/80">
                                        {conflict.rationale}
                                    </p>
                                ) : null}
                                {conflict.overlapTerms.length > 0 ? (
                                    <p className="mt-0.5 text-[11px] text-text-muted dark:text-text-muted-dark/70">
                                        {t('overlap', {
                                            terms: conflict.overlapTerms.slice(0, 6).join(', '),
                                        })}
                                    </p>
                                ) : null}
                            </div>
                        </div>
                    </li>
                ))}
            </ul>
            <p className="mt-3 text-[11px] text-amber-800/80 dark:text-amber-200/70">
                {t('advisory')}
            </p>
        </section>
    );
}
