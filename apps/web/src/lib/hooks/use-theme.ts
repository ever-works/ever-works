'use client';

import { useEffect, useState } from 'react';
import { useMounted } from './use-mounted';

export type Theme = 'light' | 'dark';

interface UseThemeReturn {
    theme: Theme;
    isDark: boolean;
    toggleTheme: (newTheme?: Theme) => void;
    mounted: boolean;
}

const THEME_STORAGE_KEY = 'theme';

/**
 * Same-tab broadcast of a theme change. The `storage` event only reaches
 * other tabs, so without this a second `useTheme()` in the same tab (the
 * header toggle and the command palette's "Toggle dark mode") would keep a
 * stale theme after the other one switched it.
 */
export const THEME_CHANGE_EVENT = 'ever-works:theme-change';

/**
 * Applies theme to the document root
 */
function applyTheme(newTheme: Theme): void {
    const root = document.documentElement;
    if (newTheme === 'dark') {
        root.classList.add('dark');
    } else {
        root.classList.remove('dark');
    }
}

/**
 * Custom hook for managing theme state
 * Handles dark/light mode switching with localStorage persistence
 * Respects system preference if no stored theme is found
 */
export function useTheme(): UseThemeReturn {
    const mounted = useMounted();
    const [theme, setTheme] = useState<Theme>(() => {
        if (typeof window === 'undefined') {
            return 'light';
        }

        // Brave, Safari ITP, locked-down enterprise profiles, and
        // private-browsing modes all make `localStorage.getItem` throw.
        // Letting that throw inside `useState`'s lazy initialiser
        // aborts React's render and leaves the page blank — that's
        // the exact regression feature-detect-storage.spec is built
        // to catch. Wrap every browser-API access in try/catch and
        // fall back to a sensible default.
        let storedTheme: Theme | null = null;
        try {
            storedTheme = localStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
        } catch {
            storedTheme = null;
        }
        let prefersDark = false;
        try {
            prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        } catch {
            prefersDark = false;
        }
        return storedTheme || (prefersDark ? 'dark' : 'light');
    });

    useEffect(() => {
        applyTheme(theme);
    }, [theme]);

    useEffect(() => {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const handleSystemThemeChange = (event: MediaQueryListEvent) => {
            let storedTheme: Theme | null = null;
            try {
                storedTheme = localStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
            } catch {
                storedTheme = null;
            }
            if (!storedTheme) {
                setTheme(event.matches ? 'dark' : 'light');
            }
        };

        const handleStorageChange = (event: StorageEvent) => {
            if (event.key !== THEME_STORAGE_KEY || event.newValue == null) return;
            if (event.newValue === 'light' || event.newValue === 'dark') {
                setTheme(event.newValue);
            }
        };

        const handleSameTabChange = (event: Event) => {
            const next = (event as CustomEvent<unknown>).detail;
            if (next === 'light' || next === 'dark') {
                setTheme(next);
            }
        };

        mediaQuery.addEventListener('change', handleSystemThemeChange);
        window.addEventListener('storage', handleStorageChange);
        window.addEventListener(THEME_CHANGE_EVENT, handleSameTabChange);

        return () => {
            mediaQuery.removeEventListener('change', handleSystemThemeChange);
            window.removeEventListener('storage', handleStorageChange);
            window.removeEventListener(THEME_CHANGE_EVENT, handleSameTabChange);
        };
    }, []);

    const toggleTheme = (newTheme?: Theme) => {
        const targetTheme: Theme = newTheme || (theme === 'dark' ? 'light' : 'dark');
        setTheme(targetTheme);
        try {
            localStorage.setItem(THEME_STORAGE_KEY, targetTheme);
        } catch {
            // localStorage may be disabled — DOM still gets the update.
        }
        applyTheme(targetTheme);
        try {
            window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: targetTheme }));
        } catch {
            // CustomEvent unavailable — this instance is still correct.
        }
    };

    return {
        theme,
        isDark: theme === 'dark',
        toggleTheme,
        mounted,
    };
}
