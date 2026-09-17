'use client';

import { useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { GitFork, Play, RotateCcw } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { reactivateWorkflowAction, runWorkflowAction } from '@/app/actions/workflows';
import type { CatalogWorkflowCard } from './catalog-data';

type RowFeedback = { tone: 'ok' | 'error'; text: string };

const STATUS_TONE: Record<CatalogWorkflowCard['status'], string> = {
    active: 'bg-success/10 text-success',
    draft: 'bg-surface-secondary dark:bg-white/9 text-text-secondary dark:text-text-secondary-dark',
    archived: 'bg-warning/10 text-warning',
};

/**
 * Saved workflow graphs with their status, size, run count and last run.
 * `Run` starts a run over the existing workflow API and shows the queued run
 * id as soon as it is accepted; an archived workflow offers `Reactivate`
 * instead, since running one is refused.
 */
export function WorkflowList({ workflows }: { workflows: readonly CatalogWorkflowCard[] }) {
    const t = useTranslations('dashboard.catalogPage.workflows');
    const format = useFormatter();
    const router = useRouter();
    const [pendingId, setPendingId] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<Record<string, RowFeedback>>({});
    const [, startTransition] = useTransition();

    const setRowFeedback = (id: string, value: RowFeedback) =>
        setFeedback((current) => ({ ...current, [id]: value }));

    const run = (workflow: CatalogWorkflowCard) => {
        setPendingId(workflow.id);
        startTransition(async () => {
            const result = await runWorkflowAction(workflow.id);
            setPendingId(null);
            if (result.success) {
                // The API records a run even when the job runtime refuses it,
                // and marks that run failed rather than leaving it queued.
                const id = result.runId.slice(0, 8);
                setRowFeedback(
                    workflow.id,
                    result.status === 'failed'
                        ? { tone: 'error', text: t('runNotQueued', { id }) }
                        : { tone: 'ok', text: t('queued', { id }) },
                );
                router.refresh();
            } else {
                setRowFeedback(workflow.id, {
                    tone: 'error',
                    text: result.archived
                        ? t('archivedRefused')
                        : t('runFailedToStart', { reason: result.error }),
                });
            }
        });
    };

    const reactivate = (workflow: CatalogWorkflowCard) => {
        setPendingId(workflow.id);
        startTransition(async () => {
            const result = await reactivateWorkflowAction(workflow.id);
            setPendingId(null);
            if (result.success) {
                router.refresh();
            } else {
                setRowFeedback(workflow.id, {
                    tone: 'error',
                    text: t('reactivateFailed', { reason: result.error }),
                });
            }
        });
    };

    return (
        <ul
            data-testid="workflow-list"
            className="divide-y divide-border dark:divide-border-dark rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark"
        >
            {workflows.map((workflow) => {
                const row = feedback[workflow.id];
                const busy = pendingId === workflow.id;
                return (
                    <li
                        key={workflow.id}
                        data-testid="workflow-row"
                        data-workflow-id={workflow.id}
                        className="flex flex-wrap items-center gap-3 px-4 py-3"
                    >
                        <GitFork className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                            <Link
                                href={ROUTES.DASHBOARD_CATALOG_WORKFLOW(workflow.id)}
                                data-catalog-card
                                className="text-sm font-medium text-text dark:text-text-dark hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                            >
                                {workflow.name}
                            </Link>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('nodes', { count: workflow.nodeCount })} ·{' '}
                                {t('runs', { count: workflow.runCount })} ·{' '}
                                {workflow.lastRunAt
                                    ? t('lastRun', {
                                          when: format.relativeTime(new Date(workflow.lastRunAt)),
                                      })
                                    : t('neverRun')}
                            </p>
                            {row && (
                                <p
                                    role="status"
                                    data-testid="workflow-row-feedback"
                                    className={cn(
                                        'mt-1 text-xs',
                                        row.tone === 'ok' ? 'text-success' : 'text-danger',
                                    )}
                                >
                                    {row.text}
                                </p>
                            )}
                        </div>
                        <span
                            data-testid="workflow-status"
                            className={cn(
                                'rounded-full px-2 py-0.5 text-xs font-medium',
                                STATUS_TONE[workflow.status],
                            )}
                        >
                            {t(`status.${workflow.status}`)}
                        </span>
                        {workflow.status === 'archived' ? (
                            <button
                                type="button"
                                onClick={() => reactivate(workflow)}
                                disabled={busy}
                                className="inline-flex items-center gap-1 rounded-md border border-border dark:border-border-dark px-3 py-1 text-xs font-medium hover:bg-surface-secondary dark:hover:bg-white/9 disabled:opacity-50"
                            >
                                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                                {t('reactivate')}
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={() => run(workflow)}
                                disabled={busy}
                                aria-label={t('runAria', { name: workflow.name })}
                                className="inline-flex items-center gap-1 rounded-md bg-button-primary dark:bg-white px-3 py-1 text-xs font-medium text-button-primary-foreground dark:text-gray-900 disabled:opacity-50"
                            >
                                <Play className="h-3 w-3" aria-hidden="true" />
                                {busy ? t('running') : t('run')}
                            </button>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}
