'use client';

import { useEffect, useState } from 'react';
import { listVisibleFleetNodesAction } from '@/app/actions/settings/fleet';

export interface PaletteFleetComputer {
    id: string;
    name: string;
}

/**
 * Fleet hub (FL-01, FR-33, T-27) — the computers the viewer may see, for the
 * palette's "Go to computer <name>" rows: read once each time the palette
 * opens while the hub is on (the viewer's own and those shared with them,
 * enrolled computers only). A failed read leaves the rows out — the palette
 * never waits on it and never shows a stale list as fresh.
 */
export function useFleetPaletteComputers(open: boolean, enabled: boolean): PaletteFleetComputer[] {
    const [computers, setComputers] = useState<PaletteFleetComputer[]>([]);

    useEffect(() => {
        if (!open || !enabled) return undefined;
        let cancelled = false;
        void listVisibleFleetNodesAction()
            .then((result) => {
                if (cancelled) return;
                setComputers(
                    result.success
                        ? result.data
                              .filter((node) => node.persisted && node.status !== 'enrolling')
                              .map((node) => ({ id: node.id, name: node.name }))
                        : [],
                );
            })
            .catch(() => {
                if (!cancelled) setComputers([]);
            });
        return () => {
            cancelled = true;
        };
    }, [open, enabled]);

    return enabled ? computers : [];
}
