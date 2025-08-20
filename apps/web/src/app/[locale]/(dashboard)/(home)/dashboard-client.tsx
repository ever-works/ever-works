'use client';

import { AuthUser } from '@/lib/auth';
import { useState } from 'react';
import { DirectoryList } from '@/components/directories/DirectoryList';
import { StatsOverview } from '@/components/dashboard/StatsOverview';
import { RecentActivity } from '@/components/dashboard/RecentActivity';
import { EmptyState } from '@/components/common/EmptyState';
import { ROUTES } from '@/lib/constants';
import { useRouter } from '@/i18n/navigation';

export default function DashboardClient({ user }: { user: AuthUser }) {
    const [hasDirectories, setHasDirectories] = useState(false);
    const router = useRouter();

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

            <StatsOverview />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mt-8">
                <div className="lg:col-span-2">
                    {hasDirectories ? (
                        <DirectoryList
                            onUpdate={(directories) => setHasDirectories(directories.length > 0)}
                        />
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
                <div className="lg:col-span-1">
                    <RecentActivity />
                </div>
            </div>
        </div>
    );
}
