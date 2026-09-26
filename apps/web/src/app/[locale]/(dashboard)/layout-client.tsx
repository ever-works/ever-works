'use client';

import { AuthUser } from '@/lib/auth';
import React, { Suspense, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight, GripVertical } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Tooltip } from '@/components/ui/tooltip';
import DashboardToasts from './toasts';
import { DashboardSidebar } from '@/components/dashboard/DashboardSidebar';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { Footer } from '@/components/footer';
import { HelpDrawer, type HelpDrawerTab } from '@/components/dashboard/HelpDrawer';
import { HelpCenterProvider } from '@/components/help/HelpCenterProvider';
import { captureHelpEvent, helpRouteGroup, type HelpOpenSource } from '@/lib/help/help-telemetry';
import { CommandPalette } from '@/components/command-palette/CommandPalette';
import {
    CommandPaletteProvider,
    useCommandPalette,
} from '@/components/command-palette/CommandPaletteProvider';
import { WhatsNewPanel } from '@/components/whats-new/WhatsNewPanel';
import { ChatProvider } from '@/components/ai/ChatProvider';
import { ChatPanel } from '@/components/ai/ChatPanel';
import {
    adoptableChatPanelWidth,
    ChatPanelProvider,
    CHAT_PANEL_MIN_WIDTH,
    chatPanelWidthForKey,
    readSavedChatPanelWidth,
    resetChatPanelWidth,
    useChatPanelWidth,
} from '@/lib/hooks/use-chat-panel';
import { useKeyboardShortcuts } from '@/lib/hooks/use-keyboard-shortcuts';
import { ConnectGithubModal } from '@/components/auth/connect-github-modal';
import { BackgroundActivityProvider } from '@/lib/hooks/use-background-activity';
import { EverWorksOnboardingWizard } from '@/components/onboarding/EverWorksOnboardingWizard';
import { PostHogIdentify } from '@/components/posthog/PostHogIdentify';
import { computeStepList } from '@/components/onboarding/useOnboardingFlow';
import { dismissOnboarding } from '@/app/actions/onboarding/state';
import { ONBOARDING_DEFAULT_STATE } from '@ever-works/contracts/api';
import type { OnboardingCatalogResponse, OnboardingStateResponse } from '@ever-works/contracts/api';
import type { UserPlugin } from '@/lib/api/plugins';
import type { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import type { GitProviderConnectionInfo } from '@/lib/api/plugins-capabilities/git-providers';
import type { PluginDeviceAuthStatus } from '@/lib/api/plugins-capabilities/device-auth';
import type { ApiVersion } from '@/lib/api/version';
import { JobRuntimeDegradedBanner } from '@/components/dashboard/JobRuntimeDegradedBanner';
import { ScrollTopOnNavigate } from '@/components/dashboard/ScrollTopOnNavigate';

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
    initialOnboardingState: OnboardingStateResponse;
    initialOnboardingCatalog: OnboardingCatalogResponse;
    /** Build/release identity of the API, fetched once in the server layout. */
    apiVersion?: ApiVersion | null;
    /** health `job_runtime.configured` — false = agent runs cannot execute
     *  on this install (loud-degradation banner); null = unknown. */
    jobRuntimeConfigured?: boolean | null;
    /** What's new (AW-14) — unread product changelog entries; null = unknown (no badge). */
    changelogUnreadCount?: number | null;
}

/**
 * Dashboard-wide keyboard shortcuts. Rendered inside the command-palette
 * provider so `Ctrl/Cmd+K` and `/` can open the palette; `C` and `?` keep
 * their behaviour.
 */
function DashboardKeyboardShortcuts({ onOpenHelp }: { onOpenHelp: () => void }) {
    const palette = useCommandPalette();
    useKeyboardShortcuts({ onOpenHelp, onOpenPalette: palette?.openPalette });
    return null;
}

// Security: include the Secure flag when the page is served over HTTPS so these
// UI-state cookies are never transmitted in plaintext on an HTTPS deployment.
// Evaluated lazily at call-time (client-side only) so SSR is unaffected.
function getCookieOpts(): string {
    const secure =
        typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; Secure' : '';
    return `path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax${secure}`;
}

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
    initialOnboardingState,
    initialOnboardingCatalog,
    apiVersion,
    jobRuntimeConfigured = null,
    changelogUnreadCount = null,
}: DashboardLayoutClientProps) {
    const tChat = useTranslations('dashboard.aiChat');
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [helpOpen, setHelpOpen] = useState(false);
    // Tab the Help drawer opens on when a palette command asks for one.
    const [helpTab, setHelpTab] = useState<HelpDrawerTab | undefined>(undefined);
    // Help centre (AW-25): the manual article a help link asked for, if any.
    const [helpTarget, setHelpTarget] = useState<string | null>(null);
    // What's new (AW-14): the panel's open state mirrors `helpOpen`; the count
    // is seeded once from the server layout and then only updated from the
    // panel's own responses — no polling (spec FR-31).
    const [whatsNewOpen, setWhatsNewOpen] = useState(false);
    const [whatsNewUnread, setWhatsNewUnread] = useState<number | null>(changelogUnreadCount);
    const [onboardingOpenManually, setOnboardingOpenManually] = useState(false);
    const [chatOpen, setChatOpenRaw] = useState(initialChatOpen);
    const [sidebarCollapsed, setSidebarCollapsedRaw] = useState(initialSidebarCollapsed);
    const [isChatExpanded, setIsChatExpanded] = useState(false);
    // Owns the resizable width and its localStorage round-trip (EW-817).
    const [chatWidth, setChatWidth] = useChatPanelWidth(isChatExpanded);
    const chatRef = useRef<HTMLDivElement | null>(null);

    // Server-authoritative onboarding state; mutated optimistically by the
    // wizard's own server-action calls and by close/dismiss handlers below.
    const [onboardingState, setOnboardingState] = useState(initialOnboardingState);

    const prevWidthRef = useRef<number | null>(null);
    const [mainStyle, setMainStyle] = useState<React.CSSProperties | undefined>(undefined);
    const [isMobile, setIsMobile] = useState<boolean>(false);

    // The v2 wizard derives its own step list from the user's choices —
    // config sub-steps are skipped when the user picks an Ever Works default
    // for that bucket. Re-derive the same way here so the header "x of N"
    // badge matches the actual flow length (7 with all defaults, up to 10
    // with all BYOK + 'k8s' deploy). Hardcoding `9` drifted the badge any
    // time the user picked Ever Works for at least one bucket. Greptile P2
    // from PR #705.
    const onboardingStepList = useMemo(
        () => computeStepList(onboardingState.state ?? ONBOARDING_DEFAULT_STATE),
        [onboardingState.state],
    );
    const onboardingTotalSteps = onboardingStepList.length;
    const onboardingCurrentStep = Math.min(
        (onboardingState.state?.lastStep ?? 0) + 1,
        onboardingTotalSteps,
    );

    const isOnboardingDismissed = Boolean(onboardingState.dismissedAt);
    const isOnboardingCompleted = Boolean(onboardingState.completedAt);
    const shouldAutoOpenOnboarding =
        onboardingTotalWorks === 0 && !isOnboardingDismissed && !isOnboardingCompleted;
    const isOnboardingOpen = onboardingOpenManually || shouldAutoOpenOnboarding;
    // Track header-badge dismissal separately from wizard dismissal — both share
    // `dismissedAt` on the server, but dismissing the badge X must not require
    // marking onboarding as completed, and dismissing the wizard must leave the
    // badge visible. v1 kept the same split as `headerDismissed` in localStorage;
    // keep the client-only convention to avoid an API/DB migration.
    const headerDismissedKey = `ever-works-onboarding-header-dismissed:${user.id}`;
    const [headerDismissed, setHeaderDismissed] = useState(false);
    // Gate the badge on hydration so users who previously dismissed don't see
    // a one-frame flash of the badge before the useEffect reads localStorage.
    // Trade-off: all users see ~one frame without the badge instead — that's a
    // strictly better failure mode for an informational element.
    const [headerHydrated, setHeaderHydrated] = useState(false);
    useEffect(() => {
        try {
            if (typeof window !== 'undefined') {
                setHeaderDismissed(window.localStorage.getItem(headerDismissedKey) === '1');
            }
        } catch {
            // localStorage unavailable (private mode, quota) — leave default.
        }
        setHeaderHydrated(true);
    }, [headerDismissedKey]);
    const showOnboardingBadge =
        headerHydrated &&
        onboardingTotalWorks === 0 &&
        isOnboardingDismissed &&
        !isOnboardingCompleted &&
        !headerDismissed;

    const setChatOpen = useCallback(
        (value: boolean, resetOnOpen = true) => {
            setChatOpenRaw(value);
            document.cookie = `chat-panel-open=${value ? '1' : '0'}; ${getCookieOpts()}`;

            if (value) {
                if (resetOnOpen) {
                    // When reopening the chat normally, reset to resizable (non-expanded) mode
                    // and restore the last saved resizable width if available.
                    setIsChatExpanded(false);
                    setMainStyle(undefined);
                    // Through the hook's reader, which falls back to the
                    // default on a value `parseInt` would turn into NaN. The
                    // raw read this replaces committed that NaN: the panel
                    // rendered `width: NaNpx` (dropped by CSSOM, so no explicit
                    // width at all) and the handle published
                    // `aria-valuenow="NaN"`.
                    setChatWidth(adoptableChatPanelWidth(readSavedChatPanelWidth()));
                }
            } else {
                // If closing chat, clear any main-style overrides so layout returns to normal
                setMainStyle(undefined);
            }
        },
        [setChatWidth],
    );

    // The chat width's own read-back-and-persist pair lives in `useChatPanelWidth`
    // (EW-817). Only the viewport probe is left here.
    useEffect(() => {
        try {
            setIsMobile(window.innerWidth < 768);
        } catch (e) {}
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

    // The "persisted width must not exceed half the viewport" guard that used
    // to live here now runs inside `useChatPanelWidth`, as
    // `adoptableChatPanelWidth`. It had `[]` deps, so it closed over the first
    // render's width — always the default — and fired only below 760px; the
    // width it was written to clamp was never the width it compared.

    // Drag behavior: attach pointermove/up when drag starts to ensure immediate response

    const handleSidebarCollapsedChange = useCallback(
        (value: boolean) => {
            setSidebarCollapsedRaw(value);
            document.cookie = `sidebar-collapsed=${value ? '1' : '0'}; ${getCookieOpts()}`;

            // If collapsing the sidebar while chat is expanded, immediately hide
            // the main content to keep focus on expanded chat.
            if (value && isChatExpanded) {
                setMainStyle({ width: 0, flex: '0 0 0', transition: 'width 200ms ease' });
            }
        },
        [isChatExpanded],
    );

    const openHelp = useCallback(() => {
        setHelpTab(undefined);
        setHelpTarget(null);
        setHelpOpen(true);
    }, []);
    const openHelpAt = useCallback((tab?: HelpDrawerTab) => {
        setHelpTab(tab);
        setHelpTarget(null);
        setHelpOpen(true);
    }, []);
    // Every way into Help reports where it came from (AW-25 telemetry); the
    // drawer behaviour behind each entry point is unchanged.
    const reportHelpOpened = useCallback((source: HelpOpenSource) => {
        captureHelpEvent({
            name: 'help_opened',
            properties: {
                source,
                route_group: helpRouteGroup(
                    typeof window === 'undefined' ? null : window.location.pathname,
                ),
            },
        });
    }, []);
    const openHelpFromShortcut = useCallback(() => {
        reportHelpOpened('shortcut');
        openHelp();
    }, [openHelp, reportHelpOpened]);
    const openHelpFromHeader = useCallback(() => {
        reportHelpOpened('header');
        openHelp();
    }, [openHelp, reportHelpOpened]);
    const openHelpFromSidebar = useCallback(() => {
        reportHelpOpened('sidebar');
        openHelp();
    }, [openHelp, reportHelpOpened]);
    const openHelpTabFromSidebar = useCallback(
        (tab: HelpDrawerTab) => {
            reportHelpOpened('sidebar');
            openHelpAt(tab);
        },
        [openHelpAt, reportHelpOpened],
    );
    const openHelpFromPalette = useCallback(
        (tab?: HelpDrawerTab) => {
            reportHelpOpened('palette');
            openHelpAt(tab);
        },
        [openHelpAt, reportHelpOpened],
    );
    // A help link: open the drawer on its Manual tab at one article, in place.
    const openHelpArticle = useCallback(
        (target: string) => {
            reportHelpOpened('deep_link');
            setHelpTab(undefined);
            setHelpTarget(target);
            setHelpOpen(true);
        },
        [reportHelpOpened],
    );
    const closeHelp = useCallback(() => setHelpOpen(false), []);
    const openWhatsNew = useCallback(() => setWhatsNewOpen(true), []);
    const closeWhatsNew = useCallback(() => setWhatsNewOpen(false), []);
    const toggleChat = useCallback(() => setChatOpen(!chatOpen), [chatOpen, setChatOpen]);
    const openOnboarding = useCallback(() => setOnboardingOpenManually(true), []);
    const closeOnboarding = useCallback(() => {
        setOnboardingOpenManually(false);
        // Optimistically flip dismissedAt so the badge appears and we don't
        // auto-reopen on the next mount. The server action persists.
        setOnboardingState((prev) => ({
            ...prev,
            dismissedAt: prev.dismissedAt ?? new Date().toISOString(),
        }));
        void dismissOnboarding();
    }, []);
    const dismissOnboardingBadge = useCallback(() => {
        setHeaderDismissed(true);
        try {
            if (typeof window !== 'undefined') {
                window.localStorage.setItem(headerDismissedKey, '1');
            }
        } catch {
            // localStorage unavailable; state update alone hides the badge for
            // this session, which is still better than the prior no-op.
        }
        setOnboardingState((prev) => ({
            ...prev,
            dismissedAt: prev.dismissedAt ?? new Date().toISOString(),
        }));
        void dismissOnboarding();
    }, [headerDismissedKey]);

    // Ensure chat is in resizable (non-expanded) mode. Used when user interacts
    // with the sidebar so we collapse the expanded view back to the resizable width.
    const ensureResizableMode = useCallback(() => {
        if (isChatExpanded) {
            setIsChatExpanded(false);
            setMainStyle(undefined);
            setChatWidth(adoptableChatPanelWidth(readSavedChatPanelWidth()));
        }
    }, [isChatExpanded, setChatWidth]);

    const handleCollapse = useCallback(() => {
        if (chatOpen) {
            // store last width optionally, but do not restore expanded state on reopen
            prevWidthRef.current = chatWidth;
            setChatOpen(false);
        } else {
            // Reopening always resets to resizable default width via setChatOpen
            setChatOpen(true);
        }
        // Leaving expanded mode has to put the resizable width back in the
        // SAME batch as the flag — see the contract on `useChatPanelWidth`.
        // Without this the persist effect saw `isChatExpanded: false` with
        // `chatWidth` still at the expanded value and wrote THAT to storage,
        // so one click of the collapse chevron replaced the user's saved
        // width with the expanded one, for good.
        if (isChatExpanded) {
            setChatWidth(adoptableChatPanelWidth(readSavedChatPanelWidth()));
        }
        setIsChatExpanded(false);
    }, [chatOpen, chatWidth, isChatExpanded, setChatOpen, setChatWidth]);

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
    }, [chatWidth, setChatOpen, setChatWidth, sidebarCollapsed]);

    const startDrag = useCallback(
        (e: React.PointerEvent<Element>) => {
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
        },
        [setChatWidth],
    );

    // Double-click on the handle puts the width back to the default (FR-17).
    const resetChatWidth = useCallback(() => {
        setChatWidth(resetChatPanelWidth(window.innerWidth));
        setIsChatExpanded(false);
    }, [setChatWidth]);

    // With the handle focused: ←/→ resize by 16 px, Home resets (spec §6.12).
    const handleResizeKey = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            const next = chatPanelWidthForKey(e.key, chatWidth, window.innerWidth);
            if (next === null) return;
            e.preventDefault();
            setChatWidth(next);
            setIsChatExpanded(false);
        },
        [chatWidth, setChatWidth],
    );

    return (
        <BackgroundActivityProvider>
            <ChatProvider>
                <CommandPaletteProvider>
                    <DashboardKeyboardShortcuts onOpenHelp={openHelpFromShortcut} />
                    <PostHogIdentify userId={user.id} email={user.email} name={user.username} />
                    <EverWorksOnboardingWizard
                        open={isOnboardingOpen}
                        initialState={onboardingState}
                        catalog={initialOnboardingCatalog}
                        plugins={onboardingPlugins}
                        initialConnections={initialOnboardingConnections}
                        initialDeviceAuthStatuses={initialOnboardingDeviceAuthStatuses}
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
                            onOpenHelp={openHelpFromSidebar}
                            onOpenHelpTab={openHelpTabFromSidebar}
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
                                        onDoubleClick={resetChatWidth}
                                        onKeyDown={handleResizeKey}
                                        tabIndex={0}
                                        role="separator"
                                        aria-orientation="vertical"
                                        aria-label={tChat('resizeChat')}
                                        aria-describedby="chat-panel-resize-hint"
                                        aria-valuenow={chatWidth}
                                        aria-valuemin={CHAT_PANEL_MIN_WIDTH}
                                        data-testid="chat-panel-resize-handle"
                                        className="w-2.5 h-5 -ml-1 my-1.5 flex text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-white items-center justify-center cursor-col-resize bg-white dark:bg-surface-dark rounded focus-visible:outline-2 focus-visible:outline-primary"
                                        title={tChat('resizeChat')}
                                    >
                                        <GripVertical className="w-full h-4 text-text-muted/70" />
                                        <span id="chat-panel-resize-hint" className="sr-only">
                                            {tChat('panel.resizeHint')}
                                        </span>
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
                                onHelpClick={openHelpFromHeader}
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
                                whatsNew={{
                                    unreadCount: whatsNewUnread,
                                    onOpen: openWhatsNew,
                                    isOpen: whatsNewOpen,
                                }}
                            />

                            <main
                                className="relative flex-1 flex flex-col overflow-y-auto bg-white dark:bg-surface-dark min-h-0"
                                id="main-content"
                            >
                                {/* Help links (AW-25) anywhere in the page open the
                                Help drawer in place through the same state as `?`. */}
                                <HelpCenterProvider onOpenTarget={openHelpArticle}>
                                    <JobRuntimeDegradedBanner configured={jobRuntimeConfigured} />
                                    <div className="flex-1 mx-auto w-full px-4 @sm/main:px-6 @3xl/main:px-8 py-6 @3xl/main:py-8 max-w-full @5xl/main:max-w-7xl">
                                        <ChatPanelProvider open={chatOpen} setOpen={setChatOpen}>
                                            {children}
                                        </ChatPanelProvider>
                                    </div>
                                </HelpCenterProvider>

                                <Footer apiVersion={apiVersion} />

                                {/* Must stay the last child of <main>: its layout
                                effect has to run after the App Router's own
                                per-segment scroll handler in the same commit. */}
                                <ScrollTopOnNavigate />
                            </main>
                        </div>
                    </div>

                    <HelpDrawer
                        open={helpOpen}
                        onClose={closeHelp}
                        initialTab={helpTab}
                        initialTarget={helpTarget}
                        onboarding={{
                            currentStep: onboardingCurrentStep,
                            totalSteps: onboardingTotalSteps,
                            onOpen: openOnboarding,
                        }}
                    />
                    <WhatsNewPanel
                        open={whatsNewOpen}
                        onClose={closeWhatsNew}
                        unreadCount={whatsNewUnread}
                        onUnreadCountChange={setWhatsNewUnread}
                    />

                    <CommandPalette
                        userId={user.id}
                        onOpenHelp={openHelpFromPalette}
                        sidebarCollapsed={sidebarCollapsed}
                        onSidebarCollapsedChange={handleSidebarCollapsedChange}
                        chatOpen={chatOpen}
                        onChatOpenChange={setChatOpen}
                    />
                </CommandPaletteProvider>
            </ChatProvider>
        </BackgroundActivityProvider>
    );
}
