'use client';

import { AuthUser } from '@/lib/auth';
import { Suspense, useState, useCallback } from 'react';
import DashboardToasts from './toasts';
import { DashboardSidebar } from '@/components/dashboard/DashboardSidebar';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { GlobalNotificationBanner } from '@/components/dashboard/GlobalNotificationBanner';
import { Footer } from '@/components/footer';
import { HelpDrawer } from '@/components/dashboard/HelpDrawer';
import { useKeyboardShortcuts } from '@/lib/hooks/use-keyboard-shortcuts';
import { useSidebarPersistence } from '@/lib/hooks/use-sidebar-persistence';

interface DashboardLayoutClientProps {
    user: AuthUser;
    children: React.ReactNode;
}

export function DashboardLayoutClient({ user, children }: DashboardLayoutClientProps) {
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [helpOpen, setHelpOpen] = useState(false);

    const { sidebarWidth, sidebarCollapsed, handleSidebarWidthChange, handleSidebarCollapsedChange } =
        useSidebarPersistence();

    const openHelp = useCallback(() => setHelpOpen(true), []);
    const closeHelp = useCallback(() => setHelpOpen(false), []);

    // Register global keyboard shortcuts
    useKeyboardShortcuts({ onOpenHelp: openHelp });

    return (
        <>
            <Suspense fallback={null}>
                <DashboardToasts />
            </Suspense>

            <div className="flex h-screen bg-background dark:bg-background-dark overflow-hidden">
                {/* Mobile overlay - only on small screens */}
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
                    width={sidebarCollapsed ? 64 : sidebarWidth}
                    onWidthChange={handleSidebarWidthChange}
                    isCollapsed={sidebarCollapsed}
                    onCollapsedChange={handleSidebarCollapsedChange}
                />

                <div className="flex-1 flex flex-col overflow-hidden">
                    <DashboardHeader
                        user={user}
                        onMenuClick={() => setSidebarOpen(!sidebarOpen)}
                        isSidebarOpen={sidebarOpen}
                        onHelpClick={openHelp}
                    />

                    <GlobalNotificationBanner />

                    <main
                        className="flex-1 flex flex-col overflow-y-auto bg-surface dark:bg-surface-dark min-h-0"
                        id="main-content"
                    >
                        <div className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
                            {children}
                        </div>

                        <Footer />
                    </main>

                    {/* Footer */}
                </div>
            </div>

            <HelpDrawer open={helpOpen} onClose={closeHelp} />
        </>
    );
}
