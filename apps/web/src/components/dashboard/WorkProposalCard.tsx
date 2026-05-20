'use client';

import { useTransition } from 'react';
import { Sparkles, X, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
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

            <button
                type="button"
                onClick={handleAccept}
                className="mt-auto inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-hover transition-colors active:scale-[0.98]"
            >
                {t('actions.accept')}
                <ChevronRight className="w-4 h-4" />
            </button>
        </div>
    );
}
