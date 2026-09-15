/**
 * Agent computers — the fleet heartbeat's hint port.
 *
 * An attended machine polls for live views on its own cadence; when a view
 * is already waiting for it, the fleet heartbeat response says so and the
 * machine polls at once instead of on its next tick. The fleet controller
 * reads that list through THIS token, injected `@Optional()`, so the fleet
 * surface never depends on whether live views are installed: unbound, the
 * heartbeat response is exactly what it always was.
 */
export const COMPUTER_PENDING_SESSIONS = 'COMPUTER_PENDING_SESSIONS' as const;

export interface ComputerPendingSessionsLookup {
    /** Ids of the live views waiting for `nodeId` to claim them (bounded). */
    pendingForNode(nodeId: string): Promise<string[]>;
}
