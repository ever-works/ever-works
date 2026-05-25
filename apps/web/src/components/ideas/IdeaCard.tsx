'use client';

import { useTransition } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, Sparkles, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { WorkProposal } from '@/lib/api/work-proposals';
import { dismissProposalAction } from '@/app/actions/dashboard/work-proposals';

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
        router.push(`/works/new?proposal=${proposal.id}`);
    };

    const handleDismiss = () => {
        startTransition(async () => {
            try {
                await dismissProposalAction(proposal.id);
                onDismissed?.(proposal.id);
            } catch {
                // Caller refresh on next list; silent failure is fine here.
            }
        });
    };

    const topCategories = proposal.suggestedCategories.slice(0, 4);
    const topPlugins = proposal.recommendedPlugins.slice(0, 3);

    return (
        <div
            className={cn(
                'group relative flex min-h-[17rem] flex-col overflow-hidden rounded-lg p-4 shadow-xs',
                'bg-card dark:bg-card-primary-dark/70',
                'border border-card-border dark:border-white/9',
                'hover:border-primary-500/50 dark:hover:border-white/20',
                'transition-colors',
            )}
        >
            <button
                type="button"
                onClick={handleDismiss}
                disabled={isPending}
                aria-label={t('actions.dismissAria')}
                className="absolute top-3 right-3 z-10 p-1 rounded-md text-text-muted hover:text-text dark:hover:text-text-dark hover:bg-surface dark:hover:bg-surface-dark transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-40"
            >
                <X className="w-4 h-4" />
            </button>

            <div className="flex items-center gap-3 mb-3 pr-6 min-w-0">
                <div className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-gray-100 dark:bg-white/5">
                    <Sparkles
                        strokeWidth={1.4}
                        className="w-4 h-4 text-primary dark:text-gray-300"
                    />
                </div>
                <div className="min-h-[2lh] flex items-center min-w-0">
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark leading-snug line-clamp-2">
                        {proposal.title}
                    </h3>
                </div>
            </div>

            <p className="text-xs leading-4.5 text-text-secondary dark:text-text-secondary-dark line-clamp-3 min-h-[3lh] mb-3">
                {proposal.description}
            </p>

            {topCategories.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-3">
                    {topCategories.map((cat) => (
                        <span
                            key={cat.slug}
                            className="inline-flex items-center rounded-full bg-primary-400/10 dark:bg-white/10 px-2 py-0.5 text-[11px] text-gray-600 dark:text-gray-200"
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
                <p className="text-xs italic text-text-secondary dark:text-text-secondary-dark line-clamp-2 mb-4">
                    "{proposal.reasoning}"
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
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
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

            <button
                type="button"
                onClick={handleAccept}
                className={cn(
                    'mt-auto inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-white transition-colors active:scale-[0.98]',
                    // Phase 5 PR P — Done state uses the success
                    // color and a checkmark icon. Visually distinct
                    // from the primary-blue Build CTA so a finished
                    // Idea reads as "completed" at a glance.
                    isDone ? 'bg-success hover:bg-success/90' : 'bg-primary hover:bg-primary-hover',
                )}
            >
                {isDone ? (
                    <>
                        <CheckCircle2 className="w-4 h-4" />
                        {t('actions.viewWork')}
                    </>
                ) : (
                    <>
                        {t('actions.accept')}
                        <ChevronRight className="w-4 h-4" />
                    </>
                )}
            </button>
        </div>
    );
}
