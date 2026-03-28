'use client';

import { AuthUser } from '@/lib/auth';
import { Suspense, useState, useCallback } from 'react';
import DashboardToasts from './toasts';
import { DashboardSidebar } from '@/components/dashboard/DashboardSidebar';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { Footer } from '@/components/footer';
import { HelpDrawer } from '@/components/dashboard/HelpDrawer';
import { ConnectGithubModal } from '@/components/auth/connect-github-modal';
import { ChatProvider } from '@/components/ai/ChatProvider';
import { ChatPanel } from '@/components/ai/ChatPanel';
import { useKeyboardShortcuts } from '@/lib/hooks/use-keyboard-shortcuts';
import { useSidebarPersistence } from '@/lib/hooks/use-sidebar-persistence';

interface DashboardLayoutClientProps {
    user: AuthUser;
    children: React.ReactNode;
    initialChatOpen?: boolean;
}

export function DashboardLayoutClient({
    user,
    children,
    initialChatOpen = false,
}: DashboardLayoutClientProps) {
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [helpOpen, setHelpOpen] = useState(false);
    const [chatOpen, setChatOpenRaw] = useState(initialChatOpen);

    const setChatOpen = useCallback((value: boolean) => {
        setChatOpenRaw(value);
        document.cookie = `chat-panel-open=${value ? '1' : '0'}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    }, []);

    const { sidebarCollapsed, handleSidebarCollapsedChange } = useSidebarPersistence();

    const openHelp = useCallback(() => setHelpOpen(true), []);
    const closeHelp = useCallback(() => setHelpOpen(false), []);
    const toggleChat = useCallback(() => setChatOpen(!chatOpen), [chatOpen, setChatOpen]);

    useKeyboardShortcuts({ onOpenHelp: openHelp });

    return (
        <ChatProvider>
            <Suspense fallback={null}>
                <DashboardToasts />
            </Suspense>

            <div className="flex h-screen overflow-hidden bg-background dark:bg-background-dark">
                {/* Mobile overlay */}
                {sidebarOpen && (
                    <div
                        className="fixed inset-0 z-40 bg-black/50 lg:hidden"
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

                {/* AI Chat panel sits between sidebar and main content */}
                <ChatPanel open={chatOpen} onClose={toggleChat} />

                {/* Main content uses @container so children respond to available space, not viewport */}
                <div className="flex flex-1 flex-col overflow-hidden @container/main">
                    <DashboardHeader
                        user={user}
                        onMenuClick={() => setSidebarOpen(!sidebarOpen)}
                        isSidebarOpen={sidebarOpen}
                        onHelpClick={openHelp}
                    />

                    <main
                        className="min-h-0 flex flex-1 flex-col overflow-y-auto bg-surface dark:bg-surface-dark"
                        id="main-content"
                    >
                        <div className="mx-auto flex-1 w-full max-w-full px-4 py-6 @sm/main:px-6 @3xl/main:px-8 @3xl/main:py-8 @5xl/main:max-w-7xl">
                            {children}
                        </div>

                        <Footer />
                    </main>
                </div>
            </div>

            <HelpDrawer open={helpOpen} onClose={closeHelp} />
            <ConnectGithubModal
                hasGithubConnected={
                    user.provider === 'github' ||
                    user.connectedProviders?.includes('github') === true
                }
            />
        </ChatProvider>
    );
}
