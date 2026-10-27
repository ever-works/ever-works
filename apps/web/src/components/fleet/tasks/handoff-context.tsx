'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * Tasks on computers (FL-15 P1, T-06) — whether the board's cards offer **Fix
 * with an agent on this computer**, decided ONCE on the server
 * (`FleetTaskHandoffGate`: both fleet flags on and the person has a
 * computer) and read by every card. Outside the provider the answer is
 * `false` — exactly today's board.
 */
const FleetTaskHandoffContext = createContext<boolean>(false);

export function FleetTaskHandoffProvider({
    enabled,
    children,
}: {
    enabled: boolean;
    children: ReactNode;
}) {
    return (
        <FleetTaskHandoffContext.Provider value={enabled}>
            {children}
        </FleetTaskHandoffContext.Provider>
    );
}

export function useFleetTaskHandoffEnabled(): boolean {
    return useContext(FleetTaskHandoffContext);
}
