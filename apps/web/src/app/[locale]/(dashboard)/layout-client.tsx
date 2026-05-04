'use client';

import { AuthUser } from '@/lib/auth';
import React, { Suspense, useState, useCallback, useRef, useEffect } from 'react';
import { ChevronLeft, ChevronRight, GripVertical } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Tooltip } from '@/components/ui/tooltip';
import DashboardToasts from './toasts';
import { DashboardSidebar } from '@/components/dashboard/DashboardSidebar';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { Footer } from '@/components/footer';
import { HelpDrawer } from '@/components/dashboard/HelpDrawer';
import { ChatProvider } from '@/components/ai/ChatProvider';
import { ChatPanel } from '@/components/ai/ChatPanel';
import { getOnboardingPluginStatuses } from '@/app/actions/dashboard/onboarding';
import { useKeyboardShortcuts } from '@/lib/hooks/use-keyboard-shortcuts';
import { ConnectGithubModal } from '@/components/auth/connect-github-modal';
import { BackgroundActivityProvider } from '@/lib/hooks/use-background-activity';
import { EverWorksOnboardingWizard } from '@/components/onboarding/EverWorksOnboardingWizard';
import { useOnboardingState } from '@/components/onboarding/use-onboarding-state';
import type { UserPlugin } from '@/lib/api/plugins';
import type { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import type { GitProviderConnectionInfo } from '@/lib/api/plugins-capabilities/git-providers';
import type { PluginDeviceAuthStatus } from '@/lib/api/plugins-capabilities/device-auth';

interface DashboardLayoutClientProps {
    user: AuthUser;
    children: React.ReactNode;
    initialChatOpen?: boolean;
    initialSidebarCollapsed?: boolean;
    hasGithubConnected?: boolean;
    onboardingTotalWorks: number;
    onboardingPlugins: UserPlugin[];
    initialOnboardingConnections: Record<
        string,
        OAuthConnectionInfo | GitProviderConnectionInfo | null
    >;
    initialOnboardingDeviceAuthStatuses: Record<string, PluginDeviceAuthStatus | null>;
}

const COOKIE_OPTS = `path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;

export function DashboardLayoutClient({
    user,
    children,
    initialChatOpen = false,
    initialSidebarCollapsed = false,
    hasGithubConnected = false,
    onboardingTotalWorks,
    onboardingPlugins,
    initialOnboardingConnections,
    initialOnboardingDeviceAuthStatuses,
}: DashboardLayoutClientProps) {
    const tChat = useTranslations('dashboard.aiChat');
    const DEFAULT_CHAT_WIDTH = 380;
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [helpOpen, setHelpOpen] = useState(false);
    const [onboardingOpen, setOnboardingOpen] = useState(false);
    const [chatOpen, setChatOpenRaw] = useState(initialChatOpen);
    const [sidebarCollapsed, setSidebarCollapsedRaw] = useState(initialSidebarCollapsed);
    const [chatWidth, setChatWidth] = useState<number>(DEFAULT_CHAT_WIDTH);
    const [isChatExpanded, setIsChatExpanded] = useState(false);
    const chatRef = useRef<HTMLDivElement | null>(null);
    const [onboardingState, setOnboardingState] = useOnboardingState();
    const [onboardingConnections, setOnboardingConnections] = useState(
        initialOnboardingConnections,
    );
    const [onboardingDeviceAuthStatuses, setOnboardingDeviceAuthStatuses] = useState(
        initialOnboardingDeviceAuthStatuses,
    );
    const [isLoadingOnboardingStatuses, setIsLoadingOnboardingStatuses] = useState(false);
    const [hasRequestedOnboardingStatuses, setHasRequestedOnboardingStatuses] = useState(false);

    const prevWidthRef = useRef<number | null>(null);
    const [mainStyle, setMainStyle] = useState<React.CSSProperties | undefined>(undefined);
    const [isMobile, setIsMobile] = useState<boolean>(false);
    const onboardingTotalSteps = onboardingPlugins.length + 2;
    const onboardingCurrentStep = Math.min(onboardingState.step, onboardingTotalSteps - 1) + 1;
    const shouldAutoOpenOnboarding = onboardingTotalWorks === 0 && !onboardingState.modalDismissed;
    const isOnboardingOpen = onboardingOpen || shouldAutoOpenOnboarding;
    const showOnboardingBadge =
        onboardingTotalWorks === 0 &&
        onboardingState.modalDismissed &&
        !onboardingState.headerDismissed;

    const loadOnboardingStatuses = useCallback(async () => {
        if (onboardingPlugins.length === 0) {
            setHasRequestedOnboardingStatuses(true);
            return;
        }

        setHasRequestedOnboardingStatuses(true);
        setIsLoadingOnboardingStatuses(true);

        try {
            const result = await getOnboardingPluginStatuses(
                onboardingPlugins.map((plugin) => ({
                    pluginId: plugin.pluginId,
                    capabilities: plugin.capabilities,
                })),
            );

            if (!result.success || !result.data) {
                return;
            }

            setOnboardingConnections(result.data.connections);
            setOnboardingDeviceAuthStatuses(result.data.deviceAuthStatuses);
        } finally {
            setIsLoadingOnboardingStatuses(false);
        }
    }, [onboardingPlugins]);

    useEffect(() => {
        if (!isOnboardingOpen || hasRequestedOnboardingStatuses || isLoadingOnboardingStatuses) {
            return;
        }

        void loadOnboardingStatuses();
    }, [
        hasRequestedOnboardingStatuses,
        isLoadingOnboardingStatuses,
        isOnboardingOpen,
        loadOnboardingStatuses,
    ]);

    const setChatOpen = useCallback((value: boolean, resetOnOpen = true) => {
        setChatOpenRaw(value);
        document.cookie = `chat-panel-open=${value ? '1' : '0'}; ${COOKIE_OPTS}`;

        if (value) {
            if (resetOnOpen) {
                // When reopening the chat normally, reset to resizable (non-expanded) mode
                // and restore the last saved resizable width if available.
                setIsChatExpanded(false);
                setMainStyle(undefined);
                try {
                    const v = localStorage.getItem('chat-width');
                    setChatWidth(v ? parseInt(v, 10) : DEFAULT_CHAT_WIDTH);
                } catch (e) {}
            }
        } else {
            // If closing chat, clear any main-style overrides so layout returns to normal
            setMainStyle(undefined);
        }
    }, []);

    useEffect(() => {
        try {
            const v = localStorage.getItem('chat-width');
            const savedWidth = v ? parseInt(v, 10) : DEFAULT_CHAT_WIDTH;
            setChatWidth(Number.isFinite(savedWidth) ? savedWidth : DEFAULT_CHAT_WIDTH);
        } catch (e) {}

        try {
            setIsMobile(window.innerWidth < 768);
        } catch (e) {}
    }, []);

    useEffect(() => {
        try {
            // Only persist the width when the chat is in resizable (non-expanded) mode.
            // This prevents the expanded width from overwriting the user's preferred
            // resizable width in localStorage.
            if (!isChatExpanded) {
                localStorage.setItem('chat-width', String(chatWidth));
            }
        } catch {}
    }, [chatWidth, isChatExpanded]);

    useEffect(() => {
        try {
            const savedWidth = localStorage.getItem('chat-width');
            if (savedWidth) {
                setChatWidth(parseInt(savedWidth, 10));
            }
        } catch {}

        setIsMobile(window.innerWidth < 768);
    }, []);

    const computeMainStyle = useCallback(() => {
        if (!isChatExpanded) return undefined;
        if (typeof window === 'undefined') return undefined;

        const ww = window.innerWidth;
        const sidebarWidth = sidebarCollapsed ? 64 : 240;
        const controlsWidth = chatOpen ? 48 : 0; // space for the control stack

        // available width for main = viewport - sidebar - chat - controls - some gap
        const available = ww - sidebarWidth - chatWidth - controlsWidth - 48;

        // On large screens, always show remaining main area (even if small) to allow 70/30 split
        const LARGE_BREAKPOINT = 1200;
        if (ww >= LARGE_BREAKPOINT) {
            const w = Math.max(0, Math.floor(available));
            return { width: w, flex: `0 0 ${w}px`, transition: 'width 200ms ease' };
        }

        // On smaller screens, only show main when there's enough space
        const minVisible = 320;
        if (available >= minVisible) {
            const w = Math.floor(available);
            return { width: w, flex: `0 0 ${w}px`, transition: 'width 200ms ease' };
        }

        // If there's little room left, collapse main to zero for focused chat
        return { width: 0, flex: '0 0 0', transition: 'width 200ms ease' };
    }, [isChatExpanded, sidebarCollapsed, chatWidth, chatOpen]);

    useEffect(() => {
        setMainStyle(computeMainStyle());
        const onResize = () => {
            setIsMobile(window.innerWidth < 768);
            setMainStyle(computeMainStyle());
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [computeMainStyle, sidebarCollapsed, chatWidth, chatOpen]);

    // Ensure persisted chat width does not exceed 50% of viewport on mount
    useEffect(() => {
        try {
            const max = Math.floor(window.innerWidth * 0.5);
            if (chatWidth > max) setChatWidth(Math.max(240, max));
        } catch (e) {}
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Drag behavior: attach pointermove/up when drag starts to ensure immediate response

    const handleSidebarCollapsedChange = useCallback(
        (value: boolean) => {
            setSidebarCollapsedRaw(value);
            document.cookie = `sidebar-collapsed=${value ? '1' : '0'}; ${COOKIE_OPTS}`;

            // If collapsing the sidebar while chat is expanded, immediately hide
            // the main content to keep focus on expanded chat.
            if (value && isChatExpanded) {
                setMainStyle({ width: 0, flex: '0 0 0', transition: 'width 200ms ease' });
            }
        },
        [isChatExpanded],
    );

    const openHelp = useCallback(() => setHelpOpen(true), []);
    const closeHelp = useCallback(() => setHelpOpen(false), []);
    const toggleChat = useCallback(() => setChatOpen(!chatOpen), [chatOpen, setChatOpen]);
    const openOnboarding = useCallback(() => setOnboardingOpen(true), []);
    const closeOnboarding = useCallback(() => {
        setOnboardingOpen(false);
        setOnboardingState({
            ...onboardingState,
            modalDismissed: true,
        });
    }, [onboardingState, setOnboardingState]);
    const dismissOnboardingBadge = useCallback(() => {
        setOnboardingState({
            ...onboardingState,
            modalDismissed: true,
            headerDismissed: true,
        });
    }, [onboardingState, setOnboardingState]);

    // Ensure chat is in resizable (non-expanded) mode. Used when user interacts
    // with the sidebar so we collapse the expanded view back to the resizable width.
    const ensureResizableMode = useCallback(() => {
        if (isChatExpanded) {
            setIsChatExpanded(false);
            setMainStyle(undefined);
            try {
                const v = localStorage.getItem('chat-width');
                setChatWidth(v ? parseInt(v, 10) : DEFAULT_CHAT_WIDTH);
            } catch (e) {}
        }
    }, [isChatExpanded]);

    const handleCollapse = useCallback(() => {
        if (chatOpen) {
            // store last width optionally, but do not restore expanded state on reopen
            prevWidthRef.current = chatWidth;
            setChatOpen(false);
        } else {
            // Reopening always resets to resizable default width via setChatOpen
            setChatOpen(true);
        }
        setIsChatExpanded(false);
    }, [chatOpen, chatWidth, setChatOpen]);

    const handleExpand = useCallback(() => {
        // expand chat to fill available space (viewport minus sidebar and controls)
        const sidebarWidth = sidebarCollapsed ? 64 : 240;
        const controlsWidth = 48; // width reserved for the control stack
        const available = Math.max(320, window.innerWidth - sidebarWidth - controlsWidth - 48);
        prevWidthRef.current = chatWidth;
        setChatWidth(available);
        // Open chat without resetting expanded state
        setChatOpen(true, false);
        setIsChatExpanded(true);
    }, [chatWidth, setChatOpen, sidebarCollapsed]);

    const startDrag = useCallback((e: React.PointerEvent<Element>) => {
        e.preventDefault();
        // Use currentTarget/target cast to Element to call setPointerCapture
        (e.target as Element).setPointerCapture?.(e.pointerId);

        const handlePointerMove = (ev: PointerEvent) => {
            if (!chatRef.current) return;
            const rect = chatRef.current.getBoundingClientRect();
            const maxWidth = Math.floor(window.innerWidth * 0.5);
            const pointerWidth = Math.max(0, ev.clientX - rect.left);
            const newWidth = Math.max(350, Math.min(maxWidth, pointerWidth));
            setChatWidth(newWidth);
            setIsChatExpanded(false);
        };

        const handlePointerUp = (ev: PointerEvent) => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
        };

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
    }, []);

    useKeyboardShortcuts({ onOpenHelp: openHelp });

    return (
        <BackgroundActivityProvider>
            <ChatProvider>
                <EverWorksOnboardingWizard
                    open={isOnboardingOpen}
                    state={onboardingState}
                    plugins={onboardingPlugins}
                    connections={onboardingConnections}
                    deviceAuthStatuses={onboardingDeviceAuthStatuses}
                    isStatusLoading={isLoadingOnboardingStatuses}
                    onStateChange={setOnboardingState}
                    onClose={closeOnboarding}
                />

                <Suspense fallback={null}>
                    <DashboardToasts />
                </Suspense>
                <ConnectGithubModal userId={user.id} hasGithubConnected={hasGithubConnected} />

                <div className="flex h-screen bg-surface dark:bg-surface-dark overflow-hidden">
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
                        onInteraction={ensureResizableMode}
                    />

                    {/* AI Chat panel — side panel on desktop, full-screen overlay on mobile */}
                    {!isMobile ? (
                        <div
                            ref={chatRef}
                            className="relative h-full"
                            style={{
                                width: chatOpen ? chatWidth : 0,
                                transition: 'width 200ms ease',
                            }}
                        >
                            <ChatPanel
                                open={chatOpen}
                                onClose={toggleChat}
                                style={{ width: '100%' }}
                            />
                        </div>
                    ) : (
                        chatOpen && (
                            <div className="fixed inset-0 z-50 flex">
                                <div
                                    className="absolute inset-0 bg-black/40"
                                    onClick={() => setChatOpen(false)}
                                />
                                <div className="relative w-full h-full bg-transparent">
                                    <div className="h-full bg-white dark:bg-surface-dark shadow-lg">
                                        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
                                            <div className="text-sm font-medium">
                                                {tChat('panelTitle')}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <button
                                                    aria-label={tChat('closeChat')}
                                                    onClick={() => setChatOpen(false)}
                                                    className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-surface-secondary"
                                                >
                                                    <ChevronRight className="w-4 h-4 rotate-180" />
                                                </button>
                                            </div>
                                        </div>
                                        <div className="h-[calc(100%-48px)]">
                                            <ChatPanel
                                                open={chatOpen}
                                                onClose={toggleChat}
                                                style={{ width: '100%', height: '100%' }}
                                            />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )
                    )}

                    {/* Resize controls: collapse / drag handle / expand (only when chat is open) */}
                    {chatOpen && !isMobile && (
                        <div className="relative">
                            <div className="flex flex-col items-center w-5 -ml-3.5 absolute -right-3 top-1/2 -translate-y-1/2 z-10">
                                <button
                                    aria-label={tChat('collapseChat')}
                                    onClick={handleCollapse}
                                    className="w-5 h-5 flex -ml-1.5 text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-white cursor-pointer items-center border rounded-full p-1 justify-center bg-white dark:bg-surface-dark"
                                >
                                    <ChevronLeft className="w-4 h-4" />
                                </button>
                                <div
                                    onPointerDown={startDrag}
                                    className="w-2.5 h-5 -ml-1 my-1.5 flex text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-white items-center justify-center cursor-col-resize bg-white dark:bg-surface-dark rounded"
                                    title={tChat('resizeChat')}
                                >
                                    <GripVertical className="w-full h-4 text-text-muted/70" />
                                </div>
                                <button
                                    aria-label={tChat('expandChat')}
                                    onClick={handleExpand}
                                    className="w-5 h-5 flex -ml-1.5 text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-white cursor-pointer items-center border rounded-full p-1 justify-center bg-white dark:bg-surface-dark"
                                >
                                    <ChevronRight className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Main content — uses @container so children respond to available space, not viewport */}
                    <div
                        className={'flex-1 flex flex-col overflow-hidden @container/main'}
                        style={isChatExpanded ? mainStyle : undefined}
                        aria-hidden={isChatExpanded}
                    >
                        <DashboardHeader
                            user={user}
                            onMenuClick={() => setSidebarOpen(!sidebarOpen)}
                            isSidebarOpen={sidebarOpen}
                            onHelpClick={openHelp}
                            onboardingBadge={
                                showOnboardingBadge
                                    ? {
                                          currentStep: onboardingCurrentStep,
                                          totalSteps: onboardingTotalSteps,
                                          onOpen: openOnboarding,
                                          onDismiss: dismissOnboardingBadge,
                                      }
                                    : undefined
                            }
                        />

                        <main
                            className="flex-1 flex flex-col overflow-y-auto bg-white dark:bg-surface-dark min-h-0"
                            id="main-content"
                        >
                            <div className="flex-1 mx-auto w-full px-4 @sm/main:px-6 @3xl/main:px-8 py-6 @3xl/main:py-8 max-w-full @5xl/main:max-w-7xl">
                                {children}
                            </div>

                            <Footer />
                        </main>
                    </div>
                </div>

                <HelpDrawer
                    open={helpOpen}
                    onClose={closeHelp}
                    onboarding={{
                        currentStep: onboardingCurrentStep,
                        totalSteps: onboardingTotalSteps,
                        onOpen: openOnboarding,
                    }}
                />
            </ChatProvider>
        </BackgroundActivityProvider>
    );
}
