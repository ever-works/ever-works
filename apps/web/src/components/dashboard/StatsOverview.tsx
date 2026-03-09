'use client';

import Image from 'next/image';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';

interface StatsOverviewProps {
    totalDirectories?: number;
    totalItems?: number;
    activeWebsites?: number;
}

export function StatsOverview({
    totalDirectories = 0,
    totalItems = 0,
    activeWebsites = 0,
}: StatsOverviewProps) {
    const t = useTranslations('dashboard.stats');

    const statCards: Array<{
        title: string;
        value: string | number;
        icon: React.ComponentType<{ className?: string }>;
        change: string;
        changeType: 'positive' | 'negative' | 'neutral';
        iconColor?: string;
    }> = [
        {
            title: t('totalDirectories'),
            value: totalDirectories,
            icon: FolderIcon,
            iconColor: 'text-blue-500',
            change: '+12%',
            changeType: 'positive',
        },
        {
            title: t('totalItems'),
            value: totalItems,
            icon: ItemsIcon,
            iconColor: 'text-violet-500',
            change: '+23%',
            changeType: 'positive',
        },
        {
            title: t('activeWebsites'),
            value: activeWebsites,
            icon: WebsiteIcon,
            iconColor: 'text-emerald-500',
            change: '0%',
            changeType: 'neutral',
        },
    ];

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {statCards.map((stat) => (
                <div
                    key={stat.title}
                    className={cn(
                        'group relative rounded-xl p-5 transition-shadow duration-200 overflow-hidden',
                        'bg-card dark:bg-surface-secondary-dark/30',
                        'border border-card-border dark:border-border-dark',
                    )}
                >
                    {/* Decorative short top border accent with fading edges */}
                    <div className="card-top-accent pointer-events-none absolute left-1/2 -translate-x-1/2 top-0 w-1/2 h-px z-20 opacity-70 rounded-full" />

                    {/* Decorative blurred circles background */}
                    <div className="pointer-events-none absolute inset-0 z-0 opacity-50">
                        <div className="absolute w-40 h-40 bg-brand-purple/20 opacity-50 rounded-full blur-3xl left-2 top-0"></div>
                        <div className="absolute w-32 h-32 bg-blue-200/20 opacity-50 rounded-full blur-3xl right-1 top-20"></div>
                        <div className="absolute w-28 h-28 bg-brand-purple/20 opacity-50 rounded-full blur-2xl left-1/2 -translate-x-1/2 bottom-4"></div>
                    </div>

                    {/* Hover image at top, reversed horizontally, only visible on hover */}
                    <div className="pointer-events-none absolute left-0 right-0 top-0 z-20">
                        <Image
                            src="/bg-cards.png"
                            alt="Decorative pattern"
                            className="w-full filter brightness-0 dark:brightness-200 -rotate-180"
                            width={200}
                            height={100}
                            unoptimized
                        />
                    </div>

                    <div>
                        <div>
                            <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                {stat.title}
                            </p>
                            <p className="text-2xl font-bold text-text dark:text-text-dark mt-2">
                                {stat.value}
                            </p>
                        </div>
                    </div>

                    <div className="absolute top-3 right-3">
                        <div className={cn('p-3 rounded-lg', 'bg-surface dark:bg-surface-dark/50')}>
                            <stat.icon
                                className={cn('w-6 h-6', stat.iconColor ?? 'text-primary')}
                            />
                        </div>
                    </div>
                    <div className="mt-4  items-center hidden">
                        <span
                            className={cn(
                                'text-sm font-medium',
                                stat.changeType === 'positive' && 'text-success',
                                stat.changeType === 'negative' && 'text-danger',
                                stat.changeType === 'neutral' &&
                                    'text-text-muted dark:text-text-muted-dark',
                            )}
                        >
                            {stat.change}
                        </span>
                        <span className="text-sm text-text-muted dark:text-text-muted-dark ml-2">
                            {t('fromLastMonth')}
                        </span>
                    </div>
                </div>
            ))}
        </div>
    );
}

function FolderIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
            />
        </svg>
    );
}

function ItemsIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
            />
        </svg>
    );
}

function WebsiteIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
            />
        </svg>
    );
}
