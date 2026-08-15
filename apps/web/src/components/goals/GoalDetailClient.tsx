'use client';

import { useMemo, useState, useTransition } from 'react';
import {
    Activity,
    Archive,
    ArchiveRestore,
    ChevronLeft,
    Clock,
    Gauge,
    MessageSquarePlus,
    Pause,
    Play,
    RefreshCw,
    SlidersHorizontal,
    Square,
    Trash2,
    Zap,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link, useRouter } from '@/i18n/navigation';
import { StatusPill } from '@/components/work-agent';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import {
    MAX_NUDGE_CHARS,
    type Goal,
    type GoalEvent,
    type GoalMetricSample,
    type GoalOutcome,
    type GoalSession,
} from '@/lib/api/goals';
import { COMPARATOR_GLYPH, OutcomeBadge, formatDateTime, formatMetricValue } from './goal-ui';
import { DodRollup, LoopStatusBadge, formatCents } from './goal-loop-ui';
import { Sparkline } from './Sparkline';
import { GoalDodPanel } from './GoalDodPanel';
import { GoalLimitsDialog, type GoalAgentOption } from './GoalLimitsDialog';
import { GoalOrchestratorLog } from './GoalOrchestratorLog';
import { GoalSessionsPanel } from './GoalSessionsPanel';
import { GoalResultsPanel } from './GoalResultsPanel';
import {
    activateGoalAction,
    advanceGoalAction,
    archiveGoalAction,
    deleteGoalAction,
    evaluateGoalNowAction,
    goalLoopAction,
    nudgeGoalAction,
    pauseGoalAction,
    restartGoalSessionAction,
    unarchiveGoalAction,
    updateGoalAction,
} from './actions';

export interface GoalDetailClientProps {
    goal: Goal;
    samples: GoalMetricSample[];
    events: GoalEvent[];
    sessions: GoalSession[];
    /**
     * Agents the routing pin may choose between. Server-fetched, because
     * without a pin a Goal created in the UI has an empty candidate pool and
     * the loop can only ever answer `no-candidate-agent`.
     */
    agents?: GoalAgentOption[];
}

const OUTCOMES: GoalOutcome[] = ['achieved', 'missed', 'abandoned'];

const TABS = ['dod', 'progress', 'sessions', 'orchestrator', 'results'] as const;
type GoalTab = (typeof TABS)[number];

/**
 * Literal union rather than `string`: next-intl's typed message keys
 * reject an arbitrary string, and the compile error is exactly the guard
 * we want against a toast key no locale file defines.
 */
type LoopToastKey =
    | 'toasts.loopStarted'
    | 'toasts.loopPaused'
    | 'toasts.loopCancelled'
    | 'toasts.advanced'
    | 'toasts.restarted'
    | 'toasts.archived'
    | 'toasts.unarchived';

const btn =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

const btnDanger =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-danger/30 dark:border-danger/20 text-danger hover:bg-danger/5 dark:hover:bg-danger/10 transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

const sectionCard =
    'rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5';

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-3 py-1.5">
            <span className="text-xs text-text-muted dark:text-text-muted-dark shrink-0">
                {label}
            </span>
            <span className="text-xs font-medium text-text dark:text-text-dark text-right min-w-0 truncate">
                {children}
            </span>
        </div>
    );
}

/**
 * Goals & Metrics — PR-8 detail client, extended by the autonomy layer.
 *
 * The page is now a tab strip — Definition of Done | Progress log |
 * Sessions | Orchestrator | Results — over one header that carries BOTH
 * lifecycles: the metric lifecycle (activate / pause / evaluate-now,
 * unchanged) and the execution loop (start / pause / restart / cancel /
 * nudge / adjust limits).
 *
 * The two are deliberately separate controls rather than one merged
 * "run" button, because they mean different things: pausing metric
 * evaluation stops MEASURING the goal, pausing the loop stops WORKING on
 * it, and an operator regularly wants one without the other.
 */
export function GoalDetailClient({
    goal: initial,
    samples,
    events,
    sessions,
    agents = [],
}: GoalDetailClientProps) {
    const t = useTranslations('dashboard.goalDetail');
    const router = useRouter();

    const [goal, setGoal] = useState<Goal>(initial);
    const [tab, setTab] = useState<GoalTab>('dod');
    const [limitsOpen, setLimitsOpen] = useState(false);
    const [nudgeOpen, setNudgeOpen] = useState(false);
    const [nudgeText, setNudgeText] = useState('');
    const [pendingLifecycle, startLifecycle] = useTransition();
    const [pendingEvaluate, startEvaluate] = useTransition();
    const [pendingOutcome, startOutcome] = useTransition();
    const [pendingDelete, startDelete] = useTransition();
    const [pendingLoop, startLoop] = useTransition();

    // Samples arrive newest-first; the sparkline wants oldest → newest.
    const sparkValues = useMemo(() => [...samples].reverse().map((s) => s.value), [samples]);

    const canActivate = goal.status !== 'active';
    const canPause = goal.status === 'active';
    const canEvaluate = goal.status === 'active';
    const loopRunning = goal.loopStatus === 'running';
    const loopStartable = !loopRunning && goal.loopStatus !== 'cancelled' && !goal.archivedAt;

    const lifecycle = (verb: 'activated' | 'paused', action: () => Promise<Goal>) => {
        startLifecycle(async () => {
            try {
                const updated = await action();
                setGoal(updated);
                toast.success(t(`toasts.${verb}`));
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.lifecycleError'));
            }
        });
    };

    /**
     * Every loop control refreshes the server data as well as swapping in
     * the returned Goal: a dispatch writes orchestrator events and a new
     * session row, and a header that updated while the tabs beneath it
     * stayed stale would be worse than not updating at all.
     */
    const loopControl = (toastKey: LoopToastKey, action: () => Promise<unknown>) => {
        startLoop(async () => {
            try {
                const result = await action();
                if (result && typeof result === 'object' && 'id' in result) {
                    setGoal(result as Goal);
                }
                toast.success(t(toastKey));
                router.refresh();
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.loopError'));
            }
        });
    };

    const evaluateNow = () => {
        startEvaluate(async () => {
            try {
                const result = await evaluateGoalNowAction(goal.id);
                setGoal(result.goal);
                toast.success(t('toasts.evaluated'));
                router.refresh();
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.evaluateError'));
            }
        });
    };

    const overrideOutcome = (value: string) => {
        const next: GoalOutcome | null = value === '' ? null : (value as GoalOutcome);
        startOutcome(async () => {
            try {
                const updated = await updateGoalAction(goal.id, { outcome: next });
                setGoal(updated);
                toast.success(t('toasts.outcomeSaved'));
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.outcomeError'));
            }
        });
    };

    const handleDelete = () => {
        if (!window.confirm(t('confirm.delete'))) return;
        startDelete(async () => {
            try {
                await deleteGoalAction(goal.id);
                toast.success(t('toasts.deleted'));
                router.push('/goals');
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.deleteError'));
            }
        });
    };

    const submitNudge = () => {
        const message = nudgeText.trim();
        if (!message) return;
        startLoop(async () => {
            try {
                const result = await nudgeGoalAction(goal.id, message);
                setGoal(result.goal);
                setNudgeText('');
                setNudgeOpen(false);
                toast.success(t('toasts.nudged'));
                router.refresh();
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.loopError'));
            }
        });
    };

    return (
        <div className="w-full p-6 max-w-screen-2xl mx-auto space-y-6">
            {/* Header */}
            <div>
                <Link
                    href="/goals"
                    className="inline-flex items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition-colors"
                >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    {t('backToGoals')}
                </Link>

                <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                        <div className="shrink-0 w-10 h-10 rounded-xl bg-info/10 border border-info/20 flex items-center justify-center">
                            <Gauge className="w-5 h-5 text-info" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <h1 className="text-2xl font-semibold text-text dark:text-text-dark leading-tight">
                                {goal.title}
                            </h1>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                <StatusPill status={goal.status} />
                                {goal.outcome ? <OutcomeBadge outcome={goal.outcome} /> : null}
                                {goal.loopStatus ? (
                                    <LoopStatusBadge status={goal.loopStatus} />
                                ) : null}
                                {goal.archivedAt ? (
                                    <span className="inline-flex items-center rounded-full border border-border/70 dark:border-border-dark/70 bg-surface-secondary dark:bg-surface-secondary-dark px-2 py-0.5 text-[11px] text-text-muted">
                                        {t('loop.archived')}
                                    </span>
                                ) : null}
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted dark:text-text-muted-dark">
                                <span>{t('loop.iteration', { n: goal.iteration })}</span>
                                <span>
                                    {t('loop.spent', {
                                        spent: formatCents(goal.spentCents),
                                        cap:
                                            goal.spendCapCents === null
                                                ? t('loop.uncapped')
                                                : formatCents(goal.spendCapCents),
                                    })}
                                </span>
                                <DodRollup summary={goal.dodSummary} />
                            </div>
                            {goal.description ? (
                                <p className="mt-2.5 text-sm text-text-secondary dark:text-text-secondary-dark max-w-3xl leading-relaxed">
                                    {goal.description}
                                </p>
                            ) : null}
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {loopStartable ? (
                            <button
                                type="button"
                                onClick={() =>
                                    loopControl('toasts.loopStarted', () =>
                                        goalLoopAction(goal.id, 'start'),
                                    )
                                }
                                disabled={pendingLoop}
                                className={btn}
                            >
                                <Play className="w-3.5 h-3.5" />
                                {t('loop.actions.start')}
                            </button>
                        ) : null}
                        {loopRunning ? (
                            <>
                                <button
                                    type="button"
                                    onClick={() =>
                                        loopControl('toasts.advanced', () =>
                                            advanceGoalAction(goal.id),
                                        )
                                    }
                                    disabled={pendingLoop}
                                    className={btn}
                                >
                                    <Zap className="w-3.5 h-3.5" />
                                    {t('loop.actions.advance')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setNudgeOpen((open) => !open)}
                                    disabled={pendingLoop}
                                    className={btn}
                                >
                                    <MessageSquarePlus className="w-3.5 h-3.5" />
                                    {t('loop.actions.nudge')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() =>
                                        loopControl('toasts.loopPaused', () =>
                                            goalLoopAction(goal.id, 'pause'),
                                        )
                                    }
                                    disabled={pendingLoop}
                                    className={btn}
                                >
                                    <Pause className="w-3.5 h-3.5" />
                                    {t('loop.actions.pause')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() =>
                                        loopControl('toasts.restarted', () =>
                                            restartGoalSessionAction(goal.id),
                                        )
                                    }
                                    disabled={pendingLoop}
                                    className={btn}
                                >
                                    <RefreshCw className="w-3.5 h-3.5" />
                                    {t('loop.actions.restart')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (!window.confirm(t('confirm.cancelLoop'))) return;
                                        loopControl('toasts.loopCancelled', () =>
                                            goalLoopAction(goal.id, 'cancel'),
                                        );
                                    }}
                                    disabled={pendingLoop}
                                    className={btnDanger}
                                >
                                    <Square className="w-3.5 h-3.5" />
                                    {t('loop.actions.cancel')}
                                </button>
                            </>
                        ) : null}
                        <button
                            type="button"
                            onClick={() => setLimitsOpen(true)}
                            className={btn}
                            disabled={pendingLoop}
                        >
                            <SlidersHorizontal className="w-3.5 h-3.5" />
                            {t('loop.actions.adjustLimits')}
                        </button>
                        {canEvaluate && (
                            <button
                                type="button"
                                onClick={evaluateNow}
                                disabled={pendingEvaluate}
                                className={btn}
                            >
                                <Activity className="w-3.5 h-3.5" />
                                {t('actions.evaluateNow')}
                            </button>
                        )}
                        {canActivate && (
                            <button
                                type="button"
                                onClick={() =>
                                    lifecycle('activated', () => activateGoalAction(goal.id))
                                }
                                disabled={pendingLifecycle}
                                className={btn}
                            >
                                <Play className="w-3.5 h-3.5" />
                                {t('actions.activate')}
                            </button>
                        )}
                        {canPause && (
                            <button
                                type="button"
                                onClick={() => lifecycle('paused', () => pauseGoalAction(goal.id))}
                                disabled={pendingLifecycle}
                                className={btn}
                            >
                                <Pause className="w-3.5 h-3.5" />
                                {t('actions.pause')}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() =>
                                goal.archivedAt
                                    ? loopControl('toasts.unarchived', () =>
                                          unarchiveGoalAction(goal.id),
                                      )
                                    : loopControl('toasts.archived', () =>
                                          archiveGoalAction(goal.id),
                                      )
                            }
                            disabled={pendingLoop}
                            className={btn}
                        >
                            {goal.archivedAt ? (
                                <ArchiveRestore className="w-3.5 h-3.5" />
                            ) : (
                                <Archive className="w-3.5 h-3.5" />
                            )}
                            {goal.archivedAt ? t('actions.unarchive') : t('actions.archive')}
                        </button>
                        <button
                            type="button"
                            onClick={handleDelete}
                            disabled={pendingDelete}
                            className={btnDanger}
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            {t('actions.delete')}
                        </button>
                    </div>
                </div>

                {nudgeOpen ? (
                    <div className="mt-4 flex flex-wrap items-end gap-2 rounded-lg border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-3">
                        <label className="min-w-0 flex-1">
                            <span className="mb-1 block text-xs font-medium text-text dark:text-text-dark">
                                {t('loop.nudgeLabel')}
                            </span>
                            <input
                                value={nudgeText}
                                maxLength={MAX_NUDGE_CHARS}
                                onChange={(e) => setNudgeText(e.target.value)}
                                placeholder={t('loop.nudgePlaceholder')}
                                className="w-full rounded-lg border border-border dark:border-border-dark bg-transparent px-3 py-2 text-sm text-text dark:text-text-dark"
                            />
                        </label>
                        <Button
                            size="sm"
                            disabled={pendingLoop || nudgeText.trim().length === 0}
                            onClick={submitNudge}
                        >
                            {t('loop.sendNudge')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setNudgeOpen(false)}>
                            {t('loop.cancelNudge')}
                        </Button>
                    </div>
                ) : null}
            </div>

            {/* Tab strip */}
            <div
                role="tablist"
                aria-label={t('tabs.label')}
                className="flex flex-wrap gap-1 border-b border-border/60 dark:border-border-dark/60"
            >
                {TABS.map((key) => (
                    <button
                        key={key}
                        type="button"
                        role="tab"
                        aria-selected={tab === key}
                        onClick={() => setTab(key)}
                        className={cn(
                            '-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors',
                            tab === key
                                ? 'border-info text-info'
                                : 'border-transparent text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark',
                        )}
                    >
                        {t(`tabs.${key}`)}
                    </button>
                ))}
            </div>

            {tab === 'dod' ? <GoalDodPanel goal={goal} onGoalChange={setGoal} /> : null}

            {tab === 'progress' ? (
                <div className="space-y-6">
                    <section className={sectionCard}>
                        <div className="flex items-center gap-2.5 mb-4">
                            <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 border bg-info/10 border-info/20">
                                <Activity className="w-3.5 h-3.5 text-info" />
                            </div>
                            <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                                {t('sections.progress')}
                            </h2>
                        </div>

                        <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
                            <div>
                                <p className="text-[11px] uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                    {t('progress.current')}
                                </p>
                                <p className="text-2xl font-semibold text-text dark:text-text-dark tabular-nums">
                                    {formatMetricValue(goal.currentValue, goal.unit)}
                                </p>
                            </div>
                            <span
                                className="text-2xl font-semibold text-info pb-0.5"
                                title={t(`comparator.${goal.comparator}`)}
                            >
                                {COMPARATOR_GLYPH[goal.comparator]}
                            </span>
                            <div>
                                <p className="text-[11px] uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                    {t('progress.target')}
                                </p>
                                <p className="text-2xl font-semibold text-text-secondary dark:text-text-secondary-dark tabular-nums">
                                    {formatMetricValue(goal.targetValue, goal.unit)}
                                </p>
                            </div>
                        </div>

                        <div className="mt-4">
                            {sparkValues.length > 0 ? (
                                <Sparkline values={sparkValues} target={goal.targetValue} />
                            ) : (
                                <p className="text-xs text-text-muted dark:text-text-muted-dark py-6 text-center">
                                    {t('progress.noSamples')}
                                </p>
                            )}
                            {sparkValues.length > 0 ? (
                                <p className="mt-1 text-[11px] text-text-muted dark:text-text-muted-dark">
                                    {t('progress.sampleCount', { count: sparkValues.length })}
                                </p>
                            ) : null}
                        </div>
                    </section>

                    <div className="grid gap-5 @3xl/main:grid-cols-2">
                        <section className={sectionCard}>
                            <h2 className="text-sm font-semibold text-text dark:text-text-dark mb-3">
                                {t('sections.details')}
                            </h2>
                            <div className="divide-y divide-border/50 dark:divide-border-dark/50">
                                <DetailRow label={t('details.plugin')}>
                                    {goal.metricSource.pluginId}
                                </DetailRow>
                                <DetailRow label={t('details.metric')}>
                                    {goal.metricSource.metricId}
                                </DetailRow>
                                <DetailRow label={t('details.window')}>
                                    {t(`window.${goal.window}`)}
                                </DetailRow>
                                <DetailRow label={t('details.baseline')}>
                                    {formatMetricValue(goal.baselineValue, goal.unit)}
                                </DetailRow>
                                <DetailRow label={t('details.checkFrequency')}>
                                    {t('details.minutes', { count: goal.checkFrequencyMinutes })}
                                </DetailRow>
                                <DetailRow label={t('details.nextCheck')}>
                                    {goal.nextCheckAt ? (
                                        <span className="inline-flex items-center gap-1">
                                            <Clock className="w-3 h-3 shrink-0" />
                                            <time
                                                dateTime={goal.nextCheckAt}
                                                suppressHydrationWarning
                                            >
                                                {formatDateTime(goal.nextCheckAt)}
                                            </time>
                                        </span>
                                    ) : (
                                        '—'
                                    )}
                                </DetailRow>
                                <DetailRow label={t('details.deadline')}>
                                    {goal.deadline ? (
                                        <time dateTime={goal.deadline} suppressHydrationWarning>
                                            {formatDateTime(goal.deadline)}
                                        </time>
                                    ) : (
                                        t('details.noDeadline')
                                    )}
                                </DetailRow>
                                <DetailRow label={t('details.lastObserved')}>
                                    {goal.currentValueAt ? (
                                        <time
                                            dateTime={goal.currentValueAt}
                                            suppressHydrationWarning
                                        >
                                            {formatDateTime(goal.currentValueAt)}
                                        </time>
                                    ) : (
                                        '—'
                                    )}
                                </DetailRow>
                            </div>
                        </section>

                        <section className={sectionCard}>
                            <h2 className="text-sm font-semibold text-text dark:text-text-dark mb-3">
                                {t('sections.limits')}
                            </h2>
                            <div className="divide-y divide-border/50 dark:divide-border-dark/50">
                                <DetailRow label={t('limits.fields.spendCap')}>
                                    {goal.spendCapCents === null
                                        ? t('loop.uncapped')
                                        : formatCents(goal.spendCapCents)}
                                </DetailRow>
                                <DetailRow label={t('limits.spentToDate')}>
                                    {formatCents(goal.spentCents)}
                                </DetailRow>
                                <DetailRow label={t('limits.fields.wallClock')}>
                                    {goal.wallClockLimitHours ?? t('loop.uncapped')}
                                </DetailRow>
                                <DetailRow label={t('limits.fields.stuckThreshold')}>
                                    {goal.stuckThresholdIterations ?? t('loop.uncapped')}
                                </DetailRow>
                                <DetailRow label={t('limits.fields.sessionBudget')}>
                                    {goal.sessionBudgetMinutes ?? t('loop.uncapped')}
                                </DetailRow>
                                <DetailRow label={t('limits.fields.gracePeriod')}>
                                    {goal.gracePeriodMinutes ?? t('loop.uncapped')}
                                </DetailRow>
                                <DetailRow label={t('limits.fields.executionTarget')}>
                                    {goal.executionTarget
                                        ? t(`limits.executionTargets.${goal.executionTarget}`)
                                        : t('limits.fields.executionTargetDefault')}
                                </DetailRow>
                                <DetailRow label={t('limits.fields.plannerModel')}>
                                    {goal.plannerModelHint ?? '—'}
                                </DetailRow>
                                <DetailRow label={t('limits.fields.workerModel')}>
                                    {goal.workerModelHint ?? '—'}
                                </DetailRow>
                                <DetailRow label={t('limits.fields.assignedAgent')}>
                                    {goal.assignedAgentId
                                        ? (agents.find((agent) => agent.id === goal.assignedAgentId)
                                              ?.name ?? goal.assignedAgentId)
                                        : t('limits.fields.assignedAgentNone')}
                                </DetailRow>
                            </div>
                        </section>

                        <section className={sectionCard}>
                            <h2 className="text-sm font-semibold text-text dark:text-text-dark mb-1">
                                {t('sections.outcome')}
                            </h2>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark mb-3">
                                {t('outcome.hint')}
                            </p>
                            <label className="block text-xs font-medium text-text dark:text-text-dark mb-2">
                                {t('outcome.overrideLabel')}
                            </label>
                            <Select
                                value={goal.outcome ?? ''}
                                onValueChange={overrideOutcome}
                                disabled={pendingOutcome}
                                placeholder={t('outcome.none')}
                            >
                                <option value="">{t('outcome.none')}</option>
                                {OUTCOMES.map((o) => (
                                    <option key={o} value={o}>
                                        {t(`outcomes.${o}`)}
                                    </option>
                                ))}
                            </Select>
                            <p className="mt-2 text-[11px] text-text-muted dark:text-text-muted-dark">
                                {t('outcome.overrideNote')}
                            </p>
                        </section>
                    </div>
                </div>
            ) : null}

            {tab === 'sessions' ? <GoalSessionsPanel sessions={sessions} /> : null}
            {tab === 'orchestrator' ? <GoalOrchestratorLog events={events} /> : null}
            {tab === 'results' ? <GoalResultsPanel sessions={sessions} /> : null}

            <GoalLimitsDialog
                goal={goal}
                open={limitsOpen}
                onOpenChange={setLimitsOpen}
                onGoalChange={setGoal}
                agents={agents}
            />
        </div>
    );
}
