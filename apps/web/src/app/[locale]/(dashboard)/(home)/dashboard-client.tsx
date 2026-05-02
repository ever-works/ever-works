'use client';

import { AuthUser } from '@/lib/auth';
import { WorkList } from '@/components/works/WorkList';
import { StatsOverview } from '@/components/dashboard/StatsOverview';
import { EmptyState } from '@/components/common/EmptyState';
import { GET_WORK_LIST_LIMIT, ROUTES } from '@/lib/constants';
import { Link, useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import type { Work } from '@/lib/api';

interface DashboardClientProps {
    user: AuthUser;
    initialWorks: Work[];
    totalWorks: number;
    totalItems: number;
    activeWebsites: number;
}

export default function DashboardClient({
    user,
    initialWorks,
    totalWorks,
    totalItems,
    activeWebsites,
}: DashboardClientProps) {
    const router = useRouter();
    const t = useTranslations('dashboard');
    const hasWorks = initialWorks.length > 0;

    return (
        <div className="w-full">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-text dark:text-text-dark">
                    {t('header.welcome', { username: user.username })}
                </h1>
                <p className="mt-2 text-text-secondary dark:text-text-secondary-dark">
                    {t('header.subtitle')}
                </p>
            </div>

            <StatsOverview
                totalWorks={totalWorks}
                totalItems={totalItems}
                activeWebsites={activeWebsites}
            />

            <div className="grid grid-cols-1 @3xl/main:grid-cols-3 gap-8 mt-8">
                <div className="@3xl/main:col-span-3">
                    {hasWorks ? (
                        <>
                            <div className="flex justify-between items-center mb-4">
                                <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                                    {t('works.recent')}
                                </h2>
                                {totalWorks > 5 && (
                                    <Link
                                        href={ROUTES.DASHBOARD_DIRECTORIES}
                                        className="text-sm text-primary hover:text-primary-hover transition-colors"
                                    >
                                        {t('works.viewAll', { count: totalWorks })}
                                    </Link>
                                )}
                            </div>
                            <WorkList initialWorks={initialWorks} showLimit={GET_WORK_LIST_LIMIT} />
                        </>
                    ) : (
                        <EmptyState
                            title={t('works.empty.title')}
                            description={t('works.empty.description')}
                            action={{
                                label: t('works.empty.action'),
                                onClick: () => {
                                    router.push(ROUTES.DASHBOARD_DIRECTORIES_NEW);
                                },
                            }}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}
