'use client';

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';

/** How the palette was opened — kept for diagnostics and the empty-state focus. */
export type CommandPaletteOpenSource = 'shortcut' | 'slash' | 'trigger';

export interface CommandPaletteControls {
    open: boolean;
    source: CommandPaletteOpenSource | null;
    /**
     * Opening an already-open palette is a no-op: the query is kept. Opening
     * it closes any open screen-scoped palette first.
     */
    openPalette: (source: CommandPaletteOpenSource) => void;
    closePalette: () => void;
    /**
     * A screen-scoped palette registers its `close` while it is open, so
     * opening this palette hands over instead of stacking a second dialog.
     * Returns the unregister function.
     */
    registerScopedPalette: (close: () => void) => () => void;
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
    const scopedClosersRef = useRef(new Set<() => void>());

    const openPalette = useCallback(
        (next: CommandPaletteOpenSource) => {
            if (open) return;
            for (const closeScoped of [...scopedClosersRef.current]) closeScoped();
            setSource(next);
            setOpen(true);
        },
        [open],
    );
    const closePalette = useCallback(() => setOpen(false), []);
    const registerScopedPalette = useCallback((close: () => void) => {
        const closers = scopedClosersRef.current;
        closers.add(close);
        return () => {
            closers.delete(close);
        };
    }, []);

    const value = useMemo(
        () => ({ open, source, openPalette, closePalette, registerScopedPalette }),
        [open, source, openPalette, closePalette, registerScopedPalette],
    );
    return (
        <CommandPaletteContext.Provider value={value}>{children}</CommandPaletteContext.Provider>
    );
}

/** The palette controls, or `null` outside the dashboard shell. */
export function useCommandPalette(): CommandPaletteControls | null {
    return useContext(CommandPaletteContext);
}

/**
 * For a palette scoped to one screen (the Knowledge-Base workbench search):
 * keeps it and the dashboard palette from ever being open together. While
 * `open`, the dashboard palette is closed, and opening the dashboard palette —
 * from its trigger, `/` or anywhere else — calls `close` first. A no-op outside
 * the dashboard shell. Pass a stable `close`.
 */
export function useScopedPaletteHandover(open: boolean, close: () => void): void {
    const palette = useCommandPalette();
    const closeGlobal = palette?.closePalette;
    const register = palette?.registerScopedPalette;

    useEffect(() => {
        if (open) closeGlobal?.();
    }, [open, closeGlobal]);

    useEffect(() => {
        if (!open || !register) return undefined;
        return register(close);
    }, [open, register, close]);
}
