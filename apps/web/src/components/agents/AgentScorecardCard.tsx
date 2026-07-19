'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Pencil, Plus, Save, Target, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { updateAgentAction } from '@/app/actions/agents';
import type { Agent, AgentScorecardMetric, AgentScorecardPeriod } from '@/lib/api/agents';

/**
 * Agent Scorecards increment 1 — display + manual editing of the
 * quantified per-Agent goals stored on `agents.scorecard`.
 *
 * Follow-ups (NOT in this increment): auto-updating `current` from run
 * output, and the org-dashboard at-risk roll-up.
 */

type ScorecardStatus = 'exceeded' | 'on_track' | 'behind' | 'critical';

const PERIODS: AgentScorecardPeriod[] = ['weekly', 'monthly', 'quarterly'];

// Client-side mirror of `scorecardStatus` in
// `packages/agent/src/agents/scorecard.ts` — apps/web keeps no runtime
// dep on the agent package (see the note atop `lib/api/agents.ts`).
function scorecardStatus(metric: AgentScorecardMetric): ScorecardStatus {
    if (metric.floor != null && metric.current < metric.floor) return 'critical';
    if (metric.stretch != null && metric.current >= metric.stretch) return 'exceeded';
    if (metric.current >= metric.target) return 'on_track';
    return 'behind';
}

const statusBadgeClasses: Record<ScorecardStatus, string> = {
    exceeded:
        'border-green-500/30 bg-green-500/10 text-green-600 dark:border-green-400/30 dark:bg-green-400/10 dark:text-green-400',
    on_track:
        'border-border/60 text-text-secondary dark:border-border-dark/60 dark:text-text-secondary-dark',
    behind: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-400',
    critical:
        'border-red-500/30 bg-red-500/10 text-red-600 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-400',
};

const statusBarClasses: Record<ScorecardStatus, string> = {
    exceeded: 'bg-green-500',
    on_track: 'bg-primary',
    behind: 'bg-amber-500',
    critical: 'bg-red-500',
};

const statusLabelKeys: Record<ScorecardStatus, 'exceeded' | 'onTrack' | 'behind' | 'critical'> = {
    exceeded: 'exceeded',
    on_track: 'onTrack',
    behind: 'behind',
    critical: 'critical',
};

function progressPercent(metric: AgentScorecardMetric): number {
    if (metric.target > 0) {
        return Math.max(0, Math.min(100, (metric.current / metric.target) * 100));
    }
    // Zero/negative targets: only show a full bar once current strictly
    // clears the target — target=0 & current=0 reads as "not started".
    return metric.current > metric.target ? 100 : 0;
}

/** Editable row — numbers kept as strings so partial input doesn't fight the user. */
interface DraftMetric {
    /** Existing kebab key; null for freshly-added rows (derived from label on save). */
    key: string | null;
    label: string;
    target: string;
    current: string;
    floor: string;
    stretch: string;
    /** Preserved from the stored metric (no unit editor in this increment). */
    unit: string | null;
    period: AgentScorecardPeriod;
}

function toDraft(metric: AgentScorecardMetric): DraftMetric {
    return {
        key: metric.key,
        label: metric.label,
        target: String(metric.target),
        current: String(metric.current),
        floor: metric.floor != null ? String(metric.floor) : '',
        stretch: metric.stretch != null ? String(metric.stretch) : '',
        unit: metric.unit ?? null,
        period: metric.period,
    };
}

function emptyDraft(): DraftMetric {
    return {
        key: null,
        label: '',
        target: '',
        current: '0',
        floor: '',
        stretch: '',
        unit: null,
        period: 'weekly',
    };
}

function kebabify(label: string): string {
    return (
        label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'metric'
    );
}

/** Convert drafts back into metrics; returns an error string when a row is unusable. */
function draftsToMetrics(
    drafts: DraftMetric[],
): { metrics: AgentScorecardMetric[] } | { error: 'label' | 'number' } {
    const metrics: AgentScorecardMetric[] = [];
    const usedKeys = new Set<string>();
    for (const draft of drafts) {
        const label = draft.label.trim();
        if (!label) return { error: 'label' };
        const target = Number(draft.target);
        const current = Number(draft.current);
        if (draft.target.trim() === '' || !Number.isFinite(target)) return { error: 'number' };
        if (draft.current.trim() === '' || !Number.isFinite(current)) return { error: 'number' };
        const floor = draft.floor.trim() === '' ? null : Number(draft.floor);
        const stretch = draft.stretch.trim() === '' ? null : Number(draft.stretch);
        if (floor != null && !Number.isFinite(floor)) return { error: 'number' };
        if (stretch != null && !Number.isFinite(stretch)) return { error: 'number' };
        // Keep the stored key stable for existing rows; derive (and
        // de-duplicate) a kebab key for new ones.
        let key = draft.key ?? kebabify(label);
        if (usedKeys.has(key)) {
            let n = 2;
            while (usedKeys.has(`${key}-${n}`)) n += 1;
            key = `${key}-${n}`;
        }
        usedKeys.add(key);
        metrics.push({
            key,
            label,
            target,
            current,
            floor,
            stretch,
            unit: draft.unit,
            period: draft.period,
        });
    }
    return { metrics };
}

const editInputClasses =
    'w-full rounded-lg border border-border/60 bg-transparent px-2.5 py-1.5 text-sm text-text ' +
    'focus:outline-none focus:ring-1 focus:ring-primary dark:border-border-dark/60 dark:text-text-dark';

interface AgentScorecardCardProps {
    agent: Agent;
}

export function AgentScorecardCard({ agent }: AgentScorecardCardProps) {
    const t = useTranslations('dashboard.agentsPage.scorecard');
    const router = useRouter();
    const [metrics, setMetrics] = useState<AgentScorecardMetric[]>(agent.scorecard ?? []);
    const [drafts, setDrafts] = useState<DraftMetric[]>([]);
    const [isEditing, setIsEditing] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const startEditing = () => {
        setDrafts(metrics.map(toDraft));
        setIsEditing(true);
    };

    const updateDraft = (index: number, patch: Partial<DraftMetric>) => {
        setDrafts((current) =>
            current.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)),
        );
    };

    const save = async () => {
        const result = draftsToMetrics(drafts);
        if ('error' in result) {
            toast.error(
                result.error === 'label' ? t('errors.labelRequired') : t('errors.numbersRequired'),
            );
            return;
        }
        setIsSubmitting(true);
        try {
            const updated = await updateAgentAction(agent.id, {
                scorecard: result.metrics.length > 0 ? result.metrics : null,
            });
            setMetrics(updated.scorecard ?? []);
            setIsEditing(false);
            toast.success(t('saved'));
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t('errors.saveFailed'));
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <section
            data-testid="agent-scorecard"
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-4"
        >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                        <Target className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                        <h2 className="text-sm font-medium text-text dark:text-text-dark">
                            {t('title')}
                        </h2>
                        {!isEditing && metrics.length === 0 ? (
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('empty')}
                            </p>
                        ) : null}
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {isEditing ? (
                        <>
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => setIsEditing(false)}
                                disabled={isSubmitting}
                                className="gap-1.5 px-2.5 py-1 text-xs"
                            >
                                {t('cancel')}
                            </Button>
                            <Button
                                data-testid="scorecard-save"
                                size="sm"
                                onClick={save}
                                loading={isSubmitting}
                                className="gap-1.5 px-2.5 py-1 text-xs"
                            >
                                <Save className="h-3.5 w-3.5" />
                                {t('save')}
                            </Button>
                        </>
                    ) : (
                        <Button
                            data-testid="scorecard-edit"
                            variant="secondary"
                            size="sm"
                            onClick={startEditing}
                            className="gap-1.5 px-2.5 py-1 text-xs"
                        >
                            <Pencil className="h-3.5 w-3.5" />
                            {t('edit')}
                        </Button>
                    )}
                </div>
            </div>

            {isEditing ? (
                <div className="space-y-3">
                    {drafts.map((draft, index) => (
                        <div
                            key={draft.key ?? `new-${index}`}
                            className="rounded-lg border border-border/50 dark:border-border-dark/50 p-3 space-y-3"
                        >
                            <div className="flex items-end gap-3">
                                <div className="flex-1">
                                    <label className="block text-xs font-medium text-text dark:text-text-dark mb-1.5">
                                        {t('fields.label')}
                                    </label>
                                    <input
                                        type="text"
                                        maxLength={80}
                                        className={editInputClasses}
                                        value={draft.label}
                                        onChange={(event) =>
                                            updateDraft(index, { label: event.target.value })
                                        }
                                    />
                                </div>
                                <div className="w-36">
                                    <label className="block text-xs font-medium text-text dark:text-text-dark mb-1.5">
                                        {t('fields.period')}
                                    </label>
                                    <select
                                        className={editInputClasses}
                                        value={draft.period}
                                        onChange={(event) =>
                                            updateDraft(index, {
                                                period: event.target.value as AgentScorecardPeriod,
                                            })
                                        }
                                    >
                                        {PERIODS.map((period) => (
                                            <option key={period} value={period}>
                                                {t(`periods.${period}`)}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() =>
                                        setDrafts((current) =>
                                            current.filter((_, i) => i !== index),
                                        )
                                    }
                                    className="px-2 py-1.5"
                                    aria-label={`Remove ${draft.label || 'metric'}`}
                                >
                                    <X className="h-3.5 w-3.5" />
                                </Button>
                            </div>
                            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                                <div>
                                    <label className="block text-xs font-medium text-text dark:text-text-dark mb-1.5">
                                        {t('fields.target')}
                                    </label>
                                    <input
                                        type="number"
                                        className={editInputClasses}
                                        value={draft.target}
                                        onChange={(event) =>
                                            updateDraft(index, { target: event.target.value })
                                        }
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-text dark:text-text-dark mb-1.5">
                                        {t('fields.current')}
                                    </label>
                                    <input
                                        type="number"
                                        className={editInputClasses}
                                        value={draft.current}
                                        onChange={(event) =>
                                            updateDraft(index, { current: event.target.value })
                                        }
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-text dark:text-text-dark mb-1.5">
                                        {t('fields.floor')}
                                    </label>
                                    <input
                                        type="number"
                                        className={editInputClasses}
                                        value={draft.floor}
                                        onChange={(event) =>
                                            updateDraft(index, { floor: event.target.value })
                                        }
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-text dark:text-text-dark mb-1.5">
                                        {t('fields.stretch')}
                                    </label>
                                    <input
                                        type="number"
                                        className={editInputClasses}
                                        value={draft.stretch}
                                        onChange={(event) =>
                                            updateDraft(index, { stretch: event.target.value })
                                        }
                                    />
                                </div>
                            </div>
                        </div>
                    ))}
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setDrafts((current) => [...current, emptyDraft()])}
                        disabled={drafts.length >= 12}
                        className="gap-1.5 px-2.5 py-1 text-xs"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        {t('addMetric')}
                    </Button>
                </div>
            ) : metrics.length > 0 ? (
                <ul className="space-y-3">
                    {metrics.map((metric) => {
                        const status = scorecardStatus(metric);
                        return (
                            <li
                                key={metric.key}
                                data-testid={`scorecard-metric-${metric.key}`}
                                className="rounded-lg border border-border/50 dark:border-border-dark/50 px-3 py-2.5 space-y-2"
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-sm text-text dark:text-text-dark truncate">
                                        {metric.label}
                                    </span>
                                    <span
                                        className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${statusBadgeClasses[status]}`}
                                    >
                                        {t(`statuses.${statusLabelKeys[status]}`)}
                                    </span>
                                </div>
                                <div className="h-1.5 rounded-full bg-border/40 dark:bg-border-dark/40 overflow-hidden">
                                    <div
                                        className={`h-full rounded-full ${statusBarClasses[status]}`}
                                        style={{ width: `${progressPercent(metric)}%` }}
                                    />
                                </div>
                                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {metric.current} / {metric.target}
                                    {metric.unit ? ` ${metric.unit}` : ''}
                                    {' · '}
                                    {t(`periods.${metric.period}`)}
                                </p>
                            </li>
                        );
                    })}
                </ul>
            ) : null}
        </section>
    );
}
