'use client';

import { useTransition } from 'react';
import { AlertTriangle, Bot, CheckCircle2, ChevronRight, X } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { WorkProposal } from '@/lib/api/work-proposals';
import { dismissProposalAction } from '@/app/actions/dashboard/work-proposals';
import { STATUS_STYLES } from './idea-status';

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
}

export function IdeaCard({ proposal, onDismissed }: IdeaCardProps) {
    const t = useTranslations('dashboard.proposals');
    const tPage = useTranslations('dashboard.ideasPage');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();

    // "View Work" CTA. Whenever the Idea already points at a generated
    // Work — regardless of its status — the "Build" CTA is swapped for
    // "View Work →" linking directly to the /works/<id> detail page. This
    // covers a Done (accepted) Idea, but also a queued/building/failed
    // Idea whose earlier build already produced a Work: there's no point
    // re-building something that already exists, so we send the user
    // straight to it. Ideas without a Work id keep the Build CTA.
    const hasWork =
        typeof proposal.acceptedWorkId === 'string' && proposal.acceptedWorkId.length > 0;

    // Status marks shown on the CTA label. Derived purely from the
    // Idea's persisted status (server truth) so the "Queued"/"Building"
    // text is correct on first paint and survives reloads. These no
    // longer disable the button — every status stays clickable.
    const isBuilding = !hasWork && proposal.status === 'building';
    const isQueued = !hasWork && proposal.status === 'queued';

    const handleAccept = () => {
        // If a Work already exists for this Idea, jump straight to it.
        // Every other status opens the manual build flow at /works/new
        // (pre-filled from this Idea).
        //
        // We deliberately do NOT call the build endpoint directly from
        // the card. That endpoint (a) rejects any status other than
        // pending/failed and (b) needs git/provider config that only the
        // /works/new form collects — so an in-place queue attempt errors
        // for un-configured accounts and for queued/building Ideas.
        // Routing to /works/new is reliable for every status.
        if (hasWork && proposal.acceptedWorkId) {
            router.push(ROUTES.DASHBOARD_WORK(proposal.acceptedWorkId));
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
                'group relative flex min-h-62 flex-col overflow-hidden rounded-lg p-5',
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

            {/* Full-card click target → Idea detail page. Rendered as an
                absolutely-positioned overlay (the "card link" pattern) so
                the whole card is a single accessible link. It sits at
                `z-0`; the dismiss button and the footer actions below are
                lifted to `z-10` so they stay independently clickable and
                aren't swallowed by this overlay. */}
            <Link
                href={ROUTES.DASHBOARD_IDEA(proposal.id)}
                aria-label={proposal.title}
                className="absolute inset-0 z-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            />

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
                <p className="text-[10px] italic text-text-secondary dark:text-text-secondary-dark line-clamp-2 mb-2 border-l-2 border-border/60 dark:border-white/10 pl-2.5">
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

            {/* `relative z-10` lifts the action row above the full-card
                link overlay so these controls handle their own clicks. */}
            <div className="relative z-10 mt-auto flex items-center gap-2">
                <button
                    type="button"
                    onClick={handleAccept}
                    className={cn(
                        'flex-1 inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-white transition-colors active:scale-[0.98] cursor-pointer',
                        // The "View Work" state uses the success color and
                        // a checkmark icon. Visually distinct from the
                        // primary Build CTA so an Idea that already has a
                        // Work reads as "completed" at a glance. Every
                        // other status (pending/queued/building/failed)
                        // shares the Build styling and stays clickable —
                        // clicking opens the /works/new build flow.
                        hasWork
                            ? 'bg-success hover:bg-success/90'
                            : 'bg-black hover:bg-black/80 dark:bg-white/6 dark:hover:bg-white/10',
                    )}
                >
                    {hasWork ? (
                        <>
                            <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                            {t('actions.viewWork')}
                        </>
                    ) : isBuilding ? (
                        <>
                            {tPage('filters.building')}
                            <ChevronRight className="w-4 h-4" aria-hidden="true" />
                        </>
                    ) : isQueued ? (
                        <>
                            {tPage('filters.queued')}
                            <ChevronRight className="w-4 h-4" aria-hidden="true" />
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
