'use client';

import { useCallback } from 'react';
import { useLocalStorage } from './use-local-storage';

const SIDEBAR_WIDTH_KEY = 'sidebar-width';
const SIDEBAR_COLLAPSED_KEY = 'sidebar-collapsed';

const SIDEBAR_WIDTH_DEFAULT = 320;
const SIDEBAR_WIDTH_MIN = 220;
const SIDEBAR_WIDTH_MAX = 520;

interface UseSidebarPersistenceReturn {
    sidebarWidth: number;
    sidebarCollapsed: boolean;
    handleSidebarWidthChange: (width: number) => void;
    handleSidebarCollapsedChange: (collapsed: boolean) => void;
}

/**
 * Persists sidebar width and collapsed state in localStorage.
 * Encapsulates all SSR-safety and serialisation logic so callers
 * can treat the values as plain React state.
 */
export function useSidebarPersistence(): UseSidebarPersistenceReturn {
    const [sidebarWidth, setSidebarWidth] = useLocalStorage<number>(
        SIDEBAR_WIDTH_KEY,
        SIDEBAR_WIDTH_DEFAULT,
        {
            serialize: String,
            deserialize: (raw) => parseInt(raw, 10),
            validate: (v) => !isNaN(v) && v >= SIDEBAR_WIDTH_MIN && v <= SIDEBAR_WIDTH_MAX,
        },
    );

    const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage<boolean>(
        SIDEBAR_COLLAPSED_KEY,
        false,
        {
            serialize: (v) => (v ? '1' : '0'),
            deserialize: (raw) => raw === '1',
        },
    );

    const handleSidebarWidthChange = useCallback(
        (width: number) => setSidebarWidth(width),
        [setSidebarWidth],
    );

    const handleSidebarCollapsedChange = useCallback(
        (collapsed: boolean) => setSidebarCollapsed(collapsed),
        [setSidebarCollapsed],
    );

    return {
        sidebarWidth,
        sidebarCollapsed,
        handleSidebarWidthChange,
        handleSidebarCollapsedChange,
    };
}
