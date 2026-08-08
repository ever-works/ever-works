'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
    AlertTriangle,
    ArrowRight,
    Bot,
    Boxes,
    CheckCircle2,
    ChevronLeft,
    ChevronRight,
    CircleDashed,
    Hammer,
    Info,
    Lightbulb,
    Loader2,
    Radio,
    RefreshCw,
    RotateCcw,
    Target,
    Trash2,
    TriangleAlertIcon,
} from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { toast } from 'sonner';
import type {
    IdeaWorkLink,
    WorkProposal,
    WorkProposalAttachmentRow,
    WorkProposalStatus,
} from '@/lib/api/work-proposals';
import type { Agent } from '@/lib/api/agents';
import {
    attachUploadToIdeaAction,
    deleteIdeaAction,
    detachIdeaAttachmentAction,
    getProposalAction,
    rebuildIdeaAction,
    retryIdeaAction,
} from '@/app/actions/dashboard/work-proposals';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { EntityAttachmentsSection } from '@/components/common/EntityAttachmentsSection';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { ShowDateTime } from '@/components/ui/show-datetime';
import { STATUS_STYLES } from './idea-status';
import { deriveIdeaBuiltState } from './idea-built';

/**
 * Live poll cadence + safety deadline. Mirrors `WorkProposalsSection`
 * so an Idea watched here refreshes on the same rhythm the home
 * preview uses. 10-minute ceiling stops a wedged build from polling
 * forever if the user leaves the tab open.
 */
const POLL_INTERVAL_MS = 2_500;
const POLL_MAX_MS = 10 * 60_000;

/**
 * Non-terminal statuses whose row is expected to change on its own
 * (a background build is running). Only these trigger live polling;
 * everything else is a settled state and stays static.
 */
const IN_PROGRESS: ReadonlySet<WorkProposalStatus> = new Set(['queued', 'building']);

/**
 * Badge tints for the Idea→Work link kinds (PR-1, `idea_works`).
 * Mirrors the `STATUS_STYLES` palette so kinds read like statuses:
 * success-green for a Work the platform built, sky for a manually
 * linked Work, amber for a rebuild.
 */
const KIND_BADGE: Record<IdeaWorkLink['kind'], string> = {
    built: 'bg-success/10 text-success ring-success/20',
    linked: 'bg-sky-500/10 text-sky-600 dark:text-sky-300 ring-sky-500/20',
    rebuilt: 'bg-amber-500/10 text-amber-600 dark:text-amber-300 ring-amber-500/20',
};

// ─── Shared surface classes ───────────────────────────────────────────────
// Same tokens the Mission detail page uses, so the two entity pages read
// as one design rather than two.

const btn =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

const btnPrimary =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-primary bg-primary text-white hover:bg-primary/90 transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

const btnDanger =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-danger/30 dark:border-danger/20 text-danger hover:bg-danger/5 dark:hover:bg-danger/10 transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

const sectionCard =
    'rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5';

const SECTION_ICON_TILE =
    'bg-surface-secondary dark:bg-surface-secondary-dark border-border/60 dark:border-border-dark/60';

function SectionHeader({
    icon: Icon,
    title,
    count,
    action,
}: {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    count?: number;
    action?: React.ReactNode;
}) {
    return (
        <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex min-w-0 items-center gap-2.5">
                <div
                    className={cn(
                        'w-7 h-7 rounded-md flex items-center justify-center shrink-0 border',
                        SECTION_ICON_TILE,
                    )}
                >
                    <Icon className="w-3.5 h-3.5 text-text-secondary dark:text-text-secondary-dark" />
                </div>
                <h2 className="truncate text-sm font-semibold text-text dark:text-text-dark">
                    {title}
                </h2>
                {count !== undefined && (
                    <span className="shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full border border-border dark:border-border-dark text-text-muted dark:text-text-muted-dark bg-surface-secondary dark:bg-surface-secondary-dark tabular-nums">
                        {count}
                    </span>
                )}
            </div>
            {action}
        </div>
    );
}

const emptyText = 'text-xs text-text-muted dark:text-text-muted-dark';

// ─── Build tracker ────────────────────────────────────────────────────────

/**
 * The stages an Idea can move through on its way to a Work, rendered as
 * a vertical tracker in the rail so "has this been built yet?" is
 * answerable at a glance.
 *
 * `builtDirect` is a distinct terminal stage from `built`: an Idea built
 * through `/works/new?proposal=…` never queued and never ran the Work
 * Agent, so it must not claim it did.
 */
type BuildStage = 'drafted' | 'queued' | 'building' | 'built' | 'builtDirect';

/**
 * Per-step state. Explicit rather than derived from a "how far did we
 * get" index — the index model can't express a step that was genuinely
 * skipped, and it forced contradictions like a red `failed` step feeding
 * a green `built` one.
 */
type StepState = 'done' | 'current' | 'failed' | 'pending';

interface BuildStep {
    stage: BuildStage;
    state: StepState;
}

/**
 * The tracker describes the LATEST build attempt, not the Idea's whole
 * history. That separation is what makes it readable: this list answers
 * "what is happening / what just happened", while the header's Built
 * badge and the View Work link below answer "what exists".
 *
 * Without it a failed rebuild rendered as `Building ✗` followed by
 * `Built ✓` — two contradictory terminal states in one column.
 *
 * `viaPipeline` distinguishes the two ways an Idea gets built:
 *   - the Work Agent pipeline (`idea_works.kind` of `built` / `rebuilt`),
 *     which really does pass through queued → building;
 *   - the Work builder form (`kind` of `linked`), which skips both. The
 *     old tracker showed those two steps as completed anyway, inventing
 *     a history that never happened.
 */
function buildTimeline(input: {
    status: WorkProposalStatus;
    isBuilt: boolean;
    viaPipeline: boolean;
}): BuildStep[] {
    const { status, isBuilt, viaPipeline } = input;
    const drafted: BuildStep = { stage: 'drafted', state: 'done' };

    // A build is running right now — show the full pipeline with the live
    // step marked, whatever this Idea produced on an earlier run.
    if (status === 'queued') {
        return [
            drafted,
            { stage: 'queued', state: 'current' },
            { stage: 'building', state: 'pending' },
            { stage: 'built', state: 'pending' },
        ];
    }
    if (status === 'building') {
        return [
            drafted,
            { stage: 'queued', state: 'done' },
            { stage: 'building', state: 'current' },
            { stage: 'built', state: 'pending' },
        ];
    }

    // The latest attempt failed. It is terminal for this run, so the
    // tracker stops here — which is also exactly where Retry sits.
    if (status === 'failed') {
        return [
            drafted,
            { stage: 'queued', state: 'done' },
            { stage: 'building', state: 'failed' },
        ];
    }

    if (isBuilt) {
        return viaPipeline
            ? [
                  drafted,
                  { stage: 'queued', state: 'done' },
                  { stage: 'building', state: 'done' },
                  { stage: 'built', state: 'done' },
              ]
            : [drafted, { stage: 'builtDirect', state: 'done' }];
    }

    // Nothing has been asked of the builder yet (pending / dismissed).
    // `drafted` is where the Idea actually IS, so mark it current rather
    // than done — the old tracker left every step unlit.
    return [
        { stage: 'drafted', state: 'current' },
        { stage: 'queued', state: 'pending' },
        { stage: 'building', state: 'pending' },
        { stage: 'built', state: 'pending' },
    ];
}

interface IdeaDetailClientProps {
    idea: WorkProposal;
    /**
     * PR-1 (Idea↔Work provenance) — the Idea's `idea_works` links,
     * server-resolved by the page (newest first). Also the authoritative
     * answer to "was this ever built?": a `built` / `rebuilt` row means
     * the platform produced a Work from this Idea, even if the
     * denormalized `acceptedWorkId` was later cleared.
     */
    initialLinks?: IdeaWorkLink[];
    /**
     * A Work whose name + description match this Idea's title +
     * description, resolved server-side by the page
     * (`idea-work-match.ts`). The fallback answer to "was this built?"
     * for a Work created outside the Idea flow, which leaves no
     * provenance link behind. `null` ⇒ no match.
     */
    matchedWorkId?: string | null;
    /** Idea-scoped Agents (`GET /agents?ideaId=`). */
    agents?: Agent[];
    /** Uploads attached to this Idea (`GET :id/attachments`). */
    attachments?: WorkProposalAttachmentRow[];
    /** Parent Mission title, when this Idea was spawned by one. */
    missionTitle?: string | null;
}

/**
 * `/ideas/[id]` detail body — a two-column entity page matching the
 * Mission detail layout: actions on the breadcrumb line, the Idea's
 * own content in the main column, and a context rail carrying the
 * build tracker, Agents and metadata.
 *
 * It stays a client island because a `queued`/`building` Idea updates
 * in place: the tracker advances, the status badge animates, and the
 * primary CTA swaps to "View Work" the moment the background build
 * finishes. Terminal Ideas render once with no polling.
 */
export function IdeaDetailClient({
    idea: initialIdea,
    initialLinks = [],
    matchedWorkId = null,
    agents = [],
    attachments = [],
    missionTitle = null,
}: IdeaDetailClientProps) {
    const t = useTranslations('dashboard.proposals');
    const tPage = useTranslations('dashboard.ideasPage');
    const tDetail = useTranslations('dashboard.ideasPage.detail');
    const locale = useLocale();
    const router = useRouter();

    const [idea, setIdea] = useState<WorkProposal>(initialIdea);
    // Links are NOT client state: the only thing that appends an
    // `idea_works` row is a server-side build, so they arrive with the
    // server render and refresh via `router.refresh()`. Mirroring them
    // into state would only add a stale copy to keep in sync.
    const links = initialLinks;
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [pendingBuild, startBuild] = useTransition();
    const [pendingDelete, startDelete] = useTransition();

    const isLive = IN_PROGRESS.has(idea.status);

    // Announce the terminal transition once. Keyed off the previous
    // status via a ref so a re-render can't fire the toast twice.
    const prevStatusRef = useRef<WorkProposalStatus>(initialIdea.status);

    useEffect(() => {
        if (!IN_PROGRESS.has(idea.status)) return;
        let cancelled = false;
        const deadline = Date.now() + POLL_MAX_MS;

        const loop = async () => {
            while (!cancelled && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
                if (cancelled) return;
                try {
                    const next = await getProposalAction(idea.id);
                    if (cancelled) return;
                    if (!next) {
                        // `null` is a definitive 404/403 — the Idea was
                        // deleted or access was revoked. Stop polling and
                        // tell the user instead of freezing on a stale page,
                        // then send them back to the catalog.
                        toast.error(tPage('toasts.ideaGone'));
                        router.replace(ROUTES.DASHBOARD_IDEAS);
                        return;
                    }
                    setIdea(next);
                    if (!IN_PROGRESS.has(next.status)) {
                        // A finished build appends an `idea_works` row the
                        // client can't see (links are server-resolved), so
                        // refresh the server component for the new link.
                        router.refresh();
                        return; // settled — stop.
                    }
                } catch {
                    // Transient failure (network blip / 5xx) — the action
                    // rethrows these, so swallow here and keep polling until
                    // the deadline.
                }
            }
        };
        void loop();
        return () => {
            cancelled = true;
        };
        // Re-arm whenever the id or the live-ness changes. Static content
        // fields aren't dependencies — only the status gate matters.
        // `tPage`/`router` are stable (next-intl memoizes them) so they
        // don't cause extra re-arms.
    }, [idea.id, idea.status, tPage, router]);

    // Fire a single toast on the in-progress → terminal transition so a
    // user who scrolled away still notices the build landed.
    useEffect(() => {
        const prev = prevStatusRef.current;
        if (prev === idea.status) return;
        prevStatusRef.current = idea.status;
        if (!IN_PROGRESS.has(prev)) return; // only announce leaving a live state
        if (idea.status === 'accepted') {
            toast.success(tDetail('toasts.built'));
        } else if (idea.status === 'failed') {
            toast.error(tDetail('toasts.buildFailed'));
        }
    }, [idea.status, tDetail]);

    // ── Derived build state ───────────────────────────────────────────
    // Shared with `IdeaCard` so a card and the page it opens can't
    // disagree. Every link kind counts: a Work built through
    // `/works/new?proposal=…` is recorded as `linked`, not `built`.
    const {
        isBuilt,
        workCount,
        workId: primaryWorkId,
    } = deriveIdeaBuiltState(idea, links, matchedWorkId);
    const hasFailed = idea.status === 'failed';

    // A pipeline run stamps `built` / `rebuilt`; the Work builder form
    // stamps `linked`. The tracker needs the difference so it doesn't
    // claim an Idea passed through steps it skipped.
    const viaPipeline = links.some((l) => l.kind === 'built' || l.kind === 'rebuilt');
    const timeline = buildTimeline({ status: idea.status, isBuilt, viaPipeline });

    const canBuild = !isLive && !isBuilt && idea.status !== 'failed';
    const canRetry = !isLive && hasFailed;
    // `POST :id/rebuild` refuses any status but ACCEPTED. Built-ness alone
    // is a weaker condition than that — a `pending` Idea counts as built
    // off a `linked` provenance row or a content match — so gating Rebuild
    // on `isBuilt` alone offered a button that always 400s. What exists is
    // still reachable through the View Work link next to it.
    const canRebuild = !isLive && isBuilt && idea.status === 'accepted';

    // ── Actions ───────────────────────────────────────────────────────

    // Build — identical behaviour to the `IdeaCard` CTA on /ideas: open
    // the manual build flow at `/works/new?proposal=…` rather than
    // queueing through the build endpoint.
    //
    // Why not call the endpoint from here: it (a) rejects any status
    // other than pending/failed and (b) needs the git/provider config
    // that only the /works/new form collects — so an in-place queue
    // attempt errors for un-configured accounts. Routing to the form is
    // reliable for every status, and it's already what the card does, so
    // a card and the page it opens no longer build an Idea two different
    // ways. Retry and Rebuild keep their dedicated endpoints.
    const handleBuild = () => {
        router.push(`/works/new?proposal=${idea.id}`);
    };

    const runBuildAction = (
        action: () => Promise<{ idea: WorkProposal }>,
        successKey: 'retryQueued' | 'rebuildQueued',
    ) => {
        startBuild(async () => {
            try {
                const result = await action();
                setIdea(result.idea);
                toast.success(tDetail(`toasts.${successKey}`));
                router.refresh();
            } catch (err) {
                toast.error(err instanceof Error ? err.message : tDetail('toasts.actionError'));
            }
        });
    };

    const openDelete = () => {
        setDeleteError(null);
        setDeleteOpen(true);
    };

    const handleDelete = () => {
        setDeleteError(null);
        startDelete(async () => {
            try {
                const result = await deleteIdeaAction(idea.id);
                if (result.deleted) {
                    toast.success(tDetail('toasts.deleted'));
                    router.push(ROUTES.DASHBOARD_IDEAS);
                    return;
                }
                // Guarded refusal — name the blocker instead of a generic
                // failure so the user knows what to clear first.
                setDeleteError(
                    tDetail(`deleteDialog.blocked.${result.reason}`, { count: result.count }),
                );
            } catch (err) {
                setDeleteError(err instanceof Error ? err.message : tDetail('deleteDialog.error'));
            }
        });
    };

    const statusStyle = STATUS_STYLES[idea.status] ?? STATUS_STYLES.pending;

    return (
        <div className="w-full p-6 max-w-screen-2xl mx-auto space-y-6">
            {/* ── Header ───────────────────────────────────────────────── */}
            <div>
                {/* Top bar — breadcrumb on the left, every action on the
                    right as a single non-wrapping row, with Delete behind a
                    divider so the destructive verb never reads as part of
                    the same group. Same arrangement as Mission detail. */}
                <div className="flex items-center justify-between gap-3">
                    <Link
                        href={ROUTES.DASHBOARD_IDEAS}
                        className="inline-flex min-w-0 items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition-colors"
                    >
                        <ChevronLeft className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{tPage('title')}</span>
                    </Link>

                    <div className="flex min-w-0 items-center gap-2 overflow-x-auto py-0.5">
                        {isBuilt && primaryWorkId && (
                            <Link
                                href={ROUTES.DASHBOARD_WORK(primaryWorkId)}
                                className={cn(btnPrimary, 'shrink-0')}
                            >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                {t('actions.viewWork')}
                            </Link>
                        )}
                        {canBuild && (
                            <button
                                type="button"
                                data-testid="idea-build-button"
                                onClick={handleBuild}
                                className={cn(btnPrimary, 'shrink-0')}
                            >
                                <Hammer className="w-3.5 h-3.5" />
                                {tDetail('actions.build')}
                            </button>
                        )}
                        {canRetry && (
                            <button
                                type="button"
                                data-testid="idea-retry-button"
                                onClick={() =>
                                    runBuildAction(() => retryIdeaAction(idea.id), 'retryQueued')
                                }
                                disabled={pendingBuild}
                                className={cn(btnPrimary, 'shrink-0')}
                            >
                                <RotateCcw className="w-3.5 h-3.5" />
                                {tDetail('actions.retry')}
                            </button>
                        )}
                        {canRebuild && (
                            <button
                                type="button"
                                data-testid="idea-rebuild-button"
                                onClick={() =>
                                    runBuildAction(
                                        () => rebuildIdeaAction(idea.id),
                                        'rebuildQueued',
                                    )
                                }
                                disabled={pendingBuild}
                                className={cn(btn, 'shrink-0')}
                                title={tDetail('actions.rebuildHint')}
                            >
                                <RefreshCw className="w-3.5 h-3.5" />
                                {tDetail('actions.rebuild')}
                            </button>
                        )}
                        {isLive && (
                            <span
                                className={cn(btn, 'shrink-0 cursor-default')}
                                aria-live="polite"
                                data-testid="idea-live-cta"
                            >
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                {tPage(`filters.${idea.status}`)}…
                            </span>
                        )}
                        <Link href={`/ideas/${idea.id}/agents/new`} className={cn(btn, 'shrink-0')}>
                            <Bot className="w-3.5 h-3.5" />
                            {tDetail('actions.newAgent')}
                        </Link>
                        <span
                            aria-hidden
                            className="h-5 w-px shrink-0 bg-border dark:bg-border-dark"
                        />
                        <button
                            type="button"
                            data-testid="idea-delete-button"
                            onClick={openDelete}
                            disabled={pendingDelete}
                            className={cn(btnDanger, 'shrink-0')}
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            {tDetail('actions.delete')}
                        </button>
                    </div>
                </div>

                {/* Icon + title + badges */}
                <div className="mt-3 flex items-start gap-3 min-w-0">
                    <div className="shrink-0 w-10 h-10 rounded-xl bg-concept-ideas/10 border border-concept-ideas/20 flex items-center justify-center">
                        <Lightbulb className="w-5 h-5 text-concept-ideas" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h1 className="text-2xl font-semibold text-text dark:text-text-dark leading-tight">
                            {idea.title}
                        </h1>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <span
                                data-testid="idea-status-badge"
                                className={cn(
                                    'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset capitalize',
                                    statusStyle.badge,
                                )}
                            >
                                <span
                                    aria-hidden="true"
                                    className={cn('h-1.5 w-1.5 rounded-full', statusStyle.dot)}
                                />
                                {tPage(`filters.${idea.status}`)}
                            </span>

                            {/* The answer to "is it built?", stated rather
                                than implied — a green Built pill with the
                                number of Works produced, or a neutral
                                "Not built yet". */}
                            <span
                                data-testid="idea-built-badge"
                                className={cn(
                                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset',
                                    isBuilt
                                        ? 'bg-success/10 text-success ring-success/20'
                                        : 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted dark:text-text-muted-dark ring-border/60 dark:ring-border-dark/60',
                                )}
                            >
                                {isBuilt ? (
                                    <CheckCircle2 className="w-3 h-3" />
                                ) : (
                                    <CircleDashed className="w-3 h-3" />
                                )}
                                {isBuilt
                                    ? tDetail('built.badge', { count: workCount })
                                    : tDetail('built.none')}
                            </span>

                            {isLive && (
                                <span
                                    className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-300 ring-1 ring-inset ring-amber-500/20"
                                    role="status"
                                    aria-live="polite"
                                >
                                    <Radio className="h-3 w-3 animate-pulse" aria-hidden="true" />
                                    {tDetail('live')}
                                </span>
                            )}

                            {idea.missionId && (
                                <Link
                                    href={ROUTES.DASHBOARD_MISSION(idea.missionId)}
                                    className="inline-flex items-center gap-1 rounded-full border border-concept-missions/20 bg-concept-missions/10 px-2 py-0.5 text-[11px] font-medium text-concept-missions hover:bg-concept-missions/15 transition-colors"
                                >
                                    <Target className="w-3 h-3" />
                                    {missionTitle ?? tDetail('fromMission')}
                                </Link>
                            )}

                            <span className="inline-flex items-center gap-1 rounded-full border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 py-0.5 text-[11px] font-medium text-text-muted dark:text-text-muted-dark">
                                <ShowDateTime value={idea.generatedAt} />
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Body ─────────────────────────────────────────────────── */}
            <div className="grid items-start gap-5 @5xl/main:grid-cols-12">
                {/* ── Main column ──────────────────────────────────────── */}
                <div className="min-w-0 space-y-5 @5xl/main:col-span-8">
                    {/* Failure block — first in the column when present, so
                        the reason a build died is the first thing read,
                        directly under the Retry button that fixes it. */}
                    {hasFailed && (idea.failureMessage || idea.failureKind) && (
                        <section
                            role="alert"
                            data-testid="idea-failure"
                            className="rounded-xl border border-danger/30 bg-danger/5 dark:bg-danger/10 p-5"
                        >
                            <div className="flex items-start gap-2.5">
                                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-danger" />
                                <div className="min-w-0 flex-1">
                                    {idea.failureKind && (
                                        <h2 className="text-sm font-semibold text-danger">
                                            {t(`failureKinds.${idea.failureKind}`)}
                                        </h2>
                                    )}
                                    {idea.failureMessage && (
                                        <p className="mt-1 text-xs leading-5 text-text-secondary dark:text-text-secondary-dark">
                                            {idea.failureMessage}
                                        </p>
                                    )}
                                </div>
                            </div>
                        </section>
                    )}

                    {/* ── Description ──────────────────────────────────── */}
                    <section className={sectionCard}>
                        <SectionHeader icon={Lightbulb} title={tDetail('sections.description')} />
                        <p className="whitespace-pre-wrap text-sm leading-6 text-text-secondary dark:text-text-secondary-dark">
                            {idea.description}
                        </p>

                        {idea.suggestedCategories.length > 0 && (
                            <div className="mt-5">
                                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                    {tDetail('meta.categories')}
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                    {idea.suggestedCategories.map((cat) => (
                                        <span
                                            key={cat.slug}
                                            className="inline-flex items-center rounded-full border border-border/60 dark:border-border-dark/60 bg-surface-secondary/60 dark:bg-surface-secondary-dark/60 px-2.5 py-0.5 text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark"
                                        >
                                            {cat.name}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}

                        {idea.reasoning && (
                            <p className="mt-5 border-l-2 border-border/60 dark:border-border-dark/60 pl-3 text-xs italic text-text-secondary dark:text-text-secondary-dark">
                                &quot;{idea.reasoning}&quot;
                            </p>
                        )}
                    </section>

                    {/* ── Linked Works ─────────────────────────────────── */}
                    <section className={sectionCard}>
                        <SectionHeader
                            icon={Boxes}
                            title={tPage('linkedWorks.title')}
                            count={links.length}
                        />
                        {links.length === 0 ? (
                            <p className={emptyText}>{tDetail('works.empty')}</p>
                        ) : (
                            <ul className="space-y-2">
                                {links.map((link) => (
                                    <li key={link.id}>
                                        <Link
                                            href={ROUTES.DASHBOARD_WORK(link.workId)}
                                            className="group flex items-center gap-3 rounded-lg border border-border/60 dark:border-border-dark/60 bg-surface/30 dark:bg-surface-dark/30 px-3 py-2.5 hover:border-border dark:hover:border-border-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
                                        >
                                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-text dark:text-text-dark group-hover:text-primary transition-colors">
                                                {link.workName ?? link.workId.slice(0, 8)}
                                            </span>
                                            <span
                                                className={cn(
                                                    'shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset',
                                                    KIND_BADGE[link.kind],
                                                )}
                                            >
                                                {tPage(`linkedWorks.kind.${link.kind}`)}
                                            </span>
                                            <span className="shrink-0 text-xs text-text-muted dark:text-text-muted-dark">
                                                {new Date(link.createdAt).toLocaleDateString(
                                                    locale,
                                                    {
                                                        year: 'numeric',
                                                        month: 'short',
                                                        day: 'numeric',
                                                    },
                                                )}
                                            </span>
                                            <ArrowRight className="w-3.5 h-3.5 shrink-0 text-text-muted" />
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>

                    {/* ── Attachments ──────────────────────────────────── */}
                    <EntityAttachmentsSection
                        initial={attachments}
                        onAttach={(uploadId) => attachUploadToIdeaAction(idea.id, uploadId)}
                        onDetach={(attachmentId) =>
                            detachIdeaAttachmentAction(idea.id, attachmentId)
                        }
                        testId="idea-attachments"
                    />
                </div>

                {/* ── Context rail ─────────────────────────────────────── */}
                <aside className="min-w-0 space-y-5 @5xl/main:col-span-4">
                    {/* ── Build tracker ────────────────────────────────── */}
                    <section className={sectionCard} data-testid="idea-build-tracker">
                        <SectionHeader icon={Hammer} title={tDetail('sections.build')} />
                        <ol className="space-y-0">
                            {timeline.map((step, i) => {
                                const { stage, state } = step;
                                const isLast = i === timeline.length - 1;
                                // The connector below a step is "travelled"
                                // only when this step is complete — a pending
                                // or failed step must not feed a green line.
                                const connectorDone = state === 'done';
                                return (
                                    <li key={stage} className="flex gap-3">
                                        {/* Rail: dot + connector */}
                                        <div className="flex flex-col items-center">
                                            <span
                                                aria-hidden
                                                className={cn(
                                                    'mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                                                    state === 'failed'
                                                        ? 'border-danger bg-danger/15'
                                                        : state === 'done'
                                                          ? 'border-success bg-success'
                                                          : state === 'current'
                                                            ? 'border-amber-500 bg-amber-500/20'
                                                            : 'border-border dark:border-border-dark bg-surface dark:bg-surface-dark',
                                                )}
                                            >
                                                {state === 'failed' ? (
                                                    <AlertTriangle className="h-2.5 w-2.5 text-danger" />
                                                ) : state === 'done' ? (
                                                    <CheckCircle2 className="h-3 w-3 text-white" />
                                                ) : state === 'current' ? (
                                                    // Only a live build spins. A `pending`
                                                    // Idea is waiting on the USER, not on a
                                                    // builder, so a spinner there would read
                                                    // as work in flight that isn't.
                                                    stage === 'drafted' ? (
                                                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                                                    ) : (
                                                        <Loader2 className="h-2.5 w-2.5 animate-spin text-amber-600 dark:text-amber-400" />
                                                    )
                                                ) : null}
                                            </span>
                                            {!isLast && (
                                                <span
                                                    aria-hidden
                                                    className={cn(
                                                        'w-px flex-1 my-1',
                                                        connectorDone
                                                            ? 'bg-success/40'
                                                            : 'bg-border dark:bg-border-dark',
                                                    )}
                                                />
                                            )}
                                        </div>
                                        {/* Label */}
                                        <div className={cn('min-w-0 flex-1', !isLast && 'pb-4')}>
                                            <p
                                                className={cn(
                                                    'text-sm font-medium',
                                                    state === 'failed'
                                                        ? 'text-danger'
                                                        : state === 'pending'
                                                          ? 'text-text-muted dark:text-text-muted-dark'
                                                          : 'text-text dark:text-text-dark',
                                                )}
                                            >
                                                {state === 'failed'
                                                    ? tDetail('stages.failed')
                                                    : tDetail(`stages.${stage}`)}
                                            </p>
                                            <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                                                {state === 'failed'
                                                    ? tDetail('stageHints.failed')
                                                    : tDetail(`stageHints.${stage}`)}
                                            </p>
                                        </div>
                                    </li>
                                );
                            })}
                        </ol>

                        {isBuilt && primaryWorkId && (
                            <Link
                                href={ROUTES.DASHBOARD_WORK(primaryWorkId)}
                                data-testid="idea-built-work-link"
                                className="mt-4 inline-flex max-w-full items-center gap-0.5 text-xs font-medium text-success hover:text-success/80 transition-colors"
                            >
                                <span className="min-w-0 truncate">{t('actions.viewWork')}</span>
                                <ChevronRight className="w-3 h-3 shrink-0" />
                            </Link>
                        )}
                    </section>

                    {/* ── Agents ───────────────────────────────────────── */}
                    <section className={sectionCard}>
                        <SectionHeader
                            icon={Bot}
                            title={tDetail('sections.agents')}
                            count={agents.length}
                        />
                        {agents.length === 0 ? (
                            <p className={emptyText}>{tDetail('agents.empty')}</p>
                        ) : (
                            <ul className="space-y-2">
                                {agents.map((agent) => (
                                    <li key={agent.id}>
                                        <Link
                                            href={ROUTES.DASHBOARD_AGENT(agent.id)}
                                            className="group flex items-center gap-3 rounded-lg border border-border/60 dark:border-border-dark/60 bg-surface/30 dark:bg-surface-dark/30 px-3 py-2.5 hover:border-border dark:hover:border-border-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
                                        >
                                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-text dark:text-text-dark group-hover:text-primary transition-colors">
                                                {agent.name}
                                            </span>
                                            <span className="shrink-0 rounded-full border border-border dark:border-border-dark px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                                {agent.status}
                                            </span>
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>

                    {/* ── Details ──────────────────────────────────────── */}
                    <section className={sectionCard}>
                        <SectionHeader icon={Info} title={tDetail('sections.details')} />
                        <dl className="space-y-3 text-xs">
                            <div className="flex items-start justify-between gap-3">
                                <dt className="text-text-muted dark:text-text-muted-dark">
                                    {tDetail('meta.source')}
                                </dt>
                                <dd className="min-w-0 truncate font-medium text-text dark:text-text-dark">
                                    {idea.source}
                                </dd>
                            </div>
                            <div className="flex items-start justify-between gap-3">
                                <dt className="text-text-muted dark:text-text-muted-dark">
                                    {tDetail('meta.slug')}
                                </dt>
                                <dd className="min-w-0 truncate font-mono text-text dark:text-text-dark">
                                    {idea.slugSuggestion}
                                </dd>
                            </div>
                            {idea.recommendedPlugins.length > 0 && (
                                <div className="flex items-start justify-between gap-3">
                                    <dt className="shrink-0 text-text-muted dark:text-text-muted-dark">
                                        {t('plugins.label')}
                                    </dt>
                                    <dd className="min-w-0 text-right font-medium text-text dark:text-text-dark">
                                        {idea.recommendedPlugins.map((p) => p.pluginId).join(', ')}
                                    </dd>
                                </div>
                            )}
                            {idea.suggestedFields.length > 0 && (
                                <div className="flex items-start justify-between gap-3">
                                    <dt className="shrink-0 text-text-muted dark:text-text-muted-dark">
                                        {tDetail('meta.fields')}
                                    </dt>
                                    <dd className="min-w-0 text-right font-medium text-text dark:text-text-dark">
                                        {idea.suggestedFields.map((f) => f.name).join(', ')}
                                    </dd>
                                </div>
                            )}
                        </dl>
                    </section>
                </aside>
            </div>

            {/* ── Delete dialog ────────────────────────────────────────── */}
            <Dialog
                open={deleteOpen}
                onOpenChange={(next) => (next ? setDeleteOpen(true) : setDeleteOpen(false))}
            >
                <DialogContent className="max-w-md">
                    <DialogClose onClose={() => setDeleteOpen(false)} />
                    <DialogHeader className="mb-0">
                        <div className="flex items-center gap-3 mb-1">
                            <span className="flex items-center justify-center size-9 rounded-full bg-red-100 dark:bg-red-950/50 shrink-0">
                                <TriangleAlertIcon className="size-4 text-red-600 dark:text-red-400" />
                            </span>
                            <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                                {tDetail('deleteDialog.title')}
                            </DialogTitle>
                        </div>
                        <DialogDescription>
                            {tDetail('deleteDialog.body', { title: idea.title })}
                        </DialogDescription>
                    </DialogHeader>

                    {deleteError && (
                        <p
                            role="alert"
                            data-testid="idea-delete-error"
                            className="mt-4 text-xs text-danger"
                        >
                            {deleteError}
                        </p>
                    )}

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            data-testid="idea-delete-cancel"
                            disabled={pendingDelete}
                            onClick={() => setDeleteOpen(false)}
                        >
                            {tDetail('deleteDialog.cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            data-testid="idea-delete-confirm"
                            loading={pendingDelete}
                            onClick={handleDelete}
                        >
                            {pendingDelete
                                ? tDetail('deleteDialog.deleting')
                                : tDetail('deleteDialog.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
