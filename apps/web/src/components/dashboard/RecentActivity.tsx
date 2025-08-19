'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils/cn';

interface Activity {
    id: string;
    type: 'directory_created' | 'item_added' | 'website_deployed' | 'api_key_created';
    title: string;
    description: string;
    timestamp: Date;
}

export function RecentActivity() {
    const [activities, setActivities] = useState<Activity[]>([]);

    useEffect(() => {
        // TODO: Fetch actual activities from API
        setActivities([
            {
                id: '1',
                type: 'directory_created',
                title: 'New Directory Created',
                description: 'Created "Awesome AI Tools" directory',
                timestamp: new Date(Date.now() - 1000 * 60 * 30),
            },
            {
                id: '2',
                type: 'item_added',
                title: 'Item Added',
                description: 'Added 5 new items to "Tech Startups"',
                timestamp: new Date(Date.now() - 1000 * 60 * 60 * 2),
            },
            {
                id: '3',
                type: 'website_deployed',
                title: 'Website Deployed',
                description: 'Deployed "awesome-tools.vercel.app"',
                timestamp: new Date(Date.now() - 1000 * 60 * 60 * 5),
            },
        ]);
    }, []);

    const getActivityIcon = (type: Activity['type']) => {
        switch (type) {
            case 'directory_created':
                return <FolderPlusIcon className="w-5 h-5 text-primary" />;
            case 'item_added':
                return <PlusCircleIcon className="w-5 h-5 text-success" />;
            case 'website_deployed':
                return <GlobeIcon className="w-5 h-5 text-info" />;
            case 'api_key_created':
                return <KeyIcon className="w-5 h-5 text-warning" />;
        }
    };

    const formatTime = (date: Date) => {
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
        if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
        if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
        return 'Just now';
    };

    return (
        <div
            className={cn(
                'rounded-lg',
                'bg-card dark:bg-card-dark',
                'border border-card-border dark:border-card-border-dark',
            )}
        >
            <div className={cn('p-6', 'border-b border-border dark:border-border-dark')}>
                <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                    Recent Activity
                </h3>
            </div>
            <div className="p-6">
                {activities.length > 0 ? (
                    <div className="space-y-4">
                        {activities.map((activity) => (
                            <div key={activity.id} className="flex gap-4">
                                <div className="flex-shrink-0 mt-1">
                                    {getActivityIcon(activity.type)}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-text dark:text-text-dark">
                                        {activity.title}
                                    </p>
                                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                        {activity.description}
                                    </p>
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                                        {formatTime(activity.timestamp)}
                                    </p>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p
                        className={cn(
                            'text-sm text-center py-8',
                            'text-text-muted dark:text-text-muted-dark',
                        )}
                    >
                        No recent activity
                    </p>
                )}
            </div>
        </div>
    );
}

function FolderPlusIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
            />
        </svg>
    );
}

function PlusCircleIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z"
            />
        </svg>
    );
}

function GlobeIcon({ className }: { className?: string }) {
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

function KeyIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
            />
        </svg>
    );
}
