'use client';

import { useRouter } from '@/i18n/navigation';
import { ROUTES, WORKS_SEARCH_HREF } from '@/lib/constants';
import { isModKey, SHORTCUT_PRIORITY, SHORTCUT_SCOPE } from '@/lib/keyboard/shortcut-registry';
import { useShortcut } from './use-shortcut';

interface KeyboardShortcutsOptions {
    onOpenHelp?: () => void;
    /**
     * Open the dashboard command palette. When provided, `Ctrl/Cmd+K` and `/`
     * open it. When omitted, `Ctrl/Cmd+K` keeps its original behaviour — go to
     * the Works list with its search box focused — and `/` is not bound.
     */
    onOpenPalette?: (source: 'shortcut' | 'slash') => void;
}

// `WORKS_SEARCH_HREF` now lives in `@/lib/constants` — a module with NO
// `'use client'` directive — and is IMPORTED above. It moved because this module
// IS a client module and the command-palette registry needs the same string from
// the other side of the boundary, where a value imported from a client module
// arrives as a client REFERENCE, not the string (the C22/C27 defect class).
//
// The name this module used to DECLARE is re-exported below, unchanged and
// pointing at the one definition, so every existing consumer and spec keeps
// working.
export { WORKS_SEARCH_HREF };

/**
 * Global keyboard shortcuts for the dashboard, registered through the shared
 * shortcut registry at global scope (so a screen-scoped binding for the same
 * key — e.g. the Knowledge-Base workbench palette — wins on its own screen):
 * - Ctrl/Cmd + K: open the command palette (or, without one, go to Works search)
 * - /: open the command palette (only outside text fields, only with a palette)
 * - C: create new work (only outside text fields)
 * - ?: open help drawer (only outside text fields)
 */
export function useKeyboardShortcuts(options: KeyboardShortcutsOptions = {}) {
    const router = useRouter();
    const { onOpenHelp, onOpenPalette } = options;

    useShortcut(
        {
            id: 'dashboard.palette',
            scope: SHORTCUT_SCOPE.global,
            priority: SHORTCUT_PRIORITY.global,
            allowInInput: true,
        },
        (event) => isModKey(event, 'k'),
        () => {
            if (onOpenPalette) {
                onOpenPalette('shortcut');
                return;
            }
            router.push(WORKS_SEARCH_HREF);
        },
    );

    useShortcut(
        {
            id: 'dashboard.paletteSlash',
            scope: SHORTCUT_SCOPE.global,
            priority: SHORTCUT_PRIORITY.global,
            enabled: Boolean(onOpenPalette),
        },
        (event) => event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey,
        () => onOpenPalette?.('slash'),
    );

    useShortcut(
        {
            id: 'dashboard.newWork',
            scope: SHORTCUT_SCOPE.global,
            priority: SHORTCUT_PRIORITY.global,
        },
        (event) => event.key.toLowerCase() === 'c' && !event.ctrlKey && !event.metaKey,
        () => router.push(ROUTES.DASHBOARD_WORKS_NEW),
    );

    useShortcut(
        {
            id: 'dashboard.help',
            scope: SHORTCUT_SCOPE.global,
            priority: SHORTCUT_PRIORITY.global,
            enabled: Boolean(onOpenHelp),
        },
        (event) => event.key === '?',
        () => onOpenHelp?.(),
    );
}
