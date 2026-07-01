'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
    AlertTriangle,
    ArrowLeft,
    Bot,
    CheckCircle2,
    ChevronRight,
    Lightbulb,
    Radio,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { toast } from 'sonner';
import type { WorkProposal, WorkProposalStatus } from '@/lib/api/work-proposals';
import { getProposalAction } from '@/app/actions/dashboard/work-proposals';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { STATUS_STYLES } from './idea-status';

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

interface IdeaDetailClientProps {
    idea: WorkProposal;
}

/**
 * `/ideas/[id]` detail body — client island so a `queued`/`building`
 * Idea updates in place: the status badge animates, a small "Live"
 * indicator shows we're watching, and the primary CTA auto-swaps to
 * "View Work" the moment the background build finishes. Terminal
 * Ideas render exactly once with no polling.
 */
export function IdeaDetailClient({ idea: initialIdea }: IdeaDetailClientProps) {
    const t = useTranslations('dashboard.proposals');
    const tPage = useTranslations('dashboard.ideasPage');

    const [idea, setIdea] = useState<WorkProposal>(initialIdea);
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
                    if (cancelled || !next) return;
                    setIdea(next);
                    if (!IN_PROGRESS.has(next.status)) return; // settled — stop.
                } catch {
                    // Network blip — keep polling until the deadline.
                }
            }
        };
        void loop();
        return () => {
            cancelled = true;
        };
        // Re-arm whenever the id or the live-ness changes. Static content
        // fields aren't dependencies — only the status gate matters.
    }, [idea.id, idea.status]);

    // Fire a single toast on the in-progress → terminal transition so a
    // user who scrolled away still notices the build landed.
    useEffect(() => {
        const prev = prevStatusRef.current;
        if (prev === idea.status) return;
        prevStatusRef.current = idea.status;
        if (!IN_PROGRESS.has(prev)) return; // only announce leaving a live state
        if (idea.status === 'accepted') {
            toast.success(tPage('filters.accepted'));
        } else if (idea.status === 'failed') {
            toast.error(tPage('filters.failed'));
        }
    }, [idea.status, tPage]);

    const isDone =
        idea.status === 'accepted' &&
        typeof idea.acceptedWorkId === 'string' &&
        idea.acceptedWorkId.length > 0;

    const statusStyle = STATUS_STYLES[idea.status] ?? STATUS_STYLES.pending;
    const buildHref = isDone
        ? ROUTES.DASHBOARD_WORK(idea.acceptedWorkId as string)
        : `/works/new?proposal=${idea.id}`;

    return (
        <div className="mx-auto w-full max-w-3xl p-6">
            {/* Back to the Ideas catalog. Reuses the existing page title
                key so no new i18n string is needed. */}
            <Link
                href={ROUTES.DASHBOARD_IDEAS}
                className="mb-6 inline-flex items-center gap-2 text-sm text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark transition-colors"
            >
                <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                {tPage('title')}
            </Link>

            <article
                className={cn(
                    'relative overflow-hidden rounded-lg p-6',
                    'bg-card dark:bg-card-primary-dark/70',
                    'border border-card-border dark:border-white/10',
                    'shadow-sm dark:shadow-black/20',
                )}
            >
                {/* Live-build accent — a slim animated bar across the top
                    of the card while a background build is running. Purely
                    decorative (aria-hidden); the badge + "Live" pill carry
                    the real status for assistive tech. */}
                {isLive && (
                    <div
                        aria-hidden="true"
                        className="absolute inset-x-0 top-0 h-0.5 overflow-hidden"
                    >
                        <div className="h-full w-1/3 animate-[idea-live-sweep_1.4s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-amber-500 to-transparent" />
                    </div>
                )}

                {/* Status badge + Live indicator */}
                <div className="mb-4 flex items-center gap-2">
                    <span
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
                    {isLive && (
                        <span
                            className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-300 ring-1 ring-inset ring-amber-500/20"
                            role="status"
                            aria-live="polite"
                        >
                            <Radio className="h-3 w-3 animate-pulse" aria-hidden="true" />
                            Live
                        </span>
                    )}
                </div>

                <div className="mb-4 flex items-start gap-3">
                    <div className="shrink-0 w-10 h-10 rounded-lg bg-surface-secondary dark:bg-white/6 border border-border/50 dark:border-white/10 flex items-center justify-center">
                        <Lightbulb className="w-5 h-5 text-text-secondary dark:text-text-secondary-dark" />
                    </div>
                    <h1 className="min-w-0 text-2xl font-bold text-text dark:text-text-dark leading-tight">
                        {idea.title}
                    </h1>
                </div>

                <p className="whitespace-pre-wrap text-sm leading-6 text-text-secondary dark:text-text-secondary-dark">
                    {idea.description}
                </p>

                {idea.suggestedCategories.length > 0 && (
                    <div className="mt-5 flex flex-wrap gap-1.5">
                        {idea.suggestedCategories.map((cat) => (
                            <span
                                key={cat.slug}
                                className="inline-flex items-center rounded-full border border-border/60 dark:border-white/10 bg-surface-secondary/60 dark:bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-text-secondary dark:text-gray-300"
                            >
                                {cat.name}
                            </span>
                        ))}
                    </div>
                )}

                {idea.recommendedPlugins.length > 0 && (
                    <div className="mt-5 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('plugins.label')}:{' '}
                        <span className="text-text dark:text-text-dark font-medium">
                            {idea.recommendedPlugins.map((p) => p.pluginId).join(', ')}
                        </span>
                    </div>
                )}

                {idea.reasoning && (
                    <p className="mt-5 text-xs italic text-text-secondary dark:text-text-secondary-dark border-l-2 border-border/60 dark:border-white/10 pl-3">
                        &quot;{idea.reasoning}&quot;
                    </p>
                )}

                {/* Failure block — mirrors the card, un-clamped so the full
                    message is readable on the detail surface. */}
                {idea.status === 'failed' && (idea.failureMessage || idea.failureKind) && (
                    <div
                        role="alert"
                        className="mt-5 rounded-md border border-danger/30 bg-danger/5 dark:bg-danger/10 p-3 text-xs text-danger"
                    >
                        <div className="flex items-start gap-1.5">
                            <AlertTriangle
                                className="w-3.5 h-3.5 mt-0.5 shrink-0"
                                aria-hidden="true"
                            />
                            <div className="min-w-0 flex-1">
                                {idea.failureKind && (
                                    <div className="font-medium">
                                        {t(`failureKinds.${idea.failureKind}`)}
                                    </div>
                                )}
                                {idea.failureMessage && (
                                    <p className="mt-0.5 text-text-secondary dark:text-text-secondary-dark">
                                        {idea.failureMessage}
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* Primary actions — mirror the IdeaCard footer. Build (or
                    View Work when Done) + a quick on-ramp to an Idea-scoped
                    Agent. While a build is live the primary CTA is disabled
                    (there's nothing to do but wait) and reads as "building". */}
                <div className="mt-6 flex items-center gap-2">
                    {isLive ? (
                        <span
                            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium bg-surface-secondary dark:bg-white/6 text-text-secondary dark:text-text-secondary-dark cursor-default"
                            aria-live="polite"
                        >
                            <Radio className="w-4 h-4 animate-pulse" aria-hidden="true" />
                            {tPage(`filters.${idea.status}`)}…
                        </span>
                    ) : (
                        <Link
                            href={buildHref}
                            className={cn(
                                'flex-1 inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-white transition-colors active:scale-[0.98]',
                                isDone
                                    ? 'bg-success hover:bg-success/90'
                                    : 'bg-black hover:bg-black/80 dark:bg-white/6 dark:hover:bg-white/10',
                            )}
                        >
                            {isDone ? (
                                <>
                                    <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                                    {t('actions.viewWork')}
                                </>
                            ) : (
                                <>
                                    {t('actions.accept')}
                                    <ChevronRight className="w-4 h-4" aria-hidden="true" />
                                </>
                            )}
                        </Link>
                    )}
                    <Link
                        href={`/ideas/${idea.id}/agents/new`}
                        className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-md border border-border dark:border-border-dark px-2.5 py-2 text-xs font-medium text-text-secondary dark:text-text-secondary-dark hover:border-primary/40 hover:text-primary dark:hover:text-primary transition-colors"
                        title="Create a new Idea-scoped Agent"
                    >
                        <Bot className="w-3.5 h-3.5" aria-hidden="true" />
                    </Link>
                </div>
            </article>
        </div>
    );
}
