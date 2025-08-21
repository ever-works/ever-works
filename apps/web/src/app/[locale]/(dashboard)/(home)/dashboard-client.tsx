'use client';

import { AuthUser } from '@/lib/auth';
import { DirectoryList } from '@/components/directories/DirectoryList';
import { StatsOverview } from '@/components/dashboard/StatsOverview';
import { EmptyState } from '@/components/common/EmptyState';
import { ROUTES } from '@/lib/constants';
import { Link, useRouter } from '@/i18n/navigation';
import type { Directory } from '@/lib/api';

interface DashboardClientProps {
    user: AuthUser;
    initialDirectories: Directory[];
    totalDirectories: number;
}

export default function DashboardClient({
    user,
    initialDirectories,
    totalDirectories,
}: DashboardClientProps) {
    const router = useRouter();
    const hasDirectories = initialDirectories.length > 0;

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-text dark:text-text-dark">
                    Welcome back, {user.username}!
                </h1>
                <p className="mt-2 text-text-secondary dark:text-text-secondary-dark">
                    Manage your AI-powered directories and track their performance
                </p>
            </div>

            <StatsOverview totalDirectories={totalDirectories} />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mt-8">
                <div className="lg:col-span-3">
                    {hasDirectories ? (
                        <>
                            <div className="flex justify-between items-center mb-4">
                                <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                                    Recent Directories
                                </h2>
                                {totalDirectories > 5 && (
                                    <Link
                                        href={ROUTES.DASHBOARD_DIRECTORIES}
                                        className="text-sm text-primary hover:text-primary-hover transition-colors"
                                    >
                                        View all ({totalDirectories})
                                    </Link>
                                )}
                            </div>
                            <DirectoryList initialDirectories={initialDirectories} showLimit={5} />
                        </>
                    ) : (
                        <EmptyState
                            title="No directories yet"
                            description="Create your first AI-powered directory to start organizing and showcasing your content."
                            action={{
                                label: 'Create Your First Directory',
                                onClick: () => {
                                    router.push(ROUTES.DASHBOARD_DIRECTORIES_NEW);
                                },
                            }}
                        />
                    )}
                </div>

                {/* <div className="lg:col-span-1 hidden">
                    <RecentActivity />
                </div> */}
            </div>
        </div>
    );
}
