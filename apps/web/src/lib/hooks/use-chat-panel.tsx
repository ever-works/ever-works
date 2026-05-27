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
