'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/** How the palette was opened — kept for diagnostics and the empty-state focus. */
export type CommandPaletteOpenSource = 'shortcut' | 'slash' | 'trigger';

export interface CommandPaletteControls {
    open: boolean;
    source: CommandPaletteOpenSource | null;
    /** Opening an already-open palette is a no-op: the query is kept. */
    openPalette: (source: CommandPaletteOpenSource) => void;
    closePalette: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteControls | null>(null);

/**
 * Open/close state for the dashboard command palette, so the shortcut hook,
 * the header trigger and the palette itself share one source of truth. Mounted
 * once by the dashboard shell.
 */
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
    const [open, setOpen] = useState(false);
    const [source, setSource] = useState<CommandPaletteOpenSource | null>(null);

    const openPalette = useCallback(
        (next: CommandPaletteOpenSource) => {
            if (open) return;
            setSource(next);
            setOpen(true);
        },
        [open],
    );
    const closePalette = useCallback(() => setOpen(false), []);

    const value = useMemo(
        () => ({ open, source, openPalette, closePalette }),
        [open, source, openPalette, closePalette],
    );
    return (
        <CommandPaletteContext.Provider value={value}>{children}</CommandPaletteContext.Provider>
    );
}

/** The palette controls, or `null` outside the dashboard shell. */
export function useCommandPalette(): CommandPaletteControls | null {
    return useContext(CommandPaletteContext);
}
