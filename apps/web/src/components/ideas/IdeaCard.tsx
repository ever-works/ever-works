'use client';

import { useTransition } from 'react';
import { AlertTriangle, Bot, CheckCircle2, ChevronRight, X } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { WorkProposal, WorkProposalStatus } from '@/lib/api/work-proposals';
import { dismissProposalAction } from '@/app/actions/dashboard/work-proposals';

/**
 * Per-status badge palette. Hoisted to module scope so it isn't
 * re-created on every render. Each entry is a soft tinted pill
 * (ring + bg + text) plus a leading status dot — `building` pulses
 * to read as "in progress" at a glance. Labels reuse the existing
 * `dashboard.ideasPage.filters.*` i18n keys so no new strings are
 * needed.
 */
const STATUS_STYLES: Record<WorkProposalStatus, { badge: string; dot: string }> = {
    pending: {
        badge: 'bg-slate-500/10 text-slate-600 dark:text-slate-300 ring-slate-500/20',
        dot: 'bg-slate-400',
    },
    queued: {
        badge: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 ring-indigo-500/20',
        dot: 'bg-indigo-400',
    },
    building: {
        badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-300 ring-amber-500/20',
        dot: 'bg-amber-500 animate-pulse',
    },
    failed: {
        badge: 'bg-danger/10 text-danger ring-danger/20',
        dot: 'bg-danger',
    },
    accepted: {
        badge: 'bg-success/10 text-success ring-success/20',
        dot: 'bg-success',
    },
    dismissed: {
        badge: 'bg-gray-500/10 text-gray-500 dark:text-gray-400 ring-gray-500/20',
        dot: 'bg-gray-400',
    },
};

/**
 * Phase 5 PR M — `IdeaCard` is the canonical name for what used
 * to live in `dashboard/WorkProposalCard.tsx`. Output is byte-
 * identical (Decision A10) — only the file path + exported name
 * changed. The old `WorkProposalCard.tsx` is now a thin re-export
 * shim so external callers (CLI, plugins) keep working.
 *
 * Why the rename: spec §3 + Phase 2 PR E flipped the user-visible
 * label from "Proposals" → "Ideas". The component naming now
 * matches what the user sees on screen, and the new
 * `apps/web/src/components/ideas/` directory becomes the home for
 * everything Idea-related (the dedicated `/ideas` page in PR N,
 * the Done-filter chip in PR P, etc.).
 */
interface IdeaCardProps {
    proposal: WorkProposal;
    onDismissed?: (id: string) => void;
    onQueueBuild?: (id: string) => void;
}

export function IdeaCard({ proposal, onDismissed, onQueueBuild }: IdeaCardProps) {
    const t = useTranslations('dashboard.proposals');
    const tPage = useTranslations('dashboard.ideasPage');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();

    // Phase 5 PR P — Done state CTA. When the Idea has been
    // accepted AND the platform has a Work id to point at (the
    // common case post-Phase 1 PR B build flow), swap the
    // "Build" CTA for "View Work →" linking directly to the
    // /works/<id> detail page. ACCEPTED Ideas without a Work id
    // (legacy pre-PR-B accepts, or in-flight accepts where the
    // back-FK didn't land yet) keep the Build CTA so the user
    // can still kick off a new build cycle.
    const isDone =
        proposal.status === 'accepted' &&
        typeof proposal.acceptedWorkId === 'string' &&
        proposal.acceptedWorkId.length > 0;

    const handleAccept = () => {
        if (isDone && proposal.acceptedWorkId) {
            router.push(ROUTES.DASHBOARD_WORK(proposal.acceptedWorkId));
            return;
        }
        if (onQueueBuild && (proposal.status === 'pending' || proposal.status === 'failed')) {
            onQueueBuild(proposal.id);
            return;
        }
        router.push(`/works/new?proposal=${proposal.id}`);
    };

    const handleDismiss = () => {
        startTransition(async () => {
            try {
                await dismissProposalAction(proposal.id);
                onDismissed?.(proposal.id);
            } catch {
                toast.error('Could not dismiss Idea.');
            }
        });
    };

    const topCategories = proposal.suggestedCategories.slice(0, 4);
    const topPlugins = proposal.recommendedPlugins.slice(0, 3);
    const statusStyle = STATUS_STYLES[proposal.status] ?? STATUS_STYLES.pending;

    return (
        <div
            className={cn(
                'group relative flex min-h-68 flex-col overflow-hidden rounded-lg p-5',
                'bg-card dark:bg-card-primary-dark/70',
                'border border-card-border dark:border-white/10',
                'shadow-sm hover:shadow-lg dark:shadow-black/20',
                'hover:border-primary-500/40 dark:hover:border-white/20',
                'transition-all duration-200',
            )}
        >
            <button
                type="button"
                onClick={handleDismiss}
                disabled={isPending}
                aria-label={t('actions.dismissAria')}
                className="absolute top-3.5 right-3.5 z-10 p-1 rounded-md text-text-muted hover:text-text dark:hover:text-text-dark hover:bg-surface dark:hover:bg-surface-dark transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-40"
            >
                <X className="w-4 h-4" aria-hidden="true" />
            </button>

            {/* Status badge — meaningful now that the home preview surfaces
                Ideas of every status (pending / building / accepted / …). */}
            <div className="mb-3 pr-7">
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
                    {tPage(`filters.${proposal.status}`)}
                </span>
            </div>

            <h3 className="mb-2 pr-1 min-w-0 text-sm font-semibold text-text dark:text-text-dark leading-snug line-clamp-2">
                {proposal.title}
            </h3>

            <p className="text-xs leading-4.5 text-text-secondary dark:text-text-secondary-dark line-clamp-3 min-h-[3lh] mb-3">
                {proposal.description}
            </p>

            {topCategories.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-3">
                    {topCategories.map((cat) => (
                        <span
                            key={cat.slug}
                            className="inline-flex items-center rounded-full border border-border/60 dark:border-white/10 bg-surface-secondary/60 dark:bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-text-secondary dark:text-gray-300"
                        >
                            {cat.name}
                        </span>
                    ))}
                </div>
            )}

            {topPlugins.length > 0 && (
                <div className="mb-3 text-xs text-text-muted dark:text-text-muted-dark">
                    {t('plugins.label')}:{' '}
                    <span className="text-text dark:text-text-dark font-medium">
                        {topPlugins.map((p) => p.pluginId).join(', ')}
                    </span>
                </div>
            )}

            {proposal.reasoning && (
                <p className="text-xs italic text-text-secondary dark:text-text-secondary-dark line-clamp-2 mb-4 border-l-2 border-border/60 dark:border-white/10 pl-2.5">
                    &quot;{proposal.reasoning}&quot;
                </p>
            )}

            {/* Phase 6 PR GG / spec §3.9 — inline failure error block.
                Renders only when the Idea is in the FAILED terminal
                status. `failureKind` is the platform-classified
                category from PR FF (translated via the
                `dashboard.proposals.failureKinds.*` namespace);
                `failureMessage` is the raw human-readable error.
                Renders both because the kind summarizes the class of
                problem while the message often holds the specific
                detail (4xx body, plugin trace) the user needs to
                act on. Clamped at 3 lines so a stack-trace-y message
                doesn't dominate the card. */}
            {proposal.status === 'failed' && (proposal.failureMessage || proposal.failureKind) && (
                <div
                    role="alert"
                    className="mb-4 rounded-md border border-danger/30 bg-danger/5 dark:bg-danger/10 p-2 text-xs text-danger"
                >
                    <div className="flex items-start gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                            {proposal.failureKind && (
                                <div className="font-medium">
                                    {t(`failureKinds.${proposal.failureKind}`)}
                                </div>
                            )}
                            {proposal.failureMessage && (
                                <p className="line-clamp-3 mt-0.5 text-text-secondary dark:text-text-secondary-dark">
                                    {proposal.failureMessage}
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            )}

            <div className="mt-auto flex items-center gap-2">
                <button
                    type="button"
                    onClick={handleAccept}
                    className={cn(
                        'flex-1 cursor-pointer inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-white transition-colors active:scale-[0.98]',
                        // Phase 5 PR P — Done state uses the success
                        // color and a checkmark icon. Visually distinct
                        // from the primary-blue Build CTA so a finished
                        // Idea reads as "completed" at a glance.
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
                </button>
                {/* FU-3 — quick on-ramp to an Idea-scoped Agent. Lives
                    next to the primary CTA so it's discoverable from
                    every Ideas list view without the user having to
                    drill into a separate detail page. */}
                <Link
                    href={`/ideas/${proposal.id}/agents/new`}
                    className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-md border border-border dark:border-border-dark px-2.5 py-2 text-xs font-medium text-text-secondary dark:text-text-secondary-dark hover:border-primary/40 hover:text-primary dark:hover:text-primary transition-colors"
                    title="Create a new Idea-scoped Agent"
                >
                    <Bot className="w-3.5 h-3.5" aria-hidden="true" />
                </Link>
            </div>
        </div>
    );
}
