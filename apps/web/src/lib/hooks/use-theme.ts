'use client';

import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

interface UseThemeReturn {
    theme: Theme;
    isDark: boolean;
    toggleTheme: (newTheme?: Theme) => void;
    mounted: boolean;
}

const THEME_STORAGE_KEY = 'theme';

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
    const [theme, setTheme] = useState<Theme>('light');
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        const storedTheme = localStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const initialTheme = storedTheme || (prefersDark ? 'dark' : 'light');
        
        setTheme(initialTheme);
        applyTheme(initialTheme);
    }, []);

    const toggleTheme = (newTheme?: Theme) => {
        const targetTheme: Theme = newTheme || (theme === 'dark' ? 'light' : 'dark');
        setTheme(targetTheme);
        localStorage.setItem(THEME_STORAGE_KEY, targetTheme);
        applyTheme(targetTheme);
    };

    return {
        theme,
        isDark: theme === 'dark',
        toggleTheme,
        mounted,
    };
}

