'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { TaskRunContainmentView } from '@ever-works/contracts';
import { allowAppRunContainmentAction } from '@/app/actions/dashboard/app-changes';

/**
 * APW-08 T27's additive item (T48 / T12; FR-12, FR-70, S33, ACC-08-34) — the containment a Fleet
 * run of this App Work Task got, its downgrades, and **Allow on this machine**, mounted inside
 * `TaskCostSection` beside the run receipts.
 *
 * Two inputs, both from `GET /api/tasks/:id/cost`:
 *
 * - `holds` — the nodes whose own latest report holds this Task's NEXT run (`needs_input`):
 *   each shows `appRules.containmentDowngrade` and **Allow on this machine**, which calls
 *   `POST /api/works/:id/app-runs/allow-containment { nodeId, allow: true }`. A node that never
 *   reported reads as such — an unknown containment is treated as a downgrade.
 * - `containment` — what the latest Fleet run got: the execution path, whether the isolated home
 *   applied, every downgrade the node declared, and — when the owner allowed that node — the
 *   allowance with **Withdraw** (`allow: false`).
 *
 * Every state is text, never colour alone; a downgrade list is a real list; the action reports its
 * progress and failure in a polite live region (FR-71). After a successful change the section
 * reloads (`onChanged`), so the notice always shows what the API now says.
 */
export function TaskRunContainmentNotice({
    workId,
    containment,
    holds,
    onChanged,
}: {
    workId: string | null | undefined;
    containment: TaskRunContainmentView | null | undefined;
    holds: TaskRunContainmentView[] | null | undefined;
    onChanged?: () => void;
}) {
    const t = useTranslations('dashboard.tasksPage.cost.containment');
    const tRules = useTranslations('dashboard.tasksPage.appRules');
    const [pending, setPending] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);

    const held = (holds ?? []).filter((hold) => hold.nodeId);
    if (!containment && held.length === 0) return null;

    const nodeLabel = (view: TaskRunContainmentView) => view.nodeName?.trim() || t('unknownMachine');

    const change = async (nodeId: string, allow: boolean) => {
        if (!workId || pending) return;
        setPending(nodeId);
        setFailed(false);
        try {
            const result = await allowAppRunContainmentAction(workId, nodeId, allow);
            if (result.success) {
                onChanged?.();
            } else {
                setFailed(true);
            }
        } catch {
            setFailed(true);
        } finally {
            setPending(null);
        }
    };

    const record = (view: TaskRunContainmentView) => (
        <div className="space-y-1">
            {!view.reported ? (
                <p data-testid="task-containment-not-reported">{t('notReported')}</p>
            ) : (
                <>
                    <p data-testid="task-containment-path">
                        {view.executionPath === 'hardened' ? t('pathHardened') : t('pathOrdinary')}
                        {' · '}
                        <span data-testid="task-containment-isolated-home">
                            {view.isolatedHome ? t('isolatedHomeApplied') : t('isolatedHomeNotApplied')}
                        </span>
                    </p>
                    {view.downgrades.length === 0 ? (
                        <p className="text-text-muted dark:text-text-muted-dark">{t('noDowngrades')}</p>
                    ) : (
                        <div>
                            <p className="text-text-muted dark:text-text-muted-dark">{t('downgrades')}</p>
                            <ul className="list-disc pl-5" data-testid="task-containment-downgrades">
                                {view.downgrades.map((entry, index) => (
                                    <li key={`${entry.control}-${index}`} data-testid="task-containment-downgrade">
                                        <span className="font-mono">{entry.control}</span>: {entry.reason}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </>
            )}
        </div>
    );

    return (
        <div
            className="space-y-3 border-t border-border/40 dark:border-border-dark/40 pt-3"
            data-testid="task-run-containment-notice"
        >
            <h3 className="text-xs font-medium text-text dark:text-text-dark">{t('title')}</h3>

            {held.map((hold) => (
                <div
                    key={`hold-${hold.nodeId}`}
                    className="space-y-2 rounded-lg border border-border/60 dark:border-border-dark/60 p-3"
                    data-testid="task-containment-hold"
                    data-node-id={hold.nodeId ?? ''}
                >
                    <p className="font-medium" data-testid="task-containment-hold-copy">
                        {tRules('containmentDowngrade')}
                    </p>
                    <p className="text-text-muted dark:text-text-muted-dark">
                        {t('nextRun', { node: nodeLabel(hold) })}
                    </p>
                    {record(hold)}
                    {workId && (
                        <button
                            type="button"
                            onClick={() => void change(hold.nodeId as string, true)}
                            disabled={pending !== null}
                            aria-busy={pending === hold.nodeId}
                            className="inline-flex items-center rounded-md border border-border dark:border-border-dark px-3 py-1.5 text-xs font-medium text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
                            data-testid="task-containment-allow"
                        >
                            {pending === hold.nodeId ? t('saving') : tRules('allowOnThisMachine')}
                        </button>
                    )}
                </div>
            ))}

            {containment && (
                <div className="space-y-2" data-testid="task-containment-record">
                    <p className="text-text-muted dark:text-text-muted-dark">
                        {t('lastRun', { node: nodeLabel(containment) })}
                    </p>
                    {record(containment)}
                    {containment.allowedByOwner && containment.nodeId && (
                        <div className="flex flex-wrap items-center gap-2" data-testid="task-containment-allowed">
                            <span>{t('allowed')}</span>
                            {containment.acceptedDowngrade && (
                                <span
                                    className="text-text-muted dark:text-text-muted-dark"
                                    data-testid="task-containment-accepted"
                                >
                                    {t('acceptedDowngrade', { reason: containment.acceptedDowngrade })}
                                </span>
                            )}
                            {workId && (
                                <button
                                    type="button"
                                    onClick={() => void change(containment.nodeId as string, false)}
                                    disabled={pending !== null}
                                    aria-busy={pending === containment.nodeId}
                                    className="text-xs font-medium text-text-muted hover:text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
                                    data-testid="task-containment-withdraw"
                                >
                                    {pending === containment.nodeId ? t('saving') : t('withdraw')}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}

            <p className="text-text-muted dark:text-text-muted-dark" data-testid="task-containment-real-home">
                {t('realHome')}
            </p>

            <p role="status" aria-live="polite" className="text-xs" data-testid="task-containment-status">
                {failed ? t('saveFailed') : ''}
            </p>
        </div>
    );
}
