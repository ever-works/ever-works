'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Work } from '@/lib/api/work';
import { cn } from '@/lib/utils/cn';
import { getWorks } from '@/app/actions/dashboard/works';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { WorkCard } from './WorkCard';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';

interface WorkListProps {
    initialWorks?: Work[];
    showLimit?: number;
    showHeader?: boolean;
    onUpdate?: (works: Work[]) => void;
}

export function WorkList({
    initialWorks = [],
    showLimit,
    showHeader = false,
    onUpdate,
}: WorkListProps) {
    const [works, setWorks] = useState<Work[]>(initialWorks);
    const [loading, setLoading] = useState(false);
    const t = useTranslations('dashboard.workList');

    const fetchWorks = useCallback(async () => {
        setLoading(true);
        try {
            const response = await getWorks({ limit: showLimit || 10 });
            if (response.success) {
                setWorks(response.works);
                onUpdate?.(response.works);
            }
        } catch (error) {
            console.error('Failed to fetch works:', error);
        } finally {
            setLoading(false);
        }
    }, [onUpdate, showLimit]);

    useEffect(() => {
        // If no initial works provided, fetch them
        if (initialWorks.length === 0) {
            void fetchWorks();
        }
    }, [fetchWorks, initialWorks.length]);

    if (loading && works.length === 0) {
        return <WorkListSkeleton />;
    }

    const displayWorks = showLimit ? works.slice(0, showLimit) : works;

    return (
        <div>
            {showHeader && (
                <div className="flex justify-between items-center mb-6">
                    <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h2>

                    <Link
                        href={ROUTES.DASHBOARD_NEW}
                        className={cn(
                            'px-4 py-2 rounded-lg font-medium transition-colors inline-flex items-center gap-2',
                            'bg-primary-500 hover:bg-primary-700 text-white',
                        )}
                    >
                        <Plus className="w-4 h-4" />
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
                {displayWorks.map((work) => (
                    <WorkCard key={work.id} work={work} />
                ))}
            </div>
        </div>
    );
}

function WorkListSkeleton() {
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
