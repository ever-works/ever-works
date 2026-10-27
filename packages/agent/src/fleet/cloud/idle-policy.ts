import {
    FLEET_CLOUD_IDLE_CPU_PERCENT,
    fleetCloudIdleAttentionKey,
    type FleetCloudMeta,
    type FleetNodeStatus,
} from '@ever-works/contracts';

/**
 * Cloud computers (FL-17 P2, spec FR-25 – FR-28) — the idle truth table, pure.
 *
 * A machine is idle when, for the whole window, no Session is `working` /
 * `needs_you` (or starting), no job is leased or running, and the CPU was
 * under 5 % in every health sample. A machine that is powered off, being
 * created (`enrolling`), mid power act or gone is NEVER idle (FR-26, U11).
 *
 * The window is kept on the row (`providerMeta.idleSince`): the first
 * evaluation that finds the machine idle opens it at that instant; any
 * evaluation that finds it busy closes it. When it has lasted the policy's
 * hours, the policy acts ONCE for that window — the window's attention key is
 * remembered (`idleNotifiedKey`) — so a 10-minute cadence raises one item, one
 * Inbox notice and at most one power-off per window (FR-27). Nothing here ever
 * destroys anything (FR-28): the only acts are `tell-me` and `power-off`.
 */

export interface CloudIdleEvidence {
    nodeId: string;
    status: FleetNodeStatus;
    meta: FleetCloudMeta;
    /** Sessions on the machine in `starting` / `working` / `needs_you`. */
    busySessions: number;
    /** Jobs leased or running on the machine. */
    activeJobs: number;
    /** CPU percentages of the health samples since the window opened (or since the last evaluation). */
    cpuSamples: ReadonlyArray<number | null>;
    nowMs: number;
}

export interface CloudIdleDecision {
    /** The window start to store (null = not idle, the window is closed). */
    idleSince: string | null;
    /** The window has lasted the policy's hours. */
    windowReached: boolean;
    /** What the policy does now — at most once per window. */
    act: 'none' | 'tell-me' | 'power-off';
    /** The window's attention key (when idle), for the item and the dedup. */
    attentionKey: string | null;
}

const HOUR_MS = 60 * 60 * 1000;

/** Whether this evaluation's evidence is idle (FR-26). */
export function isIdleNow(evidence: Omit<CloudIdleEvidence, 'nowMs' | 'nodeId'>): boolean {
    const { meta } = evidence;
    if (evidence.status === 'enrolling') return false;
    if (meta.powerState !== 'running' || meta.pending !== null || meta.phase === 'failed')
        return false;
    if (evidence.busySessions > 0 || evidence.activeJobs > 0) return false;
    // Every sample flat. A sample with no CPU figure is no evidence either way.
    return evidence.cpuSamples.every((cpu) => cpu === null || cpu < FLEET_CLOUD_IDLE_CPU_PERCENT);
}

export function evaluateCloudIdle(evidence: CloudIdleEvidence): CloudIdleDecision {
    if (!isIdleNow(evidence)) {
        return { idleSince: null, windowReached: false, act: 'none', attentionKey: null };
    }
    const { meta, nowMs } = evidence;
    const opened = meta.idleSince ? Date.parse(meta.idleSince) : NaN;
    const idleSince =
        Number.isFinite(opened) && opened <= nowMs
            ? meta.idleSince!
            : new Date(nowMs).toISOString();
    const windowReached = nowMs - Date.parse(idleSince) >= meta.idlePolicy.afterHours * HOUR_MS;
    const attentionKey = fleetCloudIdleAttentionKey(evidence.nodeId, idleSince);
    let act: CloudIdleDecision['act'] = 'none';
    if (
        windowReached &&
        meta.idlePolicy.mode !== 'nothing' &&
        meta.idleNotifiedKey !== attentionKey
    ) {
        act = meta.idlePolicy.mode === 'power-off' ? 'power-off' : 'tell-me';
    }
    return { idleSince, windowReached, act, attentionKey };
}
