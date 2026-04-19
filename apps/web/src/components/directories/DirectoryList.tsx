'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Directory } from '@/lib/api/directory';
import { cn } from '@/lib/utils/cn';
import { getDirectories } from '@/app/actions/dashboard/directories';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { DirectoryCard } from './DirectoryCard';
import { useTranslations } from 'next-intl';

interface DirectoryListProps {
    initialDirectories?: Directory[];
    showLimit?: number;
    showHeader?: boolean;
    onUpdate?: (directories: Directory[]) => void;
}

export function DirectoryList({
    initialDirectories = [],
    showLimit,
    showHeader = false,
    onUpdate,
}: DirectoryListProps) {
    const [directories, setDirectories] = useState<Directory[]>(initialDirectories);
    const [loading, setLoading] = useState(false);
    const t = useTranslations('dashboard.directoryList');

    const fetchDirectories = useCallback(async () => {
        setLoading(true);
        try {
            const response = await getDirectories({ limit: showLimit || 10 });
            if (response.success) {
                setDirectories(response.directories);
                onUpdate?.(response.directories);
            }
        } catch (error) {
            console.error('Failed to fetch directories:', error);
        } finally {
            setLoading(false);
        }
    }, [onUpdate, showLimit]);

    useEffect(() => {
        // If no initial directories provided, fetch them
        if (initialDirectories.length === 0) {
            void fetchDirectories();
        }
    }, [fetchDirectories, initialDirectories.length]);

    if (loading && directories.length === 0) {
        return <DirectoryListSkeleton />;
    }

    const displayDirectories = showLimit ? directories.slice(0, showLimit) : directories;

    return (
        <div>
            {showHeader && (
                <div className="flex justify-between items-center mb-6">
                    <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h2>

                    <Link
                        href={ROUTES.DASHBOARD_DIRECTORIES_NEW}
                        className={cn(
                            'px-4 py-2 rounded-lg font-medium transition-colors',
                            'bg-primary-500 hover:bg-primary-700 text-white',
                        )}
                    >
                        {t('createButton')}
                    </Link>
                </div>
            )}

            <div
                className={cn(
                    'grid gap-6',
                    // showLimit
                    //     ? 'grid-cols-1 md:grid-cols-2'
                    //     : 'grid-cols-1 lg:grid-cols-2 xl:grid-cols-3',
                    'grid-cols-1 @2xl/main:grid-cols-2 @5xl/main:grid-cols-3',
                )}
            >
                {displayDirectories.map((directory) => (
                    <DirectoryCard key={directory.id} directory={directory} />
                ))}
            </div>
        </div>
    );
}

function DirectoryListSkeleton() {
    return (
        <div className="grid grid-cols-1 @2xl/main:grid-cols-2 @5xl/main:grid-cols-3 gap-6">
            {[1, 2, 3, 4, 5, 6].map((i) => (
                <div
                    key={i}
                    className="bg-card dark:bg-card-primary-dark/30 border border-card-border dark:border-border-secondary-dark rounded-lg p-6"
                >
                    <div className="flex items-start justify-between mb-3">
                        <div className="flex-1">
                            <div className="h-6 w-3/4 bg-surface-secondary dark:bg-surface-secondary-dark rounded animate-pulse mb-2"></div>
                            <div className="h-4 w-1/2 bg-surface-secondary dark:bg-surface-secondary-dark rounded animate-pulse"></div>
                        </div>
                        <div className="h-6 w-16 bg-surface-secondary dark:bg-surface-secondary-dark rounded-full animate-pulse"></div>
                    </div>
                    <div className="h-4 w-full bg-surface-secondary dark:bg-surface-secondary-dark rounded animate-pulse mb-2"></div>
                    <div className="h-4 w-5/6 bg-surface-secondary dark:bg-surface-secondary-dark rounded animate-pulse mb-4"></div>
                    <div className="flex gap-4 mb-4">
                        <div className="h-4 w-20 bg-surface-secondary dark:bg-surface-secondary-dark rounded animate-pulse"></div>
                        <div className="h-4 w-20 bg-surface-secondary dark:bg-surface-secondary-dark rounded animate-pulse"></div>
                    </div>
                    <div className="pt-4 border-t border-border dark:border-border-dark">
                        <div className="h-3 w-32 bg-surface-secondary dark:bg-surface-secondary-dark rounded animate-pulse"></div>
                    </div>
                </div>
            ))}
        </div>
    );
}
