'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { usePathname } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

interface BackgroundActivityState {
    /** Show the sidebar indicator? */
    showWorkIndicator: boolean;
    /** Call when a generation starts (or is detected) */
    markGenerating: () => void;
    /** Call when generation finishes */
    clearGenerating: () => void;
}

const BackgroundActivityContext = createContext<BackgroundActivityState | null>(null);

export function BackgroundActivityProvider({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const [isGeneratingWork, setIsGeneratingWork] = useState(false);
    const isOnWorksPage =
        pathname === ROUTES.DASHBOARD_WORKS || pathname?.startsWith(ROUTES.DASHBOARD_WORKS + '/');

    const markGenerating = useCallback(() => {
        setIsGeneratingWork(true);
    }, []);

    const clearGenerating = useCallback(() => {
        setIsGeneratingWork(false);
    }, []);

    const showWorkIndicator = isGeneratingWork && !isOnWorksPage;

    const value = useMemo(
        () => ({
            showWorkIndicator,
            markGenerating,
            clearGenerating,
        }),
        [showWorkIndicator, markGenerating, clearGenerating],
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
