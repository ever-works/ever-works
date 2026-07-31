'use client';

import { useMemo, useState, useTransition } from 'react';
import { ArrowRight, Star, Target } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { Checkbox } from '@/components/ui/checkbox';
import { Select } from '@/components/ui/select';
import { StatusPill } from '@/components/work-agent';
// Direct module path (not the `@/components/goals` barrel) so this
// client panel pulls in only the presentational helpers.
import { COMPARATOR_GLYPH, formatMetricValue } from '@/components/goals/goal-ui';
import { linkGoalToMissionAction } from '@/app/actions/dashboard/mission-goals';
import type { MissionGoalLinkDto } from '@/lib/api/missions';

/**
 * Goals & Metrics PR-8 (web) — the "Goals" panel on the Mission
 * detail page, driven by `GET /me/missions/:id/goals` and
 * `POST /me/missions/:id/goals` (`mission_goals` edges, spec FR-11).
 *
 * Goals are authored standalone on `/goals`; this panel only attaches
 * an existing one and marks at most one of them primary. Copy reflects
 * invariant I-4: an attached Goal never changes the Mission's status —
 * completing a Mission stays an explicit human action.
 */

export interface AttachableGoalOption {
    readonly id: string;
    readonly title: string;
}

export interface MissionGoalsPanelProps {
    missionId: string;
    initialLinks: ReadonlyArray<MissionGoalLinkDto>;
    /** The caller's Goals, for the "Attach Goal" select. */
    attachableGoals: ReadonlyArray<AttachableGoalOption>;
}

const btn =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

export function MissionGoalsPanel({
    missionId,
    initialLinks,
    attachableGoals,
}: MissionGoalsPanelProps) {
    const t = useTranslations('dashboard.missionDetail.goals');

    const [links, setLinks] = useState<ReadonlyArray<MissionGoalLinkDto>>(initialLinks);
    const [pending, startTransition] = useTransition();
    const [goalDraft, setGoalDraft] = useState<string>('');
    const [primaryDraft, setPrimaryDraft] = useState<boolean>(false);

    // Already-linked Goals stay in the select: re-POSTing is the
    // documented way to promote/demote an existing link's isPrimary
    // flag, so hiding them would remove the only path to that.
    const linkedGoalIds = useMemo(() => new Set(links.map((l) => l.goalId)), [links]);

    const handleAttach = () => {
        if (!goalDraft) return;
        startTransition(async () => {
            try {
                const updated = await linkGoalToMissionAction(missionId, {
                    goalId: goalDraft,
                    isPrimary: primaryDraft,
                });
                setLinks(updated);
                setGoalDraft('');
                setPrimaryDraft(false);
                toast.success(t('toasts.attached'));
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.attachError'));
            }
        });
    };

    return (
        <section
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5"
            data-testid="mission-goals"
        >
            {/* Header — mirrors the SectionHeader style of the sibling panels */}
            <div className="flex items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 border bg-emerald-500/10 border-emerald-500/20">
                        <Target className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h2>
                </div>
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-border dark:border-border-dark text-text-muted dark:text-text-muted-dark bg-surface-secondary dark:bg-surface-secondary-dark tabular-nums">
                    {links.length}
                </span>
            </div>

            {links.length === 0 ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('empty')}</p>
            ) : (
                <ul className="space-y-2" data-testid="mission-goals-list">
                    {links.map((l) => (
                        <li
                            key={l.id}
                            className="flex items-center gap-3 p-3 rounded-lg border border-border/60 dark:border-border-dark/60 bg-surface/30 dark:bg-surface-dark/30 hover:border-border dark:hover:border-border-dark transition-colors group"
                            data-testid={`mission-goals-row-${l.goalId}`}
                        >
                            <Link
                                href={`/goals/${l.goalId}`}
                                className="flex items-center gap-2 min-w-0 flex-1 text-sm font-medium text-text dark:text-text-dark hover:text-primary transition-colors"
                            >
                                <span className="truncate">{l.goal?.title ?? l.goalId}</span>
                                <ArrowRight className="w-3.5 h-3.5 text-text-muted shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                            </Link>
                            {l.isPrimary && (
                                <span
                                    title={t('primaryTooltip')}
                                    className="shrink-0 inline-flex items-center gap-1 rounded-full border border-warning/20 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning"
                                    data-testid={`mission-goals-primary-${l.goalId}`}
                                >
                                    <Star className="w-3 h-3" />
                                    {t('primaryBadge')}
                                </span>
                            )}
                            {l.goal && (
                                <span className="hidden sm:block shrink-0 text-[11px] text-text-muted dark:text-text-muted-dark tabular-nums">
                                    {formatMetricValue(l.goal.currentValue, l.goal.unit)}
                                    {' / '}
                                    {COMPARATOR_GLYPH[l.goal.comparator]}{' '}
                                    {formatMetricValue(l.goal.targetValue, l.goal.unit)}
                                </span>
                            )}
                            {l.goal && <StatusPill status={l.goal.status} />}
                        </li>
                    ))}
                </ul>
            )}

            {/* Attach affordance */}
            <div className="mt-5 pt-4 border-t border-border/60 dark:border-border-dark/60">
                <p className="text-xs font-medium text-text dark:text-text-dark mb-2">
                    {t('attachTitle')}
                </p>
                {attachableGoals.length === 0 ? (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('noGoalsToAttach')}
                    </p>
                ) : (
                    <div className="flex flex-wrap items-end gap-3">
                        <label className="space-y-1.5 min-w-48 flex-1 max-w-xs">
                            <span className="block text-xs text-text-muted dark:text-text-muted-dark">
                                {t('goalLabel')}
                            </span>
                            <Select
                                size="sm"
                                value={goalDraft}
                                onValueChange={setGoalDraft}
                                placeholder={t('goalPlaceholder')}
                                data-testid="mission-attach-goal-select"
                            >
                                {attachableGoals.map((g) => (
                                    <option key={g.id} value={g.id}>
                                        {linkedGoalIds.has(g.id)
                                            ? t('alreadyLinkedOption', { title: g.title })
                                            : g.title}
                                    </option>
                                ))}
                            </Select>
                            {attachableGoals.length >= 100 ? (
                                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                    {t('pickerTruncated')}
                                </p>
                            ) : null}
                        </label>
                        <div className="pb-1.5">
                            <Checkbox
                                label={t('primaryLabel')}
                                checked={primaryDraft}
                                onChange={(e) => setPrimaryDraft(e.target.checked)}
                                data-testid="mission-attach-goal-primary"
                            />
                        </div>
                        <button
                            type="button"
                            onClick={handleAttach}
                            disabled={pending || !goalDraft}
                            className={cn(btn, 'h-8')}
                            data-testid="mission-attach-goal-submit"
                        >
                            <Target className="w-3.5 h-3.5" />
                            {t('attach')}
                        </button>
                    </div>
                )}
                <p className="mt-3 text-[11px] text-text-muted dark:text-text-muted-dark">
                    {t('invariantNote')}
                </p>
            </div>
        </section>
    );
}
