'use client';

import { createContext, useContext, useState, useCallback, useMemo } from 'react';
import type { CanvasArtifact } from './types';

interface CanvasContextValue {
    artifacts: CanvasArtifact[];
    activeId: string | null;
    isOpen: boolean;
    /** Add (or re-focus) an artifact and open the panel. */
    open: (artifact: CanvasArtifact) => void;
    /** Focus an already-added artifact by id. */
    focus: (id: string) => void;
    close: () => void;
}

const CanvasContext = createContext<CanvasContextValue | null>(null);

export function CanvasProvider({ children }: { children: React.ReactNode }) {
    const [artifacts, setArtifacts] = useState<CanvasArtifact[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [isOpen, setIsOpen] = useState(false);

    const open = useCallback((artifact: CanvasArtifact) => {
        setArtifacts((prev) =>
            prev.some((a) => a.id === artifact.id)
                ? prev.map((a) => (a.id === artifact.id ? artifact : a))
                : [...prev, artifact],
        );
        setActiveId(artifact.id);
        setIsOpen(true);
    }, []);

    const focus = useCallback((id: string) => {
        setActiveId(id);
        setIsOpen(true);
    }, []);

    const close = useCallback(() => setIsOpen(false), []);

    const value = useMemo<CanvasContextValue>(
        () => ({ artifacts, activeId, isOpen, open, focus, close }),
        [artifacts, activeId, isOpen, open, focus, close],
    );

    return <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>;
}

export function useCanvas(): CanvasContextValue {
    const ctx = useContext(CanvasContext);
    if (!ctx) throw new Error('useCanvas must be used within a CanvasProvider');
    return ctx;
}

/** Non-throwing variant for components that may render outside the provider. */
export function useCanvasOptional(): CanvasContextValue | null {
    return useContext(CanvasContext);
}
