'use client';

import { useEffect, useState } from 'react';

/** True on macOS / iOS, where the modifier is shown as `⌘` rather than `Ctrl`. */
export function detectMacPlatform(): boolean {
    try {
        const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
        const platform = nav.userAgentData?.platform ?? nav.platform ?? '';
        return /mac|iphone|ipad|ipod/i.test(platform);
    } catch {
        return false;
    }
}

/**
 * Platform-aware shortcut hints. Resolved after mount, so the server render
 * and the first client render agree and hydration never mismatches.
 */
export function useIsMac(): boolean {
    const [isMac, setIsMac] = useState(false);
    useEffect(() => {
        setIsMac(detectMacPlatform());
    }, []);
    return isMac;
}
