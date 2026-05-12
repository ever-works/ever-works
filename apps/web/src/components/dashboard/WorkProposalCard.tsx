'use client';

import { useTransition } from 'react';
import { Sparkles, X, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import type { WorkProposal } from '@/lib/api/work-proposals';
import { dismissProposalAction } from '@/app/actions/dashboard/work-proposals';

interface WorkProposalCardProps {
    proposal: WorkProposal;
    onDismissed?: (id: string) => void;
}

export function WorkProposalCard({ proposal, onDismissed }: WorkProposalCardProps) {
    const t = useTranslations('dashboard.proposals');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();

    const handleAccept = () => {
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
        <div className="group relative rounded-md p-5 bg-card dark:bg-surface-secondary-dark border border-card-border hover:border-primary/40 transition-colors flex flex-col gap-3">
            <button
                type="button"
                onClick={handleDismiss}
                disabled={isPending}
                aria-label={t('actions.dismissAria')}
                className="absolute top-3 right-3 p-1 rounded text-text-secondary hover:text-text dark:hover:text-text-dark hover:bg-surface dark:hover:bg-surface-dark transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
            >
                <X className="w-4 h-4" />
            </button>

            <div className="flex items-start gap-2">
                <Sparkles className="w-4 h-4 mt-1 text-primary flex-shrink-0" />
                <h3 className="text-base font-semibold text-text dark:text-text-dark leading-tight pr-6">
                    {proposal.title}
                </h3>
            </div>

            <p className="text-sm text-text-secondary dark:text-text-secondary-dark line-clamp-2">
                {proposal.description}
            </p>

            {topCategories.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {topCategories.map((cat) => (
                        <span
                            key={cat.slug}
                            className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-surface dark:bg-surface-dark text-text-secondary dark:text-text-secondary-dark"
                        >
                            {cat.name}
                        </span>
                    ))}
                </div>
            )}

            {topPlugins.length > 0 && (
                <div className="text-xs text-text-secondary dark:text-text-secondary-dark">
                    {t('plugins.label')}:{' '}
                    <span className="text-text dark:text-text-dark font-medium">
                        {topPlugins.map((p) => p.pluginId).join(', ')}
                    </span>
                </div>
            )}

            {proposal.reasoning && (
                <p className="text-xs italic text-text-secondary dark:text-text-secondary-dark line-clamp-2">
                    “{proposal.reasoning}”
                </p>
            )}

            <button
                type="button"
                onClick={handleAccept}
                className="mt-auto inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded text-sm font-medium bg-primary text-white hover:bg-primary-hover transition-colors"
            >
                {t('actions.accept')}
                <ChevronRight className="w-4 h-4" />
            </button>
        </div>
    );
}
