'use client';

import { AuthUser } from '@/lib/auth';
import { Suspense, useState } from 'react';
import DashboardToasts from './dashboard-toasts';
import { DashboardSidebar } from '@/components/dashboard/DashboardSidebar';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DirectoryList } from '@/components/directories/DirectoryList';
import { StatsOverview } from '@/components/dashboard/StatsOverview';
import { RecentActivity } from '@/components/dashboard/RecentActivity';
import { EmptyState } from '@/components/common/EmptyState';

export default function DashboardClient({ user }: { user: AuthUser }) {
    const [sidebarOpen, setSidebarOpen] = useState(typeof window !== 'undefined' ? window.innerWidth >= 1024 : true);
    const [hasDirectories, setHasDirectories] = useState(false);

    return (
        <>
            <Suspense fallback={null}>
                <DashboardToasts />
            </Suspense>

            <div className="flex h-screen bg-background dark:bg-background-dark overflow-hidden">
                {/* Mobile overlay */}
                {sidebarOpen && (
                    <div 
                        className="fixed inset-0 bg-black/50 z-40 lg:hidden"
                        onClick={() => setSidebarOpen(false)}
                    />
                )}
                
                <DashboardSidebar 
                    user={user}
                    isOpen={sidebarOpen}
                    onToggle={() => setSidebarOpen(!sidebarOpen)}
                />

                <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                    <DashboardHeader 
                        user={user}
                        onMenuClick={() => setSidebarOpen(!sidebarOpen)}
                        isSidebarOpen={sidebarOpen}
                    />

                    <main className="flex-1 overflow-y-auto bg-surface dark:bg-surface-dark min-h-0">
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
                                        <DirectoryList onUpdate={(directories) => setHasDirectories(directories.length > 0)} />
                                    ) : (
                                        <EmptyState
                                            title="No directories yet"
                                            description="Create your first AI-powered directory to start organizing and showcasing your content."
                                            action={{
                                                label: "Create Your First Directory",
                                                onClick: () => {
                                                    // Will implement directory creation modal
                                                }
                                            }}
                                        />
                                    )}
                                </div>
                                <div className="lg:col-span-1">
                                    <RecentActivity />
                                </div>
                            </div>
                        </div>
                    </main>
                </div>
            </div>
        </>
    );
}