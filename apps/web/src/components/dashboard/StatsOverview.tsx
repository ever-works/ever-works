'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils/cn';

interface Stats {
    totalDirectories: number;
    totalItems: number;
    apiCalls: number;
    activeWebsites: number;
}

export function StatsOverview() {
    const [stats, setStats] = useState<Stats>({
        totalDirectories: 0,
        totalItems: 0,
        apiCalls: 0,
        activeWebsites: 0,
    });

    useEffect(() => {
        // TODO: Fetch actual stats from API
        setStats({
            totalDirectories: 3,
            totalItems: 156,
            apiCalls: 1247,
            activeWebsites: 2,
        });
    }, []);

    const statCards: Array<{
        title: string;
        value: string | number;
        icon: React.ComponentType<{ className?: string }>;
        change: string;
        changeType: 'positive' | 'negative' | 'neutral';
    }> = [
        {
            title: 'Total Directories',
            value: stats.totalDirectories,
            icon: FolderIcon,
            change: '+12%',
            changeType: 'positive',
        },
        {
            title: 'Total Items',
            value: stats.totalItems,
            icon: ItemsIcon,
            change: '+23%',
            changeType: 'positive',
        },
        {
            title: 'Active Websites',
            value: stats.activeWebsites,
            icon: WebsiteIcon,
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
                        'rounded-lg p-6',
                        'bg-card dark:bg-card-dark',
                        'border border-card-border dark:border-card-border-dark',
                    )}
                >
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                {stat.title}
                            </p>
                            <p className="text-2xl font-bold text-text dark:text-text-dark mt-2">
                                {stat.value}
                            </p>
                        </div>
                        <div className={cn('p-3 rounded-lg', 'bg-surface dark:bg-surface-dark')}>
                            <stat.icon className="w-6 h-6 text-primary" />
                        </div>
                    </div>
                    <div className="mt-4 flex items-center">
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
                            from last month
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
