/**
 * AW-20 P1 — the payload one roster provisioning run carries into the
 * job runtime.
 *
 * Self-contained on purpose: the worker resolves nothing from a request
 * context, so the workspace scope the run was requested in travels with
 * it. Without `tenantId` and `organizationId` here, agents provisioned in
 * the background would be created unstamped and become invisible to the
 * very scope that asked for them.
 */
export interface RosterProvisionLanePayload {
    readonly laneKey: string;
    readonly name: string;
}

export interface RosterProvisionPayload {
    readonly userId: string;
    readonly tenantId: string | null;
    readonly organizationId: string | null;
    /** Minted at request time; also the job's idempotency key. */
    readonly runId: string;
    readonly blueprintSlug: string;
    readonly lanes: readonly RosterProvisionLanePayload[];
}
