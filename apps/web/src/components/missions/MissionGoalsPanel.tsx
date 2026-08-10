'use client';

import { useMemo, useState, useTransition } from 'react';
import { ArrowRight, Gauge, Star, Trash2, TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { StatusPill } from '@/components/work-agent';
// Direct module path (not the `@/components/goals` barrel) so this
// client panel pulls in only the presentational helpers.
import { COMPARATOR_GLYPH, formatMetricValue } from '@/components/goals/goal-ui';
import {
    linkGoalToMissionAction,
    unlinkGoalFromMissionAction,
} from '@/app/actions/dashboard/mission-goals';
import type { MissionGoalLinkDto } from '@/lib/api/missions';
// `goals.shared` (not `goals`) — the latter is `server-only`.
import type { GoalStatus } from '@/lib/api/goals.shared';

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
    /** Drives the option's leading icon tint. Omitted → neutral. */
    readonly status?: GoalStatus;
}

export interface MissionGoalsPanelProps {
    missionId: string;
    initialLinks: ReadonlyArray<MissionGoalLinkDto>;
    /** The caller's Goals, for the "Attach Goal" select. */
    attachableGoals: ReadonlyArray<AttachableGoalOption>;
}

const btn =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * Leading Goal icons for the picker. `Select` renders `iconMap[key]`
 * for any `<option data-icon={key}>` in both the trigger and the
 * dropdown row, so one map covers both. Keyed by Goal status: the
 * glyph is constant (a Goal is a Goal) and only the tint carries the
 * state, which is the signal that matters when choosing what to
 * attach — a completed Goal reads differently from an active one.
 *
 * `Gauge` is the system's Goal glyph (see `GoalCard`); `Target` — used
 * here before — is the Mission glyph, so the two entities were sharing
 * one symbol on the very page that shows both.
 */
const GOAL_ICON_CLASS: Record<GoalStatus | 'unknown', string> = {
    active: 'text-emerald-600 dark:text-emerald-400',
    paused: 'text-warning',
    draft: 'text-text-muted dark:text-text-muted-dark',
    completed: 'text-info',
    unknown: 'text-text-muted dark:text-text-muted-dark',
};

const GOAL_ICON_MAP: Record<string, React.ReactNode> = Object.fromEntries(
    Object.entries(GOAL_ICON_CLASS).map(([key, className]) => [
        key,
        <Gauge key={key} className={cn('size-3.5', className)} />,
    ]),
);

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
    // The link awaiting detach confirmation; null = dialog closed. Holding
    // the row (not just its id) keeps the Goal's title available for the
    // dialog body after the list has been filtered.
    const [detachTarget, setDetachTarget] = useState<MissionGoalLinkDto | null>(null);
    const [detachError, setDetachError] = useState<string | null>(null);

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

    // Closing the dialog while the request is in flight would strand a
    // half-finished detach, so `pending` locks it shut — same guard the
    // Mission delete dialog uses.
    const closeDetach = () => {
        if (pending) return;
        setDetachTarget(null);
        setDetachError(null);
    };

    /**
     * Detach = drop the `mission_goals` edge. The Goal itself survives
     * on /goals and on any other Mission holding it, which is what the
     * dialog copy spells out — deleting the Goal proper lives on the
     * Goal detail page. Mirrors the Attached Works detach control.
     */
    const handleDetach = () => {
        const link = detachTarget;
        if (!link) return;
        setDetachError(null);
        startTransition(async () => {
            try {
                await unlinkGoalFromMissionAction(missionId, link.goalId);
                setLinks((prev) => prev.filter((l) => l.id !== link.id));
                setDetachTarget(null);
                toast.success(t('toasts.detached'));
            } catch (err) {
                // Surfaced inside the dialog (not just a toast) so the
                // failure sits next to the button that caused it.
                setDetachError(err instanceof Error ? err.message : t('detachDialog.error'));
                toast.error(err instanceof Error ? err.message : t('toasts.detachError'));
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
                    {/* Neutral tile — section icons across the Mission detail
                        page carry no accent, so semantic color stays reserved
                        for state (the Goal status pills in the rows below). */}
                    <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 border bg-surface-secondary dark:bg-surface-secondary-dark border-border/60 dark:border-border-dark/60">
                        <Gauge className="w-3.5 h-3.5 text-text-secondary dark:text-text-secondary-dark" />
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
                <ul className="space-y-1.5" data-testid="mission-goals-list">
                    {links.map((l) => (
                        <li
                            key={l.id}
                            className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border/60 dark:border-border-dark/60 bg-surface/30 dark:bg-surface-dark/30 hover:border-border dark:hover:border-border-dark hover:bg-surface-secondary/50 dark:hover:bg-surface-secondary-dark/50 transition-colors group"
                            data-testid={`mission-goals-row-${l.goalId}`}
                        >
                            <Link
                                href={`/goals/${l.goalId}`}
                                className="flex items-center gap-2.5 min-w-0 flex-1"
                            >
                                {/* Leading tile, mirroring the Attached Works
                                    rows. Neutral like the section headers —
                                    the row's color budget belongs to the
                                    status pill and the primary star. */}
                                <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60 dark:border-border-dark/60 bg-surface-secondary dark:bg-surface-secondary-dark">
                                    <Gauge className="size-4 text-text-muted dark:text-text-muted-dark" />
                                </span>
                                {/* Regular weight, not `font-medium` — the
                                    tile plus the metric line already carry the
                                    hierarchy. */}
                                <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-1.5">
                                        <span className="truncate text-sm text-text dark:text-text-dark group-hover:text-primary transition-colors">
                                            {l.goal?.title ?? l.goalId}
                                        </span>
                                        <ArrowRight className="w-3.5 h-3.5 text-text-muted shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                                    </span>
                                    {/* The current/target readout used to be a
                                        right-hand column that `sm:` hid — on a
                                        Goal it is the whole point of the row,
                                        so it now sits under the title where it
                                        survives narrow widths. */}
                                    {l.goal && (
                                        <span className="block truncate text-[11px] text-text-muted dark:text-text-muted-dark tabular-nums">
                                            {formatMetricValue(l.goal.currentValue, l.goal.unit)}
                                            {' / '}
                                            {COMPARATOR_GLYPH[l.goal.comparator]}{' '}
                                            {formatMetricValue(l.goal.targetValue, l.goal.unit)}
                                        </span>
                                    )}
                                </span>
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
                            {l.goal && <StatusPill status={l.goal.status} />}
                            <button
                                type="button"
                                onClick={() => {
                                    setDetachError(null);
                                    setDetachTarget(l);
                                }}
                                disabled={pending}
                                title={t('detach')}
                                aria-label={t('detach')}
                                data-testid={`mission-goals-detach-${l.goalId}`}
                                className="shrink-0 grid h-7 w-7 place-items-center rounded-md text-text-muted hover:text-danger hover:bg-danger/5 dark:hover:bg-danger/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </button>
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
                    <>
                        {/* One 32px-tall control row: the labelled select is a
                            stacked block, so the checkbox + submit sit in their
                            own fixed-height group and `items-end` lines all
                            three bottoms up. The truncation hint lives OUTSIDE
                            the row — inside the label it grew the stack and
                            knocked the other controls out of alignment. */}
                        <div className="flex flex-wrap items-end gap-3">
                            <label className="min-w-48 flex-1 max-w-xs">
                                <span className="mb-1.5 block text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('goalLabel')}
                                </span>
                                <Select
                                    size="xs"
                                    value={goalDraft}
                                    onValueChange={setGoalDraft}
                                    placeholder={t('goalPlaceholder')}
                                    iconMap={GOAL_ICON_MAP}
                                    data-testid="mission-attach-goal-select"
                                >
                                    {attachableGoals.map((g) => (
                                        <option
                                            key={g.id}
                                            value={g.id}
                                            data-icon={g.status ?? 'unknown'}
                                        >
                                            {linkedGoalIds.has(g.id)
                                                ? t('alreadyLinkedOption', { title: g.title })
                                                : g.title}
                                        </option>
                                    ))}
                                </Select>
                            </label>
                            <div className="flex h-8 items-center gap-3">
                                <Checkbox
                                    label={t('primaryLabel')}
                                    checked={primaryDraft}
                                    onChange={(e) => setPrimaryDraft(e.target.checked)}
                                    data-testid="mission-attach-goal-primary"
                                />
                                <button
                                    type="button"
                                    onClick={handleAttach}
                                    disabled={pending || !goalDraft}
                                    className={cn(btn, 'h-8')}
                                    data-testid="mission-attach-goal-submit"
                                >
                                    <Gauge className="w-3.5 h-3.5" />
                                    {t('attach')}
                                </button>
                            </div>
                        </div>
                        {attachableGoals.length >= 100 ? (
                            <p className="mt-2 text-xs text-text-muted dark:text-text-muted-dark">
                                {t('pickerTruncated')}
                            </p>
                        ) : null}
                    </>
                )}
                <p className="mt-3 text-[11px] text-text-muted dark:text-text-muted-dark">
                    {t('invariantNote')}
                </p>
            </div>

            {/* Detach confirmation — mirrors the Mission delete dialog.
                Rendered inside the section only for code locality: the
                Dialog portals to the document body, so its position in
                this tree has no layout effect. */}
            <Dialog
                open={detachTarget !== null}
                onOpenChange={(next) => {
                    if (!next) closeDetach();
                }}
            >
                <DialogContent className="max-w-md">
                    <DialogClose onClose={closeDetach} />
                    <DialogHeader className="mb-0">
                        <div className="flex items-center gap-3 mb-1">
                            <span className="flex items-center justify-center size-9 rounded-full bg-red-100 dark:bg-red-950/50 shrink-0">
                                <TriangleAlertIcon className="size-4 text-red-600 dark:text-red-400" />
                            </span>
                            <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                                {t('detachDialog.title')}
                            </DialogTitle>
                        </div>
                        <DialogDescription>
                            {t('detachDialog.body', {
                                title: detachTarget?.goal?.title ?? detachTarget?.goalId ?? '',
                            })}
                        </DialogDescription>
                    </DialogHeader>

                    {detachError && (
                        <p
                            role="alert"
                            data-testid="mission-goals-detach-error"
                            className="mt-4 text-xs text-danger"
                        >
                            {detachError}
                        </p>
                    )}

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            data-testid="mission-goals-detach-cancel"
                            disabled={pending}
                            onClick={closeDetach}
                        >
                            {t('detachDialog.cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            data-testid="mission-goals-detach-confirm"
                            loading={pending}
                            onClick={handleDetach}
                        >
                            {pending ? t('detachDialog.detaching') : t('detachDialog.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </section>
    );
}
