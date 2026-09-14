'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, X } from 'lucide-react';
import type { RunReceipt } from '@ever-works/contracts';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { getRunReceiptAction } from '@/app/actions/runs';
import { RunOutcomeBadge, useRunTriggerLabel } from './RunOutcomeBadge';
import { RunReceiptView } from './RunReceiptView';
import { formatRunDuration, runElapsedMs } from './runs.shared';

/** What has been fetched, keyed by the run it belongs to. */
type Loaded = { runId: string; receipt: RunReceipt | null };

/**
 * Run receipt drawer (AW-09) — opens over the ledger without leaving the
 * page. The dialog traps focus while open, closes on Esc, and hands focus
 * back to the row that opened it.
 *
 * A run the viewer cannot read renders the same "does not exist, or you do
 * not have access" copy as a run that never existed.
 */
export function RunReceiptPanel({
    runId,
    timeZone,
    onClose,
}: {
    runId: string | null;
    timeZone: string;
    onClose: () => void;
}) {
    const t = useTranslations('dashboard.runsPage');
    const triggerLabel = useRunTriggerLabel();
    const [loaded, setLoaded] = useState<Loaded | null>(null);

    useEffect(() => {
        if (!runId) return;
        let cancelled = false;
        getRunReceiptAction(runId)
            .then((receipt) => {
                if (!cancelled) setLoaded({ runId, receipt });
            })
            .catch(() => {
                if (!cancelled) setLoaded({ runId, receipt: null });
            });
        return () => {
            cancelled = true;
        };
    }, [runId]);

    // Anything fetched for a different run is stale: show loading instead.
    const current = loaded && loaded.runId === runId ? loaded : null;
    const state = !current
        ? ({ status: 'loading' } as const)
        : current.receipt
          ? ({ status: 'ready', receipt: current.receipt } as const)
          : ({ status: 'missing' } as const);
    const row = state.status === 'ready' ? state.receipt.row : null;
    const elapsed = row ? formatRunDuration(runElapsedMs(row)) : null;
    const started = row?.startedAt ?? row?.createdAt ?? null;

    return (
        <Dialog open={runId !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
                <div className="flex items-start justify-between gap-4 mb-4">
                    <div className="min-w-0 space-y-1">
                        <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                            {t('receipt.title')}
                        </DialogTitle>
                        {row && (
                            <p
                                className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary dark:text-text-secondary-dark"
                                data-testid="run-receipt-header"
                            >
                                <RunOutcomeBadge status={row.status} />
                                <span className="font-medium text-text dark:text-text-dark">
                                    {row.agentName ?? t('table.unknownAgent')}
                                </span>
                                <span>·</span>
                                <span>{triggerLabel(row.triggerKind)}</span>
                                {started && (
                                    <>
                                        <span>·</span>
                                        <time dateTime={started} className="tabular-nums">
                                            {new Date(started).toLocaleString(undefined, {
                                                timeZone,
                                                month: 'short',
                                                day: 'numeric',
                                                hour: '2-digit',
                                                minute: '2-digit',
                                            })}
                                        </time>
                                    </>
                                )}
                                {elapsed && (
                                    <>
                                        <span>·</span>
                                        <span className="tabular-nums">{elapsed}</span>
                                    </>
                                )}
                            </p>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="shrink-0 rounded p-1 text-text-muted hover:text-text dark:hover:text-text-dark"
                        aria-label={t('receipt.close')}
                        data-testid="run-receipt-close"
                    >
                        <X className="w-4 h-4" aria-hidden />
                    </button>
                </div>

                {state.status === 'loading' && (
                    <p
                        className="flex items-center gap-2 text-xs text-text-muted"
                        role="status"
                        data-testid="run-receipt-loading"
                    >
                        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
                        {t('receipt.loading')}
                    </p>
                )}
                {state.status === 'missing' && (
                    <p className="text-sm text-text-secondary" data-testid="run-receipt-missing">
                        {t('errors.notFound')}
                    </p>
                )}
                {state.status === 'ready' && <RunReceiptView receipt={state.receipt} />}
            </DialogContent>
        </Dialog>
    );
}
