'use client';

import { AuthUser } from '@/lib/auth';
import { Suspense, useState, useCallback } from 'react';
import DashboardToasts from './toasts';
import { DashboardSidebar } from '@/components/dashboard/DashboardSidebar';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { Footer } from '@/components/footer';
import { HelpDrawer } from '@/components/dashboard/HelpDrawer';
import { ChatProvider } from '@/components/ai/ChatProvider';
import { ChatPanel } from '@/components/ai/ChatPanel';
import { useKeyboardShortcuts } from '@/lib/hooks/use-keyboard-shortcuts';
import { useSidebarPersistence } from '@/lib/hooks/use-sidebar-persistence';

interface DashboardLayoutClientProps {
    user: AuthUser;
    children: React.ReactNode;
}

export function DashboardLayoutClient({ user, children }: DashboardLayoutClientProps) {
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [helpOpen, setHelpOpen] = useState(false);
    const [chatOpen, setChatOpen] = useState(true);

    const { sidebarCollapsed, handleSidebarCollapsedChange } = useSidebarPersistence();

    const openHelp = useCallback(() => setHelpOpen(true), []);
    const closeHelp = useCallback(() => setHelpOpen(false), []);
    const toggleChat = useCallback(() => setChatOpen((v) => !v), []);

    useKeyboardShortcuts({ onOpenHelp: openHelp });

    return (
        <ChatProvider>
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

                {/* Navigation sidebar */}
                <DashboardSidebar
                    user={user}
                    isOpen={sidebarOpen}
                    onToggle={() => setSidebarOpen(!sidebarOpen)}
                    isCollapsed={sidebarCollapsed}
                    onCollapsedChange={handleSidebarCollapsedChange}
                    onOpenHelp={openHelp}
                    chatOpen={chatOpen}
                    onOpenChat={toggleChat}
                />

                {/* AI Chat panel — sits between sidebar and main content */}
                <ChatPanel open={chatOpen} onClose={toggleChat} />

                {/* Main content */}
                <div className="flex-1 flex flex-col overflow-hidden">
                    <DashboardHeader
                        user={user}
                        onMenuClick={() => setSidebarOpen(!sidebarOpen)}
                        isSidebarOpen={sidebarOpen}
                        onHelpClick={openHelp}
                    />

                    <main
                        className="flex-1 flex flex-col overflow-y-auto bg-surface dark:bg-surface-dark min-h-0"
                        id="main-content"
                    >
                        <div className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
                            {children}
                        </div>

                        <Footer />
                    </main>
                </div>
            </div>

            <HelpDrawer open={helpOpen} onClose={closeHelp} />
        </ChatProvider>
    );
}
