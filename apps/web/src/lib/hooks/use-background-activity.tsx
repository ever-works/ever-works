'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { usePathname } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

interface BackgroundActivityState {
    /** Show the sidebar indicator? */
    showDirectoryIndicator: boolean;
    /** Call when a generation starts (or is detected) */
    markGenerating: () => void;
    /** Call when generation finishes */
    clearGenerating: () => void;
}

const BackgroundActivityContext = createContext<BackgroundActivityState | null>(null);

export function BackgroundActivityProvider({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const [isGeneratingDirectory, setIsGeneratingDirectory] = useState(false);
    const isOnDirectoriesPage =
        pathname === ROUTES.DASHBOARD_DIRECTORIES ||
        pathname?.startsWith(ROUTES.DASHBOARD_DIRECTORIES + '/');

    const markGenerating = useCallback(() => {
        setIsGeneratingDirectory(true);
    }, []);

    const clearGenerating = useCallback(() => {
        setIsGeneratingDirectory(false);
    }, []);

    const showDirectoryIndicator = isGeneratingDirectory && !isOnDirectoriesPage;

    const value = useMemo(
        () => ({
            showDirectoryIndicator,
            markGenerating,
            clearGenerating,
        }),
        [showDirectoryIndicator, markGenerating, clearGenerating],
    );

    return (
        <BackgroundActivityContext.Provider value={value}>
            {children}
        </BackgroundActivityContext.Provider>
    );
}

export function useBackgroundActivity() {
    const ctx = useContext(BackgroundActivityContext);
    if (!ctx) {
        throw new Error('useBackgroundActivity must be used within BackgroundActivityProvider');
    }
    return ctx;
}
