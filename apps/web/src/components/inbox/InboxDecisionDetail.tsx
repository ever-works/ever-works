'use client';

import { ArrowLeft, ArrowRight, Bot, ExternalLink, PauseCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { ShowDateTime } from '@/components/ui/show-datetime';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import {
    decisionConfidencePercent,
    type InboxDecision,
    type InboxReplyOutcome,
} from '@/lib/api/inbox.shared';
import type { AgentActionRiskFlag } from '@/lib/api/agent-approvals';
import { InboxAnswerSummary } from './InboxAnswerSummary';
import { InboxFleetSource } from './InboxFleetSource';
import { InboxReplyComposer } from './InboxReplyComposer';

/** What happened to the work behind an answer given in this session. */
export type DecisionOutcomeKey =
    | 'resumed'
    | 'injected'
    | 'queued'
    | 'failed'
    | 'none'
    | 'alreadyDecided';

interface InboxDecisionDetailProps {
    decision: InboxDecision;
    /** 1-based position in the loaded queue, or null when it left the queue (answered). */
    position: number | null;
    total: number;
    outcome: DecisionOutcomeKey | null;
    onPrevious: (() => void) | null;
    onNext: (() => void) | null;
    onSendingChange: (sending: boolean) => void;
    onReplied: (outcome: InboxReplyOutcome) => void;
}

/** The risk flags the approvals block already translates; anything newer shows as-is. */
const KNOWN_RISK_FLAGS: readonly AgentActionRiskFlag[] = [
    'budget_override',
    'destructive',
    'cross_scope',
    'high_fanout',
];

function isKnownRiskFlag(flag: string): flag is AgentActionRiskFlag {
    return (KNOWN_RISK_FLAGS as readonly string[]).includes(flag);
}

const CHIP =
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium';

/**
 * My Decisions — the detail pane for one decision: what it is, what is
 * waiting behind it (a parked run or a blocked Task, with links), what the
 * agent already tried, and the answer. Every fact shown here comes from the
 * records the Inbox item already links to; nothing is stored twice.
 *
 * Answering uses the Inbox's own composer with the decision answer rule
 * switched on, so a rejection or a non-recommended choice carries a reason.
 */
export function InboxDecisionDetail({
    decision,
    position,
    total,
    outcome,
    onPrevious,
    onNext,
    onSendingChange,
    onReplied,
}: InboxDecisionDetailProps) {
    const t = useTranslations('dashboard.inbox');
    const tDecisions = useTranslations('dashboard.inbox.decisions');
    const tApprovals = useTranslations('dashboard.approvals');
    const context = decision.decision;
    const agentName = context.agentName;
    const confidence = decisionConfidencePercent(context.confidence);

    return (
        <div className="space-y-5" data-testid="decision-detail">
            <div>
                <div className="flex items-start justify-between gap-3">
                    <h2 className="text-lg font-semibold text-text dark:text-text-dark">
                        {decision.title}
                    </h2>
                    <div className="flex shrink-0 items-center gap-1">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={onPrevious ?? undefined}
                            disabled={!onPrevious}
                            aria-label={tDecisions('detail.previousDecision')}
                            data-testid="decision-previous"
                        >
                            <ArrowLeft className="w-4 h-4" />
                        </Button>
                        {position !== null && (
                            <span
                                className="text-xs tabular-nums text-text-secondary dark:text-text-secondary-dark"
                                data-testid="decision-position"
                            >
                                {tDecisions('detail.positionWalker', { index: position, total })}
                            </span>
                        )}
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={onNext ?? undefined}
                            disabled={!onNext}
                            aria-label={tDecisions('detail.nextDecision')}
                            data-testid="decision-next"
                        >
                            <ArrowRight className="w-4 h-4" />
                        </Button>
                    </div>
                </div>
                <p className="mt-1 text-xs text-text-secondary dark:text-text-secondary-dark">
                    {t(`kind.${decision.kind}`)}
                    {agentName ? ` · ${agentName}` : ''} ·{' '}
                    <ShowDateTime value={decision.createdAt} />
                </p>
                <InboxFleetSource item={decision} />
            </div>

            <div className="flex flex-wrap items-center gap-2">
                {context.blocking && (
                    <span
                        className={cn(
                            CHIP,
                            'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200',
                        )}
                        data-testid="decision-blocking"
                    >
                        <PauseCircle className="w-3.5 h-3.5" />
                        {tDecisions('card.blocking')}
                        {' · '}
                        {context.blockingReason === 'run-parked'
                            ? tDecisions('card.blockingRunParked')
                            : tDecisions('card.blockingTaskBlocked')}
                    </span>
                )}
                <span
                    className={cn(
                        CHIP,
                        'border-border bg-surface-secondary text-text-secondary dark:border-white/10 dark:bg-white/6 dark:text-text-secondary-dark',
                    )}
                    data-testid="decision-confidence"
                >
                    {confidence === null
                        ? tDecisions('card.notScored')
                        : tDecisions('card.confidence', { percent: confidence })}
                </span>
                {context.dormant && (
                    <span
                        className={cn(
                            CHIP,
                            'border-border bg-surface-secondary text-text-secondary dark:border-white/10 dark:bg-white/6 dark:text-text-secondary-dark',
                        )}
                        data-testid="decision-dormant"
                    >
                        {tDecisions('card.dormant')}
                    </span>
                )}
            </div>

            {(context.taskId || context.missionId || decision.agentId) && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    {context.taskId && (
                        <Link
                            href={ROUTES.DASHBOARD_TASK(context.taskId)}
                            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                            data-testid="decision-task-link"
                        >
                            <ExternalLink className="w-3.5 h-3.5" />
                            {context.taskTitle
                                ? `${tDecisions('detail.openTask')}: ${context.taskTitle}`
                                : tDecisions('detail.openTask')}
                        </Link>
                    )}
                    {context.missionId && (
                        <Link
                            href={ROUTES.DASHBOARD_MISSION(context.missionId)}
                            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                            data-testid="decision-mission-link"
                        >
                            <ExternalLink className="w-3.5 h-3.5" />
                            {tDecisions('detail.openMission')}
                        </Link>
                    )}
                    {decision.agentId && (
                        <Link
                            href={ROUTES.DASHBOARD_AGENT(decision.agentId)}
                            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                            data-testid="decision-agent-link"
                        >
                            <Bot className="w-3.5 h-3.5" />
                            {tDecisions('detail.openAgent')}
                        </Link>
                    )}
                </div>
            )}

            <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                    {tDecisions('detail.whatHappened')}
                </h3>
                <p className="mt-1 whitespace-pre-wrap text-sm text-text dark:text-text-dark">
                    {decision.body}
                </p>
            </section>

            {context.attempted.length > 0 && (
                <section data-testid="decision-attempted">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                        {tDecisions('detail.whatItTried')}
                    </h3>
                    <ul className="mt-1 space-y-1 text-sm text-text dark:text-text-dark">
                        {context.attempted.map((attempt, index) => (
                            <li key={`${attempt.label}-${index}`} className="flex gap-2">
                                <span aria-hidden="true">•</span>
                                <span className="min-w-0">
                                    <span className="font-medium">{attempt.label}</span>
                                    {' — '}
                                    {attempt.outcome}
                                    {attempt.detail ? ` (${attempt.detail})` : ''}
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {context.riskFlags.length > 0 && (
                <section data-testid="decision-risks">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                        {tDecisions('detail.risks')}
                    </h3>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                        {context.riskFlags.map((flag) => (
                            <span
                                key={flag}
                                className={cn(
                                    CHIP,
                                    'border-red-200 bg-red-50 text-red-800 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300',
                                )}
                            >
                                {isKnownRiskFlag(flag) ? tApprovals(`riskFlags.${flag}`) : flag}
                            </span>
                        ))}
                    </div>
                </section>
            )}

            {outcome && (
                <div
                    className={cn(
                        'rounded-lg border px-4 py-3 text-sm',
                        outcome === 'failed'
                            ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300'
                            : 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200',
                    )}
                    data-testid="decision-outcome"
                    data-outcome={outcome}
                >
                    <p>
                        {outcome === 'resumed'
                            ? agentName
                                ? tDecisions('resolution.resumed', { agent: agentName })
                                : tDecisions('resolution.resumedUnnamed')
                            : tDecisions(`resolution.${outcome}`)}
                    </p>
                    {outcome === 'failed' && context.taskId && (
                        <Link
                            href={ROUTES.DASHBOARD_TASK(context.taskId)}
                            className="mt-2 inline-flex items-center gap-1 text-xs font-medium underline"
                            data-testid="decision-run-now"
                        >
                            {tDecisions('resolution.runNow')}
                        </Link>
                    )}
                </div>
            )}

            {decision.status === 'open' && (
                <>
                    {context.blocking && (
                        <p
                            className="text-sm text-text-secondary dark:text-text-secondary-dark"
                            data-testid="decision-pending-line"
                        >
                            {agentName
                                ? tDecisions('detail.pendingOne', { agent: agentName })
                                : tDecisions('detail.pendingOneUnnamed')}
                        </p>
                    )}
                    <InboxReplyComposer
                        key={decision.id}
                        item={decision}
                        requireReason
                        onSendingChange={onSendingChange}
                        onReplied={onReplied}
                    />
                </>
            )}

            {decision.status === 'answered' && <InboxAnswerSummary item={decision} />}

            {decision.status === 'archived' && (
                <p
                    className="rounded-lg border border-border dark:border-border-dark bg-surface-secondary dark:bg-white/4 px-4 py-3 text-sm text-text-secondary dark:text-text-secondary-dark"
                    data-testid="decision-archived-note"
                >
                    {tDecisions('detail.archivedNote')}
                </p>
            )}
        </div>
    );
}
