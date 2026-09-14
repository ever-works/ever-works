'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * Lightweight context exposing the dashboard chat panel's open/close
 * controls so pages can collapse the panel programmatically (e.g.
 * the `/new` page wants the prompt to take the full main column on
 * first land). The provider is mounted by the dashboard layout
 * client; consumers outside the dashboard layout get `null` and can
 * skip the call.
 */
export interface ChatPanelControls {
    open: boolean;
    setOpen: (value: boolean) => void;
}

const ChatPanelContext = createContext<ChatPanelControls | null>(null);

export function ChatPanelProvider({
    open,
    setOpen,
    children,
}: ChatPanelControls & { children: ReactNode }) {
    const value = useMemo(() => ({ open, setOpen }), [open, setOpen]);
    return <ChatPanelContext.Provider value={value}>{children}</ChatPanelContext.Provider>;
}

export function useChatPanel(): ChatPanelControls | null {
    return useContext(ChatPanelContext);
}

// ── Resize affordances for the docked panel's drag handle ─────────────────
//
// Pure helpers, so the layout's handle and its spec agree on the numbers. The
// pointer-drag clamp in `layout-client.tsx` is left exactly as it is; these
// only serve the double-click reset and the keyboard (FR-16, FR-17, §6.12).

/** Narrowest the panel may be made. */
export const CHAT_PANEL_MIN_WIDTH = 350;
/** The width a double-click or `Home` restores (FR-17). */
export const CHAT_PANEL_RESET_WIDTH = 420;
/** How far one `←` / `→` press moves the edge. */
export const CHAT_PANEL_KEYBOARD_STEP = 16;
/** Widest the panel may be, as a share of the viewport (FR-16). */
export const CHAT_PANEL_MAX_VIEWPORT_SHARE = 0.5;

/** Bound a width to ≥ 350 px and ≤ half the viewport. */
export function clampChatPanelWidth(width: number, viewportWidth: number): number {
    const max = Math.floor(viewportWidth * CHAT_PANEL_MAX_VIEWPORT_SHARE);
    return Math.max(CHAT_PANEL_MIN_WIDTH, Math.min(max, Math.round(width)));
}

/** The width the reset gestures restore, bounded like every other width. */
export function resetChatPanelWidth(viewportWidth: number): number {
    return clampChatPanelWidth(CHAT_PANEL_RESET_WIDTH, viewportWidth);
}

/**
 * The width a key press on the focused handle asks for, or `null` for a key
 * the handle does not use. The handle sits on the panel's right edge, so `→`
 * widens and `←` narrows.
 */
export function chatPanelWidthForKey(
    key: string,
    width: number,
    viewportWidth: number,
): number | null {
    if (key === 'ArrowRight')
        return clampChatPanelWidth(width + CHAT_PANEL_KEYBOARD_STEP, viewportWidth);
    if (key === 'ArrowLeft')
        return clampChatPanelWidth(width - CHAT_PANEL_KEYBOARD_STEP, viewportWidth);
    if (key === 'Home') return resetChatPanelWidth(viewportWidth);
    return null;
}
