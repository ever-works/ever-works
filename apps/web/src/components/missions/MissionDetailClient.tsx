'use client';

import { useMemo, useState, useTransition } from 'react';
import {
    Activity,
    ArrowRight,
    BarChart3,
    CalendarClock,
    CheckCircle2,
    ChevronLeft,
    Copy,
    GitFork,
    Lightbulb,
    Pause,
    Play,
    Radio,
    Settings as SettingsIcon,
    Shield,
    Target,
    Trash2,
    Zap,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Textarea } from '@/components/ui/textarea';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { StatusPill } from '@/components/work-agent';
import { Checkbox } from '@/components/ui/checkbox';
import {
    attachUploadToMissionAction,
    cloneMissionAction,
    completeMissionAction,
    deleteMissionAction,
    detachMissionAttachmentAction,
    pauseMissionAction,
    resumeMissionAction,
    runMissionNowAction,
    updateMissionAction,
} from '@/app/actions/dashboard/missions';
import type {
    Mission,
    MissionAttachmentRow,
    MissionOutcome,
    OwnerBudgetSummary,
} from '@/lib/api/missions';
import type { WorkProposal } from '@/lib/api/work-proposals';
import { IdeaCard } from '@/components/ideas';
import { BudgetSummaryCard } from '@/components/budgets';
import { EntityAttachmentsSection } from '@/components/common/EntityAttachmentsSection';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ShowDateTime } from '@/components/ui/show-datetime';

export interface MissionDetailClientProps {
    mission: Mission;
    ideas: WorkProposal[];
    sourceMission?: Mission | null;
    inheritedIdeas?: WorkProposal[];
    budget?: OwnerBudgetSummary | null;
    attachments?: ReadonlyArray<MissionAttachmentRow>;
}

const RUNNABLE_STATUSES = new Set(['active', 'paused']);
const PAUSABLE_STATUSES = new Set(['active']);
// PR-3 — FAILED Missions can be revived (mirrors the agent-side
// RESUMABLE_STATUSES in packages/agent/src/missions/missions.service.ts).
const RESUMABLE_STATUSES = new Set(['paused', 'failed']);
const COMPLETABLE_STATUSES = new Set(['active', 'paused']);

// PR-3 — the 5 recordable conclusion verdicts (MissionOutcome), in the
// order the Complete dialog offers them. '' = "no verdict" (default).
const MISSION_OUTCOMES: readonly MissionOutcome[] = [
    'succeeded',
    'partially_succeeded',
    'failed',
    'cancelled',
    'superseded',
];

// Outcome-badge recoloring, mirroring the STATUS_STYLES palette used
// by StatusPill so verdict pills read consistently next to status pills.
const OUTCOME_STYLES: Record<MissionOutcome, string> = {
    succeeded: 'bg-success/10 text-success border-success/20',
    partially_succeeded: 'bg-warning/10 text-warning border-warning/20',
    failed: 'bg-danger/10 text-danger border-danger/20',
    cancelled: 'bg-surface-secondary text-text-muted border-border/70',
    superseded: 'bg-info/10 text-info border-info/20',
};

// ─── Shared button classes ────────────────────────────────────────────────

const btn =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

const btnDanger =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-danger/30 dark:border-danger/20 text-danger hover:bg-danger/5 dark:hover:bg-danger/10 transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

// ─── Section header helper ────────────────────────────────────────────────

function SectionHeader({
    icon: Icon,
    title,
    count,
    iconClass,
    tileClass,
}: {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    count?: number;
    iconClass: string;
    tileClass: string;
}) {
    return (
        <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2.5">
                <div
                    className={cn(
                        'w-7 h-7 rounded-md flex items-center justify-center shrink-0 border',
                        tileClass,
                    )}
                >
                    <Icon className={cn('w-3.5 h-3.5', iconClass)} />
                </div>
                <h2 className="text-sm font-semibold text-text dark:text-text-dark">{title}</h2>
            </div>
            {count !== undefined && (
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-border dark:border-border-dark text-text-muted dark:text-text-muted-dark bg-surface-secondary dark:bg-surface-secondary-dark tabular-nums">
                    {count}
                </span>
            )}
        </div>
    );
}

const sectionCard =
    'rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5';

// ─── Component ───────────────────────────────────────────────────────────

export function MissionDetailClient({
    mission: initial,
    ideas,
    sourceMission = null,
    inheritedIdeas = [],
    budget = null,
    attachments = [],
}: MissionDetailClientProps) {
    const t = useTranslations('dashboard.missionDetail');
    const router = useRouter();

    const [mission, setMission] = useState<Mission>(initial);
    const [pendingLifecycle, startLifecycle] = useTransition();
    const [pendingSettings, startSettings] = useTransition();
    const [pendingRunNow, startRunNow] = useTransition();
    const [pendingDelete, startDelete] = useTransition();
    const [pendingClone, startClone] = useTransition();

    const [cloneOpen, setCloneOpen] = useState(false);
    const [cloneTitleDraft, setCloneTitleDraft] = useState('');

    // PR-3 — Complete dialog: outcome verdict select ('' = no verdict).
    const [completeOpen, setCompleteOpen] = useState(false);
    const [outcomeDraft, setOutcomeDraft] = useState<'' | MissionOutcome>('');

    const [scheduleDraft, setScheduleDraft] = useState<string>(mission.schedule ?? '');
    const [autoBuildDraft, setAutoBuildDraft] = useState<boolean>(mission.autoBuildWorks);
    const [capInherit, setCapInherit] = useState<boolean>(mission.outstandingIdeasCap === null);
    const [capValue, setCapValue] = useState<number>(
        mission.outstandingIdeasCap === null ? 20 : mission.outstandingIdeasCap,
    );

    const acceptedWorkLinks = useMemo(
        () =>
            ideas
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
                })),
        [ideas],
    );

    const inheritedWorkLinks = useMemo(
        () =>
            inheritedIdeas
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
                })),
        [inheritedIdeas],
    );

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

    // PR-3 — Closing the complete dialog without completing (Cancel, Escape,
    // outside click) resets the draft so a stale verdict is never pre-selected
    // the next time the dialog opens.
    const handleCompleteOpenChange = (open: boolean) => {
        setCompleteOpen(open);
        if (!open) setOutcomeDraft('');
    };

    // PR-3 — Complete goes through the dialog so the human can record an
    // optional conclusion verdict. '' ("no verdict") sends no outcome,
    // which is exactly today's behavior.
    const handleComplete = () => {
        startLifecycle(async () => {
            try {
                const updated = await completeMissionAction(
                    mission.id,
                    outcomeDraft === '' ? undefined : outcomeDraft,
                );
                setMission(updated);
                setCompleteOpen(false);
                setOutcomeDraft('');
                toast.success(t('toasts.completed'));
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.completeError'));
            }
        });
    };

    const runNow = () => {
        startRunNow(async () => {
            try {
                const result = await runMissionNowAction(mission.id);
                const key = `toasts.runNow.${result.status}` as const;
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
                router.push(ROUTES.DASHBOARD_MISSION(result.mission.id));
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.cloneError'));
            }
        });
    };

    const handleDelete = () => {
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
        <div className="w-full p-6 max-w-screen-2xl mx-auto space-y-6">
            {/* ── Header ───────────────────────────────────────────────────── */}
            <div>
                <Link
                    href={ROUTES.DASHBOARD_MISSIONS}
                    className="inline-flex items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition-colors"
                >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    {t('backToMissions')}
                </Link>

                <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
                    {/* Icon + title + badges + description */}
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                        <div className="shrink-0 w-10 h-10 rounded-xl bg-warning/10 border border-warning/20 flex items-center justify-center">
                            <Target className="w-5 h-5 text-warning" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <h1 className="text-2xl font-semibold text-text dark:text-text-dark leading-tight">
                                {mission.title}
                            </h1>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                <StatusPill status={mission.status} />
                                {mission.outcome && (
                                    <span
                                        title={t('outcomeTooltip')}
                                        className={cn(
                                            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                                            OUTCOME_STYLES[mission.outcome],
                                        )}
                                    >
                                        <CheckCircle2 className="w-3 h-3" />
                                        {t(`outcomes.${mission.outcome}`)}
                                    </span>
                                )}
                                {mission.completedAt && (
                                    <span className="inline-flex items-center gap-1 rounded-full border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 py-0.5 text-[11px] font-medium text-text-muted dark:text-text-muted-dark">
                                        {t('completedAtLabel')}{' '}
                                        <ShowDateTime value={mission.completedAt} />
                                    </span>
                                )}
                                <span
                                    className={cn(
                                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                                        isScheduled
                                            ? 'border-info/30 bg-info/8 dark:bg-info/12 text-info'
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
                            {mission.description && (
                                <p className="mt-2.5 text-sm text-text-secondary dark:text-text-secondary-dark max-w-3xl leading-relaxed">
                                    {mission.description}
                                </p>
                            )}
                        </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {canRunNow && (
                            <button
                                type="button"
                                onClick={runNow}
                                disabled={pendingRunNow}
                                className={btn}
                            >
                                <Zap className="w-3.5 h-3.5" />
                                {t('actions.runNow')}
                            </button>
                        )}
                        {canPause && (
                            <button
                                type="button"
                                onClick={() =>
                                    transition('pause', () => pauseMissionAction(mission.id))
                                }
                                disabled={pendingLifecycle}
                                className={btn}
                            >
                                <Pause className="w-3.5 h-3.5" />
                                {t('actions.pause')}
                            </button>
                        )}
                        {canResume && (
                            <button
                                type="button"
                                onClick={() =>
                                    transition('resume', () => resumeMissionAction(mission.id))
                                }
                                disabled={pendingLifecycle}
                                className={btn}
                            >
                                <Play className="w-3.5 h-3.5" />
                                {t('actions.resume')}
                            </button>
                        )}
                        {canComplete && (
                            <button
                                type="button"
                                onClick={() => setCompleteOpen(true)}
                                disabled={pendingLifecycle}
                                className={btn}
                            >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                {t('actions.complete')}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => setCloneOpen(true)}
                            disabled={pendingClone}
                            className={btn}
                        >
                            <Copy className="w-3.5 h-3.5" />
                            {t('actions.clone')}
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
            </div>

            {/* ── Settings ─────────────────────────────────────────────────── */}
            <section className={sectionCard}>
                <SectionHeader
                    icon={SettingsIcon}
                    title={t('sections.settings')}
                    tileClass="bg-surface-secondary dark:bg-surface-secondary-dark border-border/60 dark:border-border-dark/60"
                    iconClass="text-text-secondary dark:text-text-secondary-dark"
                />
                <div className="space-y-4">
                    {/* Toggles — flex row above the inputs */}
                    <div className="flex items-center gap-2.5 flex-wrap">
                        <Checkbox
                            label={t('fields.autoBuildWorks')}
                            checked={autoBuildDraft}
                            onChange={(e) => setAutoBuildDraft(e.target.checked)}
                        />
                        <Checkbox
                            label={t('fields.capInherit')}
                            checked={capInherit}
                            onChange={(e) => setCapInherit(e.target.checked)}
                        />
                    </div>

                    {/* Inputs below */}
                    <div className="grid gap-4 @xl/main:grid-cols-1">
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
                        {!capInherit && (
                            <Input
                                type="number"
                                label={t('fields.outstandingCap')}
                                value={capValue}
                                min={-1}
                                max={1000}
                                onChange={(e) => setCapValue(Number(e.target.value))}
                            />
                        )}
                    </div>
                </div>
                <div className="mt-5 pt-4 border-t border-border/60 dark:border-border-dark/60">
                    <button onClick={saveSettings} disabled={pendingSettings} className={btn}>
                        {t('actions.saveSettings')}
                    </button>
                </div>
            </section>

            {/* ── Guardrails ───────────────────────────────────────────────── */}
            <section className={sectionCard}>
                <SectionHeader
                    icon={Shield}
                    title={t('sections.guardrails')}
                    tileClass="bg-warning/10 border-warning/20"
                    iconClass="text-warning"
                />
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {mission.guardrailsOverride &&
                    Object.keys(mission.guardrailsOverride).length > 0
                        ? t('guardrails.activeOverride')
                        : t('guardrails.inheriting')}
                </p>
            </section>

            {/* ── Activity + Spend ─────────────────────────────────────────── */}
            <div className="grid gap-5 @3xl/main:grid-cols-2">
                <section className={sectionCard}>
                    <SectionHeader
                        icon={Activity}
                        title={t('sections.activity')}
                        tileClass="bg-info/10 border-info/20"
                        iconClass="text-info"
                    />
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('activity.empty')}
                    </p>
                </section>

                <section className={sectionCard}>
                    <SectionHeader
                        icon={BarChart3}
                        title={t('sections.spend')}
                        tileClass="bg-success/10 border-success/20"
                        iconClass="text-success"
                    />
                    {budget ? (
                        <BudgetSummaryCard summary={budget} />
                    ) : (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('spend.empty')}
                        </p>
                    )}
                </section>
            </div>

            {/* ── Live runs ────────────────────────────────────────────────── */}
            <section className={sectionCard}>
                <SectionHeader
                    icon={Radio}
                    title={t('sections.liveRuns')}
                    tileClass="bg-violet-500/10 border-violet-500/20"
                    iconClass="text-violet-600 dark:text-violet-400"
                />
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('liveRuns.empty')}
                </p>
            </section>

            {/* ── Ideas ────────────────────────────────────────────────────── */}
            <section className={sectionCard}>
                <SectionHeader
                    icon={Lightbulb}
                    title={t('sections.ideas')}
                    count={ideas.length}
                    tileClass="bg-amber-500/10 border-amber-500/20"
                    iconClass="text-amber-600 dark:text-amber-400"
                />
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

            {/* ── Related Works ────────────────────────────────────────────── */}
            <section className={sectionCard}>
                <SectionHeader
                    icon={GitFork}
                    title={t('sections.relatedWorks')}
                    count={acceptedWorkLinks.length}
                    tileClass="bg-primary/10 border-primary/20"
                    iconClass="text-primary"
                />
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
                                    className="flex items-center gap-3 p-3 rounded-lg border border-border/60 dark:border-border-dark/60 hover:border-border dark:hover:border-border-dark bg-surface/30 dark:bg-surface-dark/30 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors group"
                                >
                                    <span className="text-sm font-medium text-text dark:text-text-dark group-hover:text-primary transition-colors truncate flex-1">
                                        {w.ideaTitle}
                                    </span>
                                    <ArrowRight className="w-3.5 h-3.5 text-text-muted shrink-0" />
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {/* ── Inherited Works (cloned missions only) ───────────────────── */}
            {mission.sourceMissionId && (
                <section className={sectionCard}>
                    <SectionHeader
                        icon={GitFork}
                        title={t('sections.inheritedWorks')}
                        count={inheritedWorkLinks.length}
                        tileClass="bg-surface-secondary dark:bg-surface-secondary-dark border-border/60 dark:border-border-dark/60"
                        iconClass="text-text-secondary dark:text-text-secondary-dark"
                    />
                    {sourceMission && (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark -mt-2 mb-4">
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
                                        className="flex items-center gap-3 p-3 rounded-lg border border-border/60 dark:border-border-dark/60 hover:border-border dark:hover:border-border-dark bg-surface/30 dark:bg-surface-dark/30 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors group"
                                    >
                                        <span className="text-sm font-medium text-text dark:text-text-dark group-hover:text-primary transition-colors truncate flex-1">
                                            {w.ideaTitle}
                                        </span>
                                        <ArrowRight className="w-3.5 h-3.5 text-text-muted shrink-0" />
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            )}

            {/* ── Attachments ──────────────────────────────────────────────── */}
            <EntityAttachmentsSection
                initial={attachments}
                onAttach={(uploadId) => attachUploadToMissionAction(mission.id, uploadId)}
                onDetach={(attachmentId) => detachMissionAttachmentAction(mission.id, attachmentId)}
                testId="mission-attachments"
            />

            {/* ── Clone modal ──────────────────────────────────────────────── */}
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
                        <button
                            type="button"
                            onClick={() => setCloneOpen(false)}
                            disabled={pendingClone}
                            className={btn}
                        >
                            {t('clone.cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={handleClone}
                            disabled={pendingClone}
                            className={btn}
                        >
                            <Copy className="w-3.5 h-3.5" />
                            {t('clone.confirm')}
                        </button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Complete modal (PR-3 — optional outcome verdict) ─────────── */}
            <Dialog open={completeOpen} onOpenChange={handleCompleteOpenChange}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('completeDialog.title')}</DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('completeDialog.description')}
                    </p>
                    <label className="block mt-3 space-y-1.5">
                        <span className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('completeDialog.outcomeLabel')}
                        </span>
                        <Select
                            value={outcomeDraft}
                            onValueChange={(v) => setOutcomeDraft(v as '' | MissionOutcome)}
                            data-testid="mission-complete-outcome-select"
                        >
                            <option value="">{t('completeDialog.noVerdict')}</option>
                            {MISSION_OUTCOMES.map((o) => (
                                <option key={o} value={o}>
                                    {t(`outcomes.${o}`)}
                                </option>
                            ))}
                        </Select>
                    </label>
                    <DialogFooter>
                        <button
                            type="button"
                            onClick={() => handleCompleteOpenChange(false)}
                            disabled={pendingLifecycle}
                            className={btn}
                        >
                            {t('completeDialog.cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={handleComplete}
                            disabled={pendingLifecycle}
                            className={btn}
                            data-testid="mission-complete-confirm"
                        >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            {t('completeDialog.confirm')}
                        </button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
