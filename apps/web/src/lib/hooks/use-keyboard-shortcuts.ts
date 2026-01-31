'use client';

import { useEffect, useCallback } from 'react';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

interface KeyboardShortcutsOptions {
    onOpenHelp?: () => void;
}

/**
 * Global keyboard shortcuts for the dashboard
 * - Ctrl/Cmd + K: Navigate to directories and focus search
 * - Ctrl/Cmd + N: Create new directory
 * - ?: Open help drawer (when not in an input field)
 */
export function useKeyboardShortcuts(options: KeyboardShortcutsOptions = {}) {
    const router = useRouter();
    const { onOpenHelp } = options;

    const handleKeyDown = useCallback(
        (event: KeyboardEvent) => {
            const target = event.target as HTMLElement;
            const tagName = target.tagName.toLowerCase();
            const isInputField =
                tagName === 'input' ||
                tagName === 'textarea' ||
                tagName === 'select' ||
                target.isContentEditable;

            // Check for modifier key (Ctrl on Windows/Linux, Cmd on Mac)
            const modifier = event.ctrlKey || event.metaKey;

            // Ctrl/Cmd + K: Focus search on directories page
            if (modifier && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                // Navigate to directories page with focus param
                router.push(`${ROUTES.DASHBOARD_DIRECTORIES}?focus=search`);
                return;
            }

            // Ctrl/Cmd + N: Create new directory
            if (modifier && event.key.toLowerCase() === 'n') {
                event.preventDefault();
                router.push(ROUTES.DASHBOARD_DIRECTORIES_NEW);
                return;
            }

            // ?: Open help (only when not in an input field)
            if (event.key === '?' && !isInputField && onOpenHelp) {
                event.preventDefault();
                onOpenHelp();
                return;
            }
        },
        [router, onOpenHelp],
    );

    useEffect(() => {
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [handleKeyDown]);
}
