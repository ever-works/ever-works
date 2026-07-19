'use client';

import { useMemo, useState, useTransition } from 'react';
import { Activity, ChevronLeft, Clock, Gauge, Pause, Play, Trash2, Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link, useRouter } from '@/i18n/navigation';
import { StatusPill } from '@/components/work-agent';
import { Select } from '@/components/ui/select';
import type { Goal, GoalMetricSample, GoalOutcome } from '@/lib/api/goals';
import { COMPARATOR_GLYPH, OutcomeBadge, formatDateTime, formatMetricValue } from './goal-ui';
import { Sparkline } from './Sparkline';
import {
    activateGoalAction,
    deleteGoalAction,
    evaluateGoalNowAction,
    pauseGoalAction,
    updateGoalAction,
} from './actions';

export interface GoalDetailClientProps {
    goal: Goal;
    samples: GoalMetricSample[];
}

const OUTCOMES: GoalOutcome[] = ['achieved', 'missed', 'abandoned'];

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
 * Goals & Metrics — PR-8. `/goals/[id]` detail client. Renders the
 * observation-history sparkline (dependency-free inline SVG), the
 * current-vs-target progress, the lifecycle actions
 * (activate / pause / evaluate-now), and the human outcome override
 * (spec FR-13) which PATCHes `outcome`.
 */
export function GoalDetailClient({ goal: initial, samples }: GoalDetailClientProps) {
    const t = useTranslations('dashboard.goalDetail');
    const router = useRouter();

    const [goal, setGoal] = useState<Goal>(initial);
    const [pendingLifecycle, startLifecycle] = useTransition();
    const [pendingEvaluate, startEvaluate] = useTransition();
    const [pendingOutcome, startOutcome] = useTransition();
    const [pendingDelete, startDelete] = useTransition();

    // Samples arrive newest-first; the sparkline wants oldest → newest.
    const sparkValues = useMemo(() => [...samples].reverse().map((s) => s.value), [samples]);

    const canActivate = goal.status !== 'active';
    const canPause = goal.status === 'active';
    const canEvaluate = goal.status === 'active';

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

    const evaluateNow = () => {
        startEvaluate(async () => {
            try {
                const result = await evaluateGoalNowAction(goal.id);
                setGoal(result.goal);
                toast.success(t('toasts.evaluated'));
                // A new sample may have been appended — pull fresh
                // server data (samples + goal) for the sparkline.
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
                        {canEvaluate && (
                            <button
                                type="button"
                                onClick={evaluateNow}
                                disabled={pendingEvaluate}
                                className={btn}
                            >
                                <Zap className="w-3.5 h-3.5" />
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
                            onClick={handleDelete}
                            disabled={pendingDelete}
                            className={btnDanger}
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            {t('actions.delete')}
                        </button>
                    </div>
                </div>
            </div>

            {/* Progress + sparkline */}
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

            {/* Details + outcome override */}
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
                                    <time dateTime={goal.nextCheckAt} suppressHydrationWarning>
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
                                <time dateTime={goal.currentValueAt} suppressHydrationWarning>
                                    {formatDateTime(goal.currentValueAt)}
                                </time>
                            ) : (
                                '—'
                            )}
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
    );
}
