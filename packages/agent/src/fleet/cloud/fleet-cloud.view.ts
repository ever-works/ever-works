import {
    FLEET_CLOUD_DEFAULT_IDLE_POLICY,
    FLEET_CLOUD_MAX_POWER_TIMELINE,
    fleetCloudCost,
    fleetCloudRemovable,
    isFleetCloudPending,
    isFleetCloudPhase,
    isFleetCloudPowerState,
    isFleetCloudSoftwareId,
    normalizeFleetCloudIdlePolicy,
    type FleetCloudIdlePolicy,
    type FleetCloudMeta,
    type FleetCloudPhase,
    type FleetCloudPowerEvent,
    type FleetNodeCloudView,
} from '@ever-works/contracts';
import type { FleetNode } from '../../entities/fleet-node.entity';

/**
 * Cloud computers (FL-17) — the stored `providerMeta` made safe to read, and
 * the Cloud block every view carries. Pure: no I/O, the clock passed in.
 *
 * The stored row is never trusted blindly (it is JSON in a text column that
 * an older or newer build may have written): every field is checked and
 * bounded, unknown values fall back to their safe reading.
 */

const text = (value: unknown, max: number, fallback = ''): string =>
    typeof value === 'string' ? value.slice(0, max) : fallback;
const num = (value: unknown, fallback = 0): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const iso = (value: unknown): string | null =>
    typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

/** The stored meta, validated; null when the row carries none (not a cloud computer). */
export function normalizeCloudMeta(value: unknown): FleetCloudMeta | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    const createdAt = iso(raw.createdAt) ?? new Date(0).toISOString();
    const timeline: FleetCloudPowerEvent[] = Array.isArray(raw.powerTimeline)
        ? (raw.powerTimeline as unknown[])
              .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}))
              .filter(
                  (entry) =>
                      (entry.state === 'running' || entry.state === 'off' || entry.state === 'gone') &&
                      iso(entry.at) !== null,
              )
              .map((entry) => ({ state: entry.state as FleetCloudPowerEvent['state'], at: entry.at as string }))
              .slice(-FLEET_CLOUD_MAX_POWER_TIMELINE)
        : [];
    return {
        providerName: text(raw.providerName, 80, 'the provider'),
        regionId: text(raw.regionId, 64),
        regionLabel: text(raw.regionLabel, 120, text(raw.regionId, 64)),
        sizeId: text(raw.sizeId, 64),
        sizeLabel: text(raw.sizeLabel, 120, text(raw.sizeId, 64)),
        vcpus: num(raw.vcpus),
        memoryMiB: num(raw.memoryMiB),
        diskGiB: num(raw.diskGiB),
        hourlyRateCents: Math.max(0, num(raw.hourlyRateCents)),
        monthlyPriceCents: Math.max(0, num(raw.monthlyPriceCents)),
        currency: text(raw.currency, 8, 'USD') || 'USD',
        billsWhileOff: raw.billsWhileOff !== false,
        imageLabel: typeof raw.imageLabel === 'string' ? raw.imageLabel.slice(0, 120) : null,
        createdAt,
        machineCreatedAt: iso(raw.machineCreatedAt),
        phase: isFleetCloudPhase(raw.phase) ? raw.phase : 'asking-provider',
        phaseAt: iso(raw.phaseAt) ?? createdAt,
        powerState: isFleetCloudPowerState(raw.powerState) ? raw.powerState : 'unknown',
        powerStateAt: iso(raw.powerStateAt) ?? createdAt,
        pending: isFleetCloudPending(raw.pending) ? raw.pending : null,
        powerTimeline: timeline,
        error: typeof raw.error === 'string' && raw.error.trim() ? raw.error.trim().split(/\r?\n/)[0].slice(0, 300) : null,
        idlePolicy: raw.idlePolicy ? normalizeFleetCloudIdlePolicy(raw.idlePolicy) : { ...FLEET_CLOUD_DEFAULT_IDLE_POLICY },
        idleSince: iso(raw.idleSince),
        cost: raw.cost && typeof raw.cost === 'object' ? (raw.cost as FleetCloudMeta['cost']) : null,
        destroyedAt: iso(raw.destroyedAt),
        finalCostCents: typeof raw.finalCostCents === 'number' ? raw.finalCostCents : null,
        goneAt: iso(raw.goneAt),
        software: Array.isArray(raw.software) ? (raw.software as unknown[]).filter(isFleetCloudSoftwareId) : [],
        tags: Array.isArray(raw.tags)
            ? (raw.tags as unknown[]).filter((tag): tag is string => typeof tag === 'string').slice(0, 20)
            : [],
        ipv4: typeof raw.ipv4 === 'string' && /^[0-9.]{7,15}$/.test(raw.ipv4) ? raw.ipv4 : null,
        unenrolledNoticeAt: iso(raw.unenrolledNoticeAt),
        idleNotifiedKey: typeof raw.idleNotifiedKey === 'string' ? raw.idleNotifiedKey.slice(0, 200) : null,
        poweredOffByPolicyAt: iso(raw.poweredOffByPolicyAt),
    };
}

/**
 * The create phase as a person should read it: once the machine heartbeated
 * (the row left `enrolling`), it is `online` whatever the stored phase said —
 * the heartbeat is what turns the row online (spec §1), and nothing has to
 * write the phase for it.
 */
export function deriveCloudPhase(node: Pick<FleetNode, 'status'>, meta: FleetCloudMeta): FleetCloudPhase {
    if (meta.phase === 'failed') return 'failed';
    if (node.status !== 'enrolling') return 'online';
    return meta.phase === 'online' ? 'enrolling' : meta.phase;
}

/** Whether a machine exists (or existed) at the provider for this row. */
export function cloudHasMachine(node: Pick<FleetNode, 'providerMachineRef'>): boolean {
    return typeof node.providerMachineRef === 'string' && node.providerMachineRef.length > 0;
}

/**
 * CONTRACTS R-36 for a row: a cloud computer's registration may be removed
 * only when its machine is gone at the provider, or the create failed before a
 * machine existed. A row that names a provider but carries no meta is judged
 * by whether a machine ref exists.
 */
export function fleetCloudRemovableNode(
    node: Pick<FleetNode, 'providerMachineRef' | 'providerMeta' | 'status'>,
): boolean {
    const meta = normalizeCloudMeta(node.providerMeta);
    const hasMachine = cloudHasMachine(node);
    if (!meta) return !hasMachine;
    return fleetCloudRemovable({ hasMachine, meta: { powerState: meta.powerState, phase: deriveCloudPhase(node, meta) } });
}

/** The Cloud block (spec FR-15), or null for a Node that is not a cloud computer. */
export function fleetCloudViewOf(
    node: Pick<FleetNode, 'origin' | 'status' | 'providerPluginId' | 'providerMachineRef' | 'providerMeta'>,
    nowMs: number = Date.now(),
): FleetNodeCloudView | null {
    if (node.origin !== 'cloud' && !node.providerPluginId) return null;
    const meta = normalizeCloudMeta(node.providerMeta);
    if (!meta) return null;
    const cost = fleetCloudCost(meta, nowMs);
    const phase = deriveCloudPhase(node, meta);
    const hasMachine = cloudHasMachine(node);
    return {
        providerPluginId: node.providerPluginId ?? '',
        providerName: meta.providerName,
        regionId: meta.regionId,
        regionLabel: meta.regionLabel,
        sizeId: meta.sizeId,
        sizeLabel: meta.sizeLabel,
        vcpus: meta.vcpus,
        memoryMiB: meta.memoryMiB,
        diskGiB: meta.diskGiB,
        hourlyRateCents: meta.hourlyRateCents,
        monthlyPriceCents: meta.monthlyPriceCents,
        currency: meta.currency,
        billsWhileOff: meta.billsWhileOff,
        imageLabel: meta.imageLabel ?? null,
        createdAt: meta.createdAt,
        machineCreatedAt: meta.machineCreatedAt,
        phase,
        phaseAt: meta.phaseAt,
        powerState: meta.powerState,
        powerStateAt: meta.powerStateAt,
        pending: meta.pending,
        error: meta.error,
        ipv4: meta.ipv4 ?? null,
        software: meta.software,
        idlePolicy: meta.idlePolicy,
        idleSince: meta.idleSince ?? null,
        cost: {
            ...cost,
            providerMonthToDateCents: meta.cost?.providerMonthToDateCents ?? null,
            computedAt: new Date(nowMs).toISOString(),
        },
        goneAt: meta.goneAt ?? null,
        idleWindowReached: idleWindowReached(meta, nowMs),
        poweredOffByPolicyAt: meta.poweredOffByPolicyAt ?? null,
        hasMachine,
        removable: fleetCloudRemovable({ hasMachine, meta: { powerState: meta.powerState, phase } }),
    };
}

/** P2 (spec S6): the idle window has lasted the policy's hours, and the policy is not `nothing`. */
export function idleWindowReached(meta: FleetCloudMeta, nowMs: number): boolean {
    if (meta.idlePolicy.mode === 'nothing' || !meta.idleSince || meta.powerState !== 'running') return false;
    const since = Date.parse(meta.idleSince);
    return Number.isFinite(since) && nowMs - since >= meta.idlePolicy.afterHours * 60 * 60 * 1000;
}

/** "Tell me after 3 h" — a policy in the words the dialog and the Decision text use (spec §5.6). */
export function fleetCloudIdlePolicyLabel(policy: FleetCloudIdlePolicy): string {
    if (policy.mode === 'nothing') return 'Nothing';
    return `${policy.mode === 'power-off' ? 'Power off' : 'Tell me'} after ${policy.afterHours} h`;
}

/** Append one power transition, keeping the newest {@link FLEET_CLOUD_MAX_POWER_TIMELINE}. */
export function appendPowerEvent(
    timeline: readonly FleetCloudPowerEvent[],
    state: FleetCloudPowerEvent['state'],
    at: string,
): FleetCloudPowerEvent[] {
    const last = timeline[timeline.length - 1];
    if (last && last.state === state) return [...timeline];
    return [...timeline, { state, at }].slice(-FLEET_CLOUD_MAX_POWER_TIMELINE);
}
