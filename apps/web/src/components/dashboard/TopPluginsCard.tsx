'use client';

import { cn } from '@/lib/utils/cn';
import { TrendingUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { PerPluginSpend } from '@/lib/api/types-only';

interface TopPluginsCardProps {
    perPlugin: PerPluginSpend[];
    currency: string;
}

function formatCents(cents: number, currency: string): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency.toUpperCase(),
        maximumFractionDigits: 2,
    }).format(cents / 100);
}

function capabilityBadge(capability: PerPluginSpend['capability']): string {
    switch (capability) {
        case 'ai':
            return 'bg-violet-500/15 text-violet-500';
        case 'search':
            return 'bg-blue-500/15 text-blue-500';
        case 'screenshot':
            return 'bg-amber-500/15 text-amber-500';
        case 'extractor':
            return 'bg-emerald-500/15 text-emerald-500';
    }
}

export function TopPluginsCard({ perPlugin, currency }: TopPluginsCardProps) {
    const t = useTranslations('dashboard.budgets');
    const top = perPlugin.slice(0, 5);

    return (
        <div
            className={cn(
                'relative rounded-md p-1 overflow-hidden',
                'border border-card-border dark:border-border-dark',
            )}
        >
            <div
                className={cn(
                    'rounded-sm p-5 overflow-hidden',
                    'bg-card dark:bg-surface-secondary-dark',
                    'border border-card-border dark:border-border-dark',
                )}
            >
                <div className="flex items-center space-x-2">
                    <div className="rounded-md w-8 h-8 flex items-center justify-center bg-surface dark:bg-white/6">
                        <TrendingUp className="w-4.5 h-4.5 text-violet-500" strokeWidth={1.3} />
                    </div>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('topPluginsTitle')}
                    </p>
                </div>

                {top.length === 0 ? (
                    <p className="mt-4 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('topPluginsEmpty')}
                    </p>
                ) : (
                    <ul className="mt-3 space-y-2">
                        {top.map((p) => (
                            <li
                                key={`${p.capability}:${p.pluginId}`}
                                className="flex items-center justify-between text-sm"
                            >
                                <div className="flex items-center space-x-2 min-w-0">
                                    <span
                                        className={cn(
                                            'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] uppercase font-medium tracking-wide',
                                            capabilityBadge(p.capability),
                                        )}
                                    >
                                        {p.capability}
                                    </span>
                                    <span className="truncate text-text dark:text-text-dark">
                                        {p.pluginId}
                                    </span>
                                </div>
                                <span className="text-text-muted dark:text-text-muted-dark whitespace-nowrap">
                                    {formatCents(p.costCents, currency)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
