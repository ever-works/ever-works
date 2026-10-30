/**
 * APW-08 T12 / T48 (FR-12, FR-70, ACC-08-34) — the LEASE half of isolated-run admission: may
 * THIS node take this App Work job?
 *
 * Dispatch-time admission (`TaskTransitionService.dispatchAgentRun`, and again in the fleet-aware
 * dispatcher for every enqueue — drained, promoted and resumed runs included) judges the nodes
 * that COULD take a run. The job is then leased by whichever eligible node polls first, so the
 * node that actually takes it is judged here, at the claim: its own latest reported containment
 * and the owner's allowance for it on that App Work. A node that is not admissible is simply not
 * offered the job — it stays queued for an admissible node (or until the queue SLA expires it) —
 * so a machine enrolled after dispatch, or a downgraded node unpaused after dispatch, never runs
 * an App Work change the owner did not allow.
 *
 * Asked ONLY for an `agent-task` job whose platform-written payload carries `appWorkId`; every
 * other job leases exactly as before, with no query. Unbound while such a job is offered, the
 * lease fails CLOSED (the job is not offered) — the marker is only ever written by an API that
 * binds this port.
 *
 * 🛑 A leaf (a Symbol and an interface): `FleetJobService` reads the token in a parameter
 * decorator.
 */
export const FLEET_APP_WORK_LEASE_ADMISSION = Symbol('FLEET_APP_WORK_LEASE_ADMISSION');

export interface FleetAppWorkLeaseAdmission {
    /** True when `nodeId` may lease this App Work job; false (never throws) otherwise. */
    admitsLease(input: {
        userId: string;
        nodeId: string;
        workId: string;
        jobId: string;
    }): Promise<boolean>;
}
