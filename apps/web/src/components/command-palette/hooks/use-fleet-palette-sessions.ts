'use client';

import { useEffect, useState } from 'react';
import type { FleetSessionBoardResponse } from '@ever-works/contracts';
import { sessionsClient } from '@/components/fleet/sessions/sessions.client';

/**
 * FL-05 P3 (spec FR-46, S12, §5.12) — the sessions the palette's empty query
 * opens with: read once each time the palette opens, only while the Fleet hub
 * is on. A deployment with sessions switched off answers 404 and the palette
 * simply shows no session rows.
 */
export function useFleetPaletteSessions(open: boolean, enabled: boolean): FleetSessionBoardResponse | null {
    const [board, setBoard] = useState<FleetSessionBoardResponse | null>(null);
    useEffect(() => {
        if (!open || !enabled) return undefined;
        let cancelled = false;
        void sessionsClient.board().then((result) => {
            if (!cancelled) setBoard(result.ok ? result.data : null);
        });
        return () => {
            cancelled = true;
        };
    }, [open, enabled]);
    return enabled ? board : null;
}
