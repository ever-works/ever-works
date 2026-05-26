'use client';

import { useMemo, useState, useTransition } from 'react';
import {
    Activity,
    BarChart3,
    CalendarClock,
    CheckCircle2,
    ChevronLeft,
    Copy,
    GitFork,
    Pause,
    Play,
    Settings as SettingsIcon,
    Target,
    Trash2,
    Zap,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { NumberField, StatusPill, ToggleRow } from '@/components/work-agent';
import {
    cloneMissionAction,
    completeMissionAction,
    deleteMissionAction,
    pauseMissionAction,
    resumeMissionAction,
    runMissionNowAction,
    updateMissionAction,
} from '@/app/actions/dashboard/missions';
import type { Mission, OwnerBudgetSummary } from '@/lib/api/missions';
import type { WorkProposal } from '@/lib/api/work-proposals';
import { IdeaCard } from '@/components/ideas';
import { BudgetSummaryCard } from '@/components/budgets';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/**
 * Phase 6 PR R — Mission detail page client. First UI consumer
 * of the full Phase 3 Missions write API.
 *
 * Surfaces the seven sections the spec §1.3 lays out:
 *   1. Header — back link, title, status + type badges, action
 *      buttons (Pause / Resume / Complete / Delete / Run-now).
 *   2. Settings — schedule cron Textarea, auto-build ToggleRow,
 *      outstanding-Ideas cap NumberField. Save sends a single
 *      PATCH covering all three.
 *   3. Guardrails — collapsed placeholder pane for v1 (the
 *      sparse-override editor is a follow-up tick; surface lives
 *      here so users see the section heading even before the
 *      editor lands).
 *   4. Live runs — LIST per Decision A15. v1 shows the empty
 *      state ("No active runs") since Mission ticks don't yet
 *      produce queryable run records — the section lays the
 *      ground for PR GG / PR J's wiring without committing to
 *      a shape that may shift.
 *   5. Ideas — every Idea attached to this Mission (filtered by
 *      missionId), rendered via PR M's IdeaCard.
 *   6. Related Works — every Work built from this Mission's
 *      Ideas (derived from accepted IDs).
 *   7. Clone affordance — visible if `sourceMissionId` is set.
 */
export interface MissionDetailClientProps {
    mission: Mission;
    ideas: WorkProposal[];
    /**
     * Phase 6 PR GG — the source Mission this one was Cloned
     * from, if any. NULL for direct-created Missions (the common
     * case). When set, the "Related Works (inherited)" panel
     * renders below the Related Works panel.
     */
    sourceMission?: Mission | null;
    /**
     * Phase 6 PR GG — ACCEPTED Ideas attached to the source
     * Mission. Used to derive the inherited Works list (those
     * Ideas' `acceptedWorkId` values). Decision A26: Works are
     * NOT duplicated during Clone, but the cloned Mission's
     * detail page surfaces them as read-only inherited
     * references.
     */
    inheritedIdeas?: WorkProposal[];
    /**
     * Phase 7 PR V — current-period spend + cap status for this
     * Mission, fetched server-side via `missionsAPI.getBudget`.
     * `null` when the budget endpoint failed (the Spend section
     * gracefully falls back to its empty surface).
     */
    budget?: OwnerBudgetSummary | null;
}

const RUNNABLE_STATUSES = new Set(['active', 'paused']);
const PAUSABLE_STATUSES = new Set(['active']);
const RESUMABLE_STATUSES = new Set(['paused']);
const COMPLETABLE_STATUSES = new Set(['active', 'paused']);

export function MissionDetailClient({
    mission: initial,
    ideas,
    sourceMission = null,
    inheritedIdeas = [],
    budget = null,
}: MissionDetailClientProps) {
    const t = useTranslations('dashboard.missionDetail');
    const router = useRouter();

    const [mission, setMission] = useState<Mission>(initial);
    const [pendingLifecycle, startLifecycle] = useTransition();
    const [pendingSettings, startSettings] = useTransition();
    const [pendingRunNow, startRunNow] = useTransition();
    const [pendingDelete, startDelete] = useTransition();
    const [pendingClone, startClone] = useTransition();

    // Phase 6 PR GG — Clone modal state.
    const [cloneOpen, setCloneOpen] = useState(false);
    const [cloneTitleDraft, setCloneTitleDraft] = useState('');

    // Editable mirrors of the per-Mission knobs.
    const [scheduleDraft, setScheduleDraft] = useState<string>(mission.schedule ?? '');
    const [autoBuildDraft, setAutoBuildDraft] = useState<boolean>(mission.autoBuildWorks);
    // -1 sentinel means "unlimited"; null means "inherit user default".
    // The NumberField primitive only handles numbers, so we encode the
    // inherit case as a separate boolean toggle.
    const [capInherit, setCapInherit] = useState<boolean>(mission.outstandingIdeasCap === null);
    const [capValue, setCapValue] = useState<number>(
        mission.outstandingIdeasCap === null ? 20 : mission.outstandingIdeasCap,
    );

    // Derived: which Ideas are accepted with a real Work id? Those
    // are the entries the Related Works panel surfaces.
    const acceptedWorkLinks = useMemo(() => {
        return ideas
            .filter(
                (i) =>
                    i.status === 'accepted' &&
                    typeof i.acceptedWorkId === 'string' &&
                    i.acceptedWorkId.length > 0,
            )
            .map((i) => ({
                ideaId: i.id,
                ideaTitle: i.title,
                workId: i.acceptedWorkId as string,
            }));
    }, [ideas]);

    // Phase 6 PR GG — inherited Works derived from the source
    // Mission's accepted Ideas. Same shape as acceptedWorkLinks
    // so the panel render path can be uniform.
    const inheritedWorkLinks = useMemo(() => {
        return inheritedIdeas
            .filter(
                (i) =>
                    i.status === 'accepted' &&
                    typeof i.acceptedWorkId === 'string' &&
                    i.acceptedWorkId.length > 0,
            )
            .map((i) => ({
                ideaId: i.id,
                ideaTitle: i.title,
                workId: i.acceptedWorkId as string,
            }));
    }, [inheritedIdeas]);

    const saveSettings = () => {
        startSettings(async () => {
            try {
                const updated = await updateMissionAction(mission.id, {
                    schedule: mission.type === 'scheduled' ? scheduleDraft.trim() || null : null,
                    autoBuildWorks: autoBuildDraft,
                    outstandingIdeasCap: capInherit ? null : capValue,
                });
                setMission(updated);
                toast.success(t('toasts.settingsSaved'));
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.settingsError'));
            }
        });
    };

    const transition = (verb: 'pause' | 'resume' | 'complete', action: () => Promise<Mission>) => {
        startLifecycle(async () => {
            try {
                const updated = await action();
                setMission(updated);
                toast.success(t(`toasts.${verb}d`));
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t(`toasts.${verb}Error`));
            }
        });
    };

    const runNow = () => {
        startRunNow(async () => {
            try {
                const result = await runMissionNowAction(mission.id);
                const key = `toasts.runNow.${result.status}` as const;
                // Best-effort i18n; fall back to the raw status if
                // the key isn't present yet.
                try {
                    toast.success(t(key));
                } catch {
                    toast.success(`Run now: ${result.status}`);
                }
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.runNowError'));
            }
        });
    };

    const handleClone = () => {
        startClone(async () => {
            try {
                const result = await cloneMissionAction(
                    mission.id,
                    cloneTitleDraft.trim() || undefined,
                );
                toast.success(
                    t('toasts.cloned', {
                        ideasCloned: result.ideasCloned,
                        ideasSkipped: result.ideasSkipped,
                    }),
                );
                setCloneOpen(false);
                setCloneTitleDraft('');
                // Navigate to the new clone's detail page so the
                // user sees their fork immediately.
                router.push(ROUTES.DASHBOARD_MISSION(result.mission.id));
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.cloneError'));
            }
        });
    };

    const handleDelete = () => {
        // Hard-confirm via `window.confirm` so an accidental click
        // doesn't nuke the Mission + cascade through child Ideas. A
        // dialog component is overkill for v1.
        if (!window.confirm(t('confirm.delete'))) return;
        startDelete(async () => {
            try {
                await deleteMissionAction(mission.id);
                toast.success(t('toasts.deleted'));
                router.push(ROUTES.DASHBOARD_MISSIONS);
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.deleteError'));
            }
        });
    };

    const canPause = PAUSABLE_STATUSES.has(mission.status);
    const canResume = RESUMABLE_STATUSES.has(mission.status);
    const canComplete = COMPLETABLE_STATUSES.has(mission.status);
    const canRunNow = RUNNABLE_STATUSES.has(mission.status);
    const isScheduled = mission.type === 'scheduled';

    return (
        <div className="w-full overflow-auto p-6 max-w-screen-2xl mx-auto space-y-6">
            {/* Back link + header */}
            <div>
                <Link
                    href={ROUTES.DASHBOARD_MISSIONS}
                    className="inline-flex items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    {t('backToMissions')}
                </Link>
                <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                        <div className="shrink-0 w-10 h-10 rounded-lg bg-warning/10 border border-warning/20 flex items-center justify-center">
                            <Target className="w-5 h-5 text-warning" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <h1 className="text-2xl font-semibold text-text dark:text-text-dark leading-tight">
                                {mission.title}
                            </h1>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                <StatusPill status={mission.status} />
                                <span
                                    className={cn(
                                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                                        isScheduled
                                            ? 'border-info/30 bg-info/5 dark:bg-info/10 text-info'
                                            : 'border-border dark:border-border-dark bg-surface dark:bg-surface-dark text-text-muted dark:text-text-muted-dark',
                                    )}
                                >
                                    {isScheduled && <CalendarClock className="w-3 h-3" />}
                                    {t(isScheduled ? 'badges.scheduled' : 'badges.oneShot')}
                                </span>
                                {mission.sourceMissionId && (
                                    <span
                                        title={t('badges.clonedTooltip')}
                                        className="inline-flex items-center gap-1 rounded-full border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 py-0.5 text-[11px] font-medium text-text-muted dark:text-text-muted-dark"
                                    >
                                        <GitFork className="w-3 h-3" />
                                        {t('badges.cloned')}
                                    </span>
                                )}
                            </div>
                            <p className="mt-3 text-sm text-text-secondary dark:text-text-secondary-dark max-w-3xl">
                                {mission.description}
                            </p>
                        </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">
                        {canRunNow && (
                            <Button
                                type="button"
                                size="sm"
                                className="gap-1.5"
                                onClick={runNow}
                                disabled={pendingRunNow}
                            >
                                <Zap className="w-3.5 h-3.5" />
                                {t('actions.runNow')}
                            </Button>
                        )}
                        {canPause && (
                            <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                className="gap-1.5"
                                onClick={() =>
                                    transition('pause', () => pauseMissionAction(mission.id))
                                }
                                disabled={pendingLifecycle}
                            >
                                <Pause className="w-3.5 h-3.5" />
                                {t('actions.pause')}
                            </Button>
                        )}
                        {canResume && (
                            <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                className="gap-1.5"
                                onClick={() =>
                                    transition('resume', () => resumeMissionAction(mission.id))
                                }
                                disabled={pendingLifecycle}
                            >
                                <Play className="w-3.5 h-3.5" />
                                {t('actions.resume')}
                            </Button>
                        )}
                        {canComplete && (
                            <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                className="gap-1.5"
                                onClick={() =>
                                    transition('complete', () => completeMissionAction(mission.id))
                                }
                                disabled={pendingLifecycle}
                            >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                {t('actions.complete')}
                            </Button>
                        )}
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="gap-1.5"
                            onClick={() => setCloneOpen(true)}
                            disabled={pendingClone}
                        >
                            <Copy className="w-3.5 h-3.5" />
                            {t('actions.clone')}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="gap-1.5 text-danger hover:text-danger"
                            onClick={handleDelete}
                            disabled={pendingDelete}
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            {t('actions.delete')}
                        </Button>
                    </div>
                </div>
            </div>

            {/* Settings section */}
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                <div className="flex items-center gap-2 mb-4">
                    <SettingsIcon className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                    <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('sections.settings')}
                    </h2>
                </div>
                <div className="grid gap-4 @3xl/main:grid-cols-2">
                    {isScheduled && (
                        <label className="space-y-1.5">
                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('fields.schedule')}
                            </span>
                            <Textarea
                                value={scheduleDraft}
                                onChange={(e) => setScheduleDraft(e.target.value)}
                                rows={1}
                                placeholder="0 9 * * MON"
                                className="font-mono text-xs"
                            />
                        </label>
                    )}
                    <div className="space-y-2">
                        <ToggleRow
                            label={t('fields.autoBuildWorks')}
                            checked={autoBuildDraft}
                            onChange={setAutoBuildDraft}
                        />
                        <ToggleRow
                            label={t('fields.capInherit')}
                            checked={capInherit}
                            onChange={setCapInherit}
                        />
                    </div>
                    {!capInherit && (
                        <NumberField
                            label={t('fields.outstandingCap')}
                            value={capValue}
                            min={-1}
                            max={1000}
                            onChange={setCapValue}
                        />
                    )}
                </div>
                <div className="mt-4">
                    <Button size="sm" onClick={saveSettings} disabled={pendingSettings}>
                        {t('actions.saveSettings')}
                    </Button>
                </div>
            </section>

            {/* Guardrails section (placeholder for v1; sparse-override
                editor lands in a follow-up tick). */}
            <section className="rounded-lg border border-border/50 dark:border-border-dark/50 bg-surface/40 dark:bg-surface-dark/30 p-4">
                <h2 className="text-sm font-semibold text-text dark:text-text-dark mb-1">
                    {t('sections.guardrails')}
                </h2>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {mission.guardrailsOverride &&
                    Object.keys(mission.guardrailsOverride).length > 0
                        ? t('guardrails.activeOverride')
                        : t('guardrails.inheriting')}
                </p>
            </section>

            {/* Phase 6 PR GG — Activity timeline + Spend-over-time pair.
                Both are "wired surfaces, empty data" v1 placeholders.
                Activity-feed shape lives behind PR J's tick events
                (the Mission run record doesn't yet emit timeline
                events); spend buckets come from Phase 7 PR U's
                budget query. The sections render the heading + the
                empty state so users see the planned surface even
                before the data wires through, and the layout
                doesn't reshuffle later. */}
            <div className="grid gap-6 @3xl/main:grid-cols-2">
                <section className="rounded-lg border border-border/50 dark:border-border-dark/50 bg-surface/40 dark:bg-surface-dark/30 p-4">
                    <div className="flex items-center gap-2 mb-2">
                        <Activity className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                        <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                            {t('sections.activity')}
                        </h2>
                    </div>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('activity.empty')}
                    </p>
                </section>
                <section className="rounded-lg border border-border/50 dark:border-border-dark/50 bg-surface/40 dark:bg-surface-dark/30 p-4">
                    <div className="flex items-center gap-2 mb-3">
                        <BarChart3 className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                        <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                            {t('sections.spend')}
                        </h2>
                    </div>
                    {/* Phase 7 PR V — real BudgetSummaryCard replaces the
                        PR GG v1 placeholder when the budget endpoint
                        returns. Page-level fetch already catch-defended
                        so `budget = null` only when the API failed —
                        keep the original placeholder copy in that
                        branch so the section still occupies its slot. */}
                    {budget ? (
                        <BudgetSummaryCard summary={budget} />
                    ) : (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('spend.empty')}
                        </p>
                    )}
                </section>
            </div>

            {/* Live runs section (Decision A15 — LIST shape, not single
                run). v1 lists nothing because Mission ticks don't yet
                produce queryable run records; PR J / PR GG wires it. */}
            <section className="rounded-lg border border-border/50 dark:border-border-dark/50 bg-surface/40 dark:bg-surface-dark/30 p-4">
                <h2 className="text-sm font-semibold text-text dark:text-text-dark mb-2">
                    {t('sections.liveRuns')}
                </h2>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('liveRuns.empty')}
                </p>
            </section>

            {/* Ideas list section */}
            <section className="rounded-lg border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-4">
                <h2 className="text-sm font-semibold text-text dark:text-text-dark mb-3">
                    {t('sections.ideas')} ({ideas.length})
                </h2>
                {ideas.length === 0 ? (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('ideas.empty')}
                    </p>
                ) : (
                    <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
                        {ideas.map((i) => (
                            <IdeaCard key={i.id} proposal={i} />
                        ))}
                    </div>
                )}
            </section>

            {/* Related Works section */}
            <section className="rounded-lg border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-4">
                <h2 className="text-sm font-semibold text-text dark:text-text-dark mb-3">
                    {t('sections.relatedWorks')} ({acceptedWorkLinks.length})
                </h2>
                {acceptedWorkLinks.length === 0 ? (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('works.empty')}
                    </p>
                ) : (
                    <ul className="space-y-2">
                        {acceptedWorkLinks.map((w) => (
                            <li key={w.workId}>
                                <Link
                                    href={ROUTES.DASHBOARD_WORK(w.workId)}
                                    className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                                >
                                    {w.ideaTitle}
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {/* Phase 6 PR GG — Related Works (inherited) panel.
                Renders only when this Mission is a Full-Fork Clone
                (sourceMissionId set, Decision A26). Works from the
                source Mission are NOT duplicated during Clone — this
                panel surfaces them as read-only references. */}
            {mission.sourceMissionId && (
                <section className="rounded-lg border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-4">
                    <div className="flex items-center gap-2 mb-1">
                        <GitFork className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                        <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                            {t('sections.inheritedWorks')} ({inheritedWorkLinks.length})
                        </h2>
                    </div>
                    {sourceMission && (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mb-3">
                            {t('inherited.fromSource')}{' '}
                            <Link
                                href={ROUTES.DASHBOARD_MISSION(sourceMission.id)}
                                className="text-primary hover:underline"
                            >
                                {sourceMission.title}
                            </Link>
                        </p>
                    )}
                    {inheritedWorkLinks.length === 0 ? (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('inherited.empty')}
                        </p>
                    ) : (
                        <ul className="space-y-2">
                            {inheritedWorkLinks.map((w) => (
                                <li key={w.workId}>
                                    <Link
                                        href={ROUTES.DASHBOARD_WORK(w.workId)}
                                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                                    >
                                        {w.ideaTitle}
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            )}

            {/* Phase 6 PR GG — Clone confirmation modal. Opens from
                the toolbar Clone button. Optional title override; on
                confirm calls cloneMissionAction and navigates to the
                new fork's detail page. */}
            <Dialog open={cloneOpen} onOpenChange={setCloneOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('clone.title')}</DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('clone.description')}
                    </p>
                    <label className="block mt-3 space-y-1.5">
                        <span className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('clone.titleLabel')}
                        </span>
                        <Input
                            value={cloneTitleDraft}
                            onChange={(e) => setCloneTitleDraft(e.target.value)}
                            placeholder={`Copy of ${mission.title}`}
                            maxLength={200}
                        />
                    </label>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => setCloneOpen(false)}
                            disabled={pendingClone}
                        >
                            {t('clone.cancel')}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            className="gap-1.5"
                            onClick={handleClone}
                            disabled={pendingClone}
                        >
                            <Copy className="w-3.5 h-3.5" />
                            {t('clone.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
