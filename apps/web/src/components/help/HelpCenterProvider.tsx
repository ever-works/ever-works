'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

export interface HelpCenterContextValue {
    /**
     * Open the Help drawer on its Manual tab at an article, optionally at a
     * heading (`<article>` or `<article>#<heading>`), over the current screen —
     * no navigation (spec FR-21). Calling it while Help is already open changes
     * nothing (spec FR-15).
     */
    openHelpAt: (target: string) => void;
}

const HelpCenterContext = createContext<HelpCenterContextValue | null>(null);

/**
 * Makes the manual reachable from anywhere under the dashboard shell (AW-25).
 *
 * Deliberately owns no state: the shell (`layout-client.tsx`) already owns the
 * Help drawer's open state and the tab it opens on — the same plumbing the
 * command palette's "Open Help" and "Keyboard shortcuts" commands use — and
 * passes `onOpenTarget` down so a help link travels the exact same path.
 */
export function HelpCenterProvider({
    onOpenTarget,
    children,
}: {
    onOpenTarget: (target: string) => void;
    children: ReactNode;
}) {
    const value = useMemo<HelpCenterContextValue>(
        () => ({ openHelpAt: onOpenTarget }),
        [onOpenTarget],
    );
    return <HelpCenterContext.Provider value={value}>{children}</HelpCenterContext.Provider>;
}

/** The manual's entry points, or `null` outside the dashboard shell. */
export function useHelpCenter(): HelpCenterContextValue | null {
    return useContext(HelpCenterContext);
}
