/**
 * Wire shapes for the Fleet ADMIN endpoints — the reads and controls
 * that were missing from the original thin surface (node detail with
 * failure history, credential rotation, drain).
 *
 * They are DECLARED in `@ever-works/contracts` and re-exported here.
 * The web tier renders these same shapes, and this file previously
 * declared its own copy — which is the drift that turned `FleetNodeView`
 * into three hand-written mirrors before it was consolidated. One
 * declaration, two importers.
 */
export type {
    FleetNodeDetailView,
    FleetNodeDrainResult,
    FleetEnrollmentTokenView,
    // Panic controls (EW-778).
    FleetAuditView,
    FleetCancelInFlightResult,
    FleetDrainAllResult,
    FleetKillSwitchAdminState,
    FleetKillSwitchChangeResult,
    FleetKillSwitchState,
} from '@ever-works/contracts';
