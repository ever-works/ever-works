'use client';

import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { History } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { appRuntimeOpsClient } from '@/lib/api/app-runtime-ops.client';
import type { AppDeploymentHistoryView } from '@/lib/api/app-runtime.types';
import { shortSha } from './app-ops-format';

export interface AppHistoryTableProps {
    workId: string;
    /**
     * Changes whenever the status poll sees a different current Deployment or state, so the table
     * re-reads after a deploy, a rollback or a lifecycle action — and not on every poll.
     */
    refreshKey?: string;
}

/** A Deployment state → its `history.states.*` leaf. Anything else reads "In progress". */
const STATE_LEAF = {
    READY: 'live',
    ERROR: 'failed',
    TIMEOUT: 'timedOut',
    ROLLED_BACK: 'rolledBack',
    CANCELED: 'cancelled',
    SUPERSEDED: 'skipped',
    QUEUED: 'queued',
} as const;
type StateLeaf = (typeof STATE_LEAF)[keyof typeof STATE_LEAF] | 'inProgress';

/** A trigger → its `history.triggers.*` leaf. */
const TRIGGER_LEAF = {
    manual: 'manual',
    build: 'build',
    rollback: 'rollback',
    'spec-applied': 'specApplied',
    'env-change': 'envChange',
    'domain-change': 'domainChange',
} as const;
type TriggerLeaf = (typeof TRIGGER_LEAF)[keyof typeof TRIGGER_LEAF];

function stateLeafOf(state: string): StateLeaf {
    return (STATE_LEAF as Readonly<Record<string, StateLeaf>>)[state] ?? 'inProgress';
}

function triggerLeafOf(trigger: string | null): TriggerLeaf | undefined {
    return trigger ? (TRIGGER_LEAF as Readonly<Record<string, TriggerLeaf>>)[trigger] : undefined;
}

/**
 * Lane aw-ops (APW-06 T39, spec §6.3 "History") — the last 20 Deployments: state, what started
 * it, the Build it ran (a link to the Builds tab) or the image digest, the commit, when, and a
 * smoke pass count. Visible to viewers (S28); Roll back lives in the lifecycle actions above.
 */
export function AppHistoryTable({ workId, refreshKey }: AppHistoryTableProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.history');
    const format = useFormatter();
    const [rows, setRows] = useState<AppDeploymentHistoryView[] | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void appRuntimeOpsClient.listDeployments(workId).then((result) => {
            if (cancelled) return;
            if (result.ok && Array.isArray(result.data?.deployments)) {
                setRows(result.data.deployments);
                setFailed(false);
            } else {
                setFailed(true);
                setRows((previous) => previous ?? []);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [workId, refreshKey]);

    return (
        <section
            className="space-y-2 rounded-lg border border-card-border p-4 dark:border-border-secondary-dark"
            aria-labelledby="app-history-title"
            data-testid="app-history"
        >
            <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-text-secondary" aria-hidden="true" />
                <h3
                    id="app-history-title"
                    className="text-sm font-semibold text-text dark:text-text-dark"
                >
                    {t('title')}
                </h3>
            </div>
            {rows === null ? (
                <p className="text-sm text-text-secondary">{t('loading')}</p>
            ) : failed && rows.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('error')}</p>
            ) : rows.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('empty')}</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm" data-testid="app-history-table">
                        <caption className="sr-only">{t('caption')}</caption>
                        <thead className="text-xs text-text-secondary">
                            <tr>
                                <th scope="col" className="py-1 pr-3 font-medium">
                                    {t('state')}
                                </th>
                                <th scope="col" className="py-1 pr-3 font-medium">
                                    {t('trigger')}
                                </th>
                                <th scope="col" className="py-1 pr-3 font-medium">
                                    {t('version')}
                                </th>
                                <th scope="col" className="py-1 pr-3 font-medium">
                                    {t('when')}
                                </th>
                                <th scope="col" className="py-1 font-medium">
                                    {t('smoke')}
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-card-border dark:divide-white/9">
                            {rows.map((row) => {
                                const leaf = stateLeafOf(row.state);
                                const trigger = triggerLeafOf(row.trigger);
                                const at = row.createdAt ? new Date(row.createdAt) : null;
                                return (
                                    <tr
                                        key={row.id}
                                        data-testid="app-history-row"
                                        data-state={row.state}
                                        data-current={row.current}
                                    >
                                        <td className="py-1.5 pr-3">
                                            <span
                                                className={cn(
                                                    'font-medium',
                                                    leaf === 'live'
                                                        ? 'text-emerald-700 dark:text-emerald-400'
                                                        : leaf === 'failed' || leaf === 'timedOut'
                                                          ? 'text-red-700 dark:text-red-400'
                                                          : 'text-text',
                                                )}
                                            >
                                                {t(`states.${leaf}`)}
                                            </span>
                                            {row.current && (
                                                <span className="ml-1.5 rounded bg-surface-tertiary px-1.5 text-[10px] text-text-secondary dark:bg-surface-tertiary-dark">
                                                    {t('current')}
                                                </span>
                                            )}
                                            {row.code && (
                                                <span className="block text-xs text-text-muted">
                                                    <code>{row.code}</code>
                                                </span>
                                            )}
                                        </td>
                                        <td className="py-1.5 pr-3 text-xs text-text-secondary">
                                            {trigger
                                                ? t(`triggers.${trigger}`)
                                                : (row.trigger ?? '—')}
                                        </td>
                                        <td className="py-1.5 pr-3 text-xs">
                                            {row.buildId ? (
                                                <Link
                                                    href={ROUTES.DASHBOARD_WORK_BUILDS(workId)}
                                                    className="text-primary underline-offset-2 hover:underline"
                                                >
                                                    {t('build')}
                                                </Link>
                                            ) : row.imageDigest ? (
                                                <code title={row.imageDigest}>
                                                    {shortSha(row.imageDigest)}
                                                </code>
                                            ) : null}
                                            {row.commitSha && (
                                                <code
                                                    className="ml-1.5 text-text-muted"
                                                    title={row.commitSha}
                                                >
                                                    {shortSha(row.commitSha)}
                                                </code>
                                            )}
                                        </td>
                                        <td className="py-1.5 pr-3 text-xs text-text-secondary">
                                            {at && !Number.isNaN(at.getTime())
                                                ? format.dateTime(at, {
                                                      dateStyle: 'medium',
                                                      timeStyle: 'short',
                                                  })
                                                : '—'}
                                        </td>
                                        <td className="py-1.5 text-xs text-text-secondary">
                                            {row.smoke
                                                ? t('smokeCount', {
                                                      passed: row.smoke.passed,
                                                      total: row.smoke.passed + row.smoke.failed,
                                                  })
                                                : '—'}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
