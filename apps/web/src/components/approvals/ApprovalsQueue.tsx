'use client';

import { useMemo, useState } from 'react';
import { Check, Loader2, ShieldAlert, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { AgentActionProposal, AgentActionRiskFlag } from '@/lib/api/agent-approvals';
import {
    approveAllProposalsAction,
    approveProposalAction,
    rejectProposalAction,
} from '@/app/actions/dashboard/agent-approvals';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';

interface ApprovalsQueueProps {
    initialApprovals: AgentActionProposal[];
}

const RISK_FLAG_CLASSES: Record<AgentActionRiskFlag, string> = {
    budget_override:
        'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300 border-amber-200 dark:border-amber-500/25',
    destructive:
        'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300 border-red-200 dark:border-red-500/25',
    cross_scope:
        'bg-purple-100 text-purple-800 dark:bg-purple-500/15 dark:text-purple-300 border-purple-200 dark:border-purple-500/25',
    high_fanout:
        'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300 border-blue-200 dark:border-blue-500/25',
};

export function ApprovalsQueue({ initialApprovals }: ApprovalsQueueProps) {
    const t = useTranslations('dashboard.approvals');
    const [proposals, setProposals] = useState(initialApprovals);
    // Explicit per-row submitting state (not useTransition) so each row's
    // buttons disable independently while its decision is in flight.
    // Keyed on id → action so only the clicked button shows a spinner
    // (its sibling is disabled but keeps its idle icon).
    const [submittingActions, setSubmittingActions] = useState<
        Record<string, 'approve' | 'reject'>
    >({});
    const [isApprovingAll, setIsApprovingAll] = useState(false);

    const pendingIds = useMemo(() => proposals.map((p) => p.id), [proposals]);

    // Parent only mounts this block when the queue is non-empty, but keep
    // the guard so it disappears cleanly once the last row is decided.
    if (proposals.length === 0) {
        return null;
    }

    const setSubmitting = (id: string, action: 'approve' | 'reject' | null) =>
        setSubmittingActions((prev) => {
            const next = { ...prev };
            if (action) {
                next[id] = action;
            } else {
                delete next[id];
            }
            return next;
        });

    const removeRow = (id: string) => setProposals((prev) => prev.filter((p) => p.id !== id));

    const handleApprove = async (id: string) => {
        if (submittingActions[id] || isApprovingAll) return;
        setSubmitting(id, 'approve');
        try {
            await approveProposalAction(id);
            removeRow(id);
            toast.success(t('toast.approved'));
        } catch {
            toast.error(t('toast.error'));
        } finally {
            setSubmitting(id, null);
        }
    };

    const handleReject = async (id: string) => {
        if (submittingActions[id] || isApprovingAll) return;
        setSubmitting(id, 'reject');
        try {
            await rejectProposalAction(id);
            removeRow(id);
            toast.success(t('toast.rejected'));
        } catch {
            toast.error(t('toast.error'));
        } finally {
            setSubmitting(id, null);
        }
    };

    const handleApproveAll = async () => {
        if (isApprovingAll || pendingIds.length === 0) return;
        setIsApprovingAll(true);
        try {
            const { approved, skipped } = await approveAllProposalsAction(pendingIds);
            // Approved rows AND skipped (concurrently-decided) rows are
            // both no longer pending — clear every row we sent.
            const sent = new Set(pendingIds);
            setProposals((prev) => prev.filter((p) => !sent.has(p.id)));
            if (skipped > 0) {
                toast.success(t('toast.bulkApprovedSkipped', { approved, skipped }));
            } else {
                toast.success(t('toast.bulkApproved', { count: approved }));
            }
        } catch {
            toast.error(t('toast.error'));
        } finally {
            setIsApprovingAll(false);
        }
    };

    return (
        <section aria-labelledby="approvals-queue-heading" data-testid="approvals-queue">
            <div className="flex flex-nowrap items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2 min-w-0">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-surface-secondary dark:bg-white/6 border border-border/50 dark:border-white/10 flex items-center justify-center">
                        <ShieldAlert className="w-4 h-4 text-text-secondary dark:text-text-secondary-dark" />
                    </div>
                    <h2
                        id="approvals-queue-heading"
                        className="text-xl font-semibold text-text dark:text-text-dark truncate"
                    >
                        {t('header.title')}
                    </h2>
                    <span className="shrink-0 inline-flex items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-semibold px-2 py-0.5">
                        {proposals.length}
                    </span>
                </div>
                <div className="flex flex-nowrap items-center gap-2 shrink-0">
                    <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={handleApproveAll}
                        disabled={isApprovingAll}
                        data-testid="approval-approve-all"
                        className="gap-1.5"
                    >
                        {isApprovingAll ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <Check className="w-3.5 h-3.5" />
                        )}
                        {t('actions.approveAll')}
                    </Button>
                </div>
            </div>

            <p className="mb-3 text-sm text-text-secondary dark:text-text-secondary-dark">
                {t('header.subtitle')}
            </p>

            <ul className="flex flex-col gap-3">
                {proposals.map((p) => {
                    const rowAction = submittingActions[p.id];
                    const busy = Boolean(rowAction) || isApprovingAll;
                    return (
                        <li
                            key={p.id}
                            data-testid={`approval-row-${p.id}`}
                            className="rounded-lg border border-card-border dark:border-white/9 bg-card dark:bg-card-primary-dark/70 p-4"
                        >
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="inline-flex items-center rounded-md border border-border/60 dark:border-border-dark/60 px-1.5 py-0.5 text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark">
                                            {t(`actionType.${p.actionType}`)}
                                        </span>
                                        {p.riskFlags.map((flag) => (
                                            <span
                                                key={flag}
                                                className={cn(
                                                    'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium',
                                                    RISK_FLAG_CLASSES[flag],
                                                )}
                                            >
                                                {t(`riskFlags.${flag}`)}
                                            </span>
                                        ))}
                                    </div>
                                    <p className="mt-2 text-sm font-medium text-text dark:text-text-dark break-words">
                                        {p.title}
                                    </p>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="secondary"
                                        onClick={() => handleReject(p.id)}
                                        disabled={busy}
                                        data-testid={`approval-reject-${p.id}`}
                                        className="gap-1.5"
                                    >
                                        {rowAction === 'reject' ? (
                                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        ) : (
                                            <X className="w-3.5 h-3.5" />
                                        )}
                                        {t('actions.reject')}
                                    </Button>
                                    <Button
                                        type="button"
                                        size="sm"
                                        onClick={() => handleApprove(p.id)}
                                        disabled={busy}
                                        data-testid={`approval-approve-${p.id}`}
                                        className="gap-1.5"
                                    >
                                        {rowAction === 'approve' ? (
                                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        ) : (
                                            <Check className="w-3.5 h-3.5" />
                                        )}
                                        {t('actions.approve')}
                                    </Button>
                                </div>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
