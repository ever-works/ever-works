import {
    effectiveConsents,
    FLEET_VIRTUAL_HOST_CAPABILITY,
    FLEET_VIRTUAL_MAX_PER_HOST,
    FLEET_VIRTUAL_WINDOWS_MIN_FREE_DISK_GIB,
    FLEET_KVM_CAPABILITY,
    FLEET_VIRTUAL_WINDOWS_CAPABILITY,
    type FleetConsents,
    type FleetNodeHealthSnapshot,
    type FleetVirtualHostOption,
    type FleetVirtualHostReason,
    type FleetVirtualKind,
    type FleetVirtualMeta,
    type FleetVirtualSystem,
} from '@ever-works/contracts';

/**
 * Virtual computers (FL-16) — the pure rules: who may host what (spec FR-4,
 * FR-5, FR-6, FR-9, FR-10, U1–U6), "Choose for me" (S3), the memory a host
 * has left net of what its children reserve (S6, §5.4), and the words every
 * surface uses for a refusal. No IO: the service hands the facts in.
 */

/** The facts of a candidate host the rules read (a `FleetNode` satisfies it). */
export interface FleetVirtualHostFacts {
    id: string;
    name: string;
    kind: string;
    status: string;
    origin?: string | null;
    hostNodeId?: string | null;
    capabilities?: readonly string[] | null;
    lastHeartbeatAt?: Date | string | null;
    consents?: FleetConsents | null;
    workerState?: string | null;
    health?: Pick<FleetNodeHealthSnapshot, 'memTotalMiB' | 'memUsedMiB' | 'diskFreeMiB'> | null;
}

/** One existing child of a host, as the limit and the reservation read it. */
export interface FleetVirtualChildFacts {
    virtualMeta?: Pick<FleetVirtualMeta, 'memoryGiB' | 'state'> | null;
}

/** The value of a `prefix:` capability tag (`os:linux` → `linux`), or null. */
export function capabilityValue(
    capabilities: readonly string[] | null | undefined,
    prefix: 'os' | 'arch',
): string | null {
    for (const tag of capabilities ?? []) {
        if (tag.startsWith(`${prefix}:`)) return tag.slice(prefix.length + 1) || null;
    }
    return null;
}

/** True when the Node is itself a virtual computer (it can never host one, FR-10). */
export function isVirtualNode(node: Pick<FleetVirtualHostFacts, 'origin' | 'hostNodeId'>): boolean {
    return node.origin === 'virtual' || Boolean(node.hostNodeId);
}

/** True when the host is online now: status `online` and a beat inside the offline window. */
export function isHostOnline(
    node: Pick<FleetVirtualHostFacts, 'status' | 'lastHeartbeatAt'>,
    offlineCutoffMs: number,
): boolean {
    if (node.status !== 'online') return false;
    const at = node.lastHeartbeatAt ? new Date(node.lastHeartbeatAt).getTime() : NaN;
    return Number.isFinite(at) && at >= offlineCutoffMs;
}

export interface HostEligibilityInput {
    host: FleetVirtualHostFacts;
    system: Pick<FleetVirtualSystem, 'kind' | 'arch'>;
    /** Children it hosts now, every state (CONTRACTS §10). */
    childCount: number;
    /** Epoch ms: a beat older than this is offline. */
    offlineCutoffMs: number;
    /** Whether the caller is in the host's `machines` audience (S8). */
    allowed: boolean;
}

/**
 * Why `host` cannot host `system` for this caller, or null when it can. The
 * order puts what can never change first (is itself virtual, a desktop app,
 * Windows), then the caller's permission, then what the system needs of the
 * machine, then what is true only right now (offline, consent, Docker,
 * version, the limit) — so the reason a person reads is the one worth acting
 * on.
 */
export function hostEligibility(input: HostEligibilityInput): FleetVirtualHostReason | null {
    const { host, system } = input;
    const capabilities = host.capabilities ?? [];
    const os = capabilityValue(capabilities, 'os');
    const arch = capabilityValue(capabilities, 'arch');
    if (isVirtualNode(host)) return 'is-virtual';
    if (host.kind === 'desktop-node') return 'desktop-node';
    if (os === 'win32' || os === 'windows') return 'windows-host';
    if (!input.allowed) return 'permission-denied';
    if (system.kind === 'vm') {
        // Windows VMs need KVM on a Linux x86-64 host (FR-5, U3); macOS and arm64 never advertise it.
        if (os !== 'linux' || arch !== 'x64' || !capabilities.includes(FLEET_KVM_CAPABILITY))
            return 'no-kvm';
    } else if (arch && !(system.arch as readonly string[]).includes(arch)) {
        return 'unsupported-arch';
    }
    if (!isHostOnline(host, input.offlineCutoffMs)) return 'offline';
    const consents = effectiveConsents({
        consents: host.consents ?? null,
        capabilities: [...capabilities],
        workerState: host.workerState ?? null,
    });
    if (!consents.manage && !capabilities.includes('managed')) return 'consent-missing';
    if (!capabilities.includes('docker')) return 'no-docker';
    if (!capabilities.includes(FLEET_VIRTUAL_HOST_CAPABILITY)) return 'not-upgraded';
    // Windows VMs (P2, lane decision 14): only with an installer image the host's operator configured.
    if (system.kind === 'vm' && !capabilities.includes(FLEET_VIRTUAL_WINDOWS_CAPABILITY))
        return 'no-windows-image';
    if (input.childCount >= FLEET_VIRTUAL_MAX_PER_HOST) return 'limit';
    return null;
}

/** The CONTRACTS §8 code a reason is refused with on a direct request. */
export function hostReasonErrorCode(
    reason: FleetVirtualHostReason,
):
    | 'unreachable'
    | 'consent_missing'
    | 'permission_denied'
    | 'unsupported_on_node'
    | 'limit_exceeded' {
    switch (reason) {
        case 'offline':
            return 'unreachable';
        case 'consent-missing':
            return 'consent_missing';
        case 'permission-denied':
            return 'permission_denied';
        case 'limit':
            return 'limit_exceeded';
        default:
            return 'unsupported_on_node';
    }
}

/** The hint a refusal carries — the exact sentence of spec §5.8 / U1–U6. */
export function hostReasonHint(
    reason: FleetVirtualHostReason,
    host: Pick<FleetVirtualHostFacts, 'name'>,
    extra: { hostOfHost?: string | null; lastSeen?: string | null } = {},
): string {
    const name = host.name;
    switch (reason) {
        case 'offline':
            return extra.lastSeen
                ? `${name} is offline — last seen ${extra.lastSeen} ago`
                : `${name} is offline`;
        case 'consent-missing':
            return `Management is off — start the node with --manage on ${name}`;
        case 'no-docker':
            return `Docker was not found on ${name}`;
        case 'no-kvm':
            return `Windows VMs need /dev/kvm on a Linux x86-64 host; Containers may still be available on ${name}`;
        case 'windows-host':
            return `${name} cannot host virtual computers — a Windows computer cannot host them`;
        case 'is-virtual':
            return extra.hostOfHost
                ? `${name} is itself a virtual computer on ${extra.hostOfHost}; create on ${extra.hostOfHost} instead`
                : `${name} cannot host — it is itself a virtual computer`;
        case 'limit':
            return `${name} already hosts ${FLEET_VIRTUAL_MAX_PER_HOST} virtual computers`;
        case 'unsupported-arch':
            return `This system is not available on ${name}'s processor; Arch Linux needs an x86-64 host`;
        case 'desktop-node':
            return 'Not available on this kind of node yet';
        case 'permission-denied':
            return `Only the owner of ${name} can create computers on it`;
        case 'not-upgraded':
            return `Update the Ever Works node on ${name} to create virtual computers on it`;
        case 'no-windows-image':
            return `No Windows installer image is configured on ${name}; set EVER_WORKS_NODE_VIRTUAL_WINDOWS_IMAGE there`;
    }
}

/** The Windows free-disk floor (FR-18), in MiB. */
export const FLEET_VIRTUAL_WINDOWS_MIN_FREE_DISK_MIB =
    FLEET_VIRTUAL_WINDOWS_MIN_FREE_DISK_GIB * 1024;

/** Memory every child reserves on its host, running or not (its size). */
export function reservedMemoryMiB(children: readonly FleetVirtualChildFacts[]): number {
    let total = 0;
    for (const child of children) {
        const gib = child.virtualMeta?.memoryGiB;
        if (typeof gib === 'number' && Number.isFinite(gib) && gib > 0) total += gib * 1024;
    }
    return total;
}

/**
 * Free memory net of reservations (spec S6, §5.4): what the host's latest
 * health sample says is free, minus what STOPPED children will take when they
 * start (a running child's memory is already in the sample's "used"). Null
 * when the host never reported memory.
 */
export function netFreeMemoryMiB(
    health: FleetVirtualHostFacts['health'],
    children: readonly FleetVirtualChildFacts[],
): number | null {
    const total = health?.memTotalMiB;
    const used = health?.memUsedMiB;
    if (typeof total !== 'number' || typeof used !== 'number') return null;
    const idle = children.filter((child) => child.virtualMeta?.state !== 'running');
    return Math.max(0, Math.round(total - used - reservedMemoryMiB(idle)));
}

/**
 * "Choose for me" (FR-4, S3): the eligible host with the most free memory;
 * ties (and unknown memory, ranked last) by name. Null when none is eligible.
 */
export function autoPickHost(
    hosts: readonly Pick<
        FleetVirtualHostOption,
        'nodeId' | 'name' | 'eligible' | 'freeMemoryMiB'
    >[],
): string | null {
    const eligible = hosts.filter((host) => host.eligible);
    if (eligible.length === 0) return null;
    const sorted = [...eligible].sort((a, b) => {
        const am = a.freeMemoryMiB ?? -1;
        const bm = b.freeMemoryMiB ?? -1;
        if (am !== bm) return bm - am;
        return a.name.localeCompare(b.name);
    });
    return sorted[0].nodeId;
}

/** Whether a kind may host anything at all (README §8: no nesting). */
export function canHost(
    node: Pick<FleetVirtualHostFacts, 'origin' | 'hostNodeId' | 'kind'>,
): boolean {
    return !isVirtualNode(node) && node.kind !== 'desktop-node';
}

/** The stop dialog's sentence (spec §5.6, FR-27). */
export function stopSummary(kind: FleetVirtualKind, name: string): string {
    return kind === 'vm'
        ? `Stop ${name}? Windows is asked to shut down and gets up to 2 minutes. Sessions on it end.`
        : `Stop ${name}? The container stops within 10 seconds. Sessions on it end.`;
}

/**
 * The Windows free-disk refusal (FR-18, U7), when the host's latest health
 * sample says less than 30 GB is free; null when enough is free or unknown
 * (the host re-checks before anything is pulled).
 */
export function windowsDiskShortfall(
    health: FleetVirtualHostFacts['health'],
    hostName: string,
): string | null {
    const free = health?.diskFreeMiB;
    if (typeof free !== 'number' || !Number.isFinite(free)) return null;
    if (free >= FLEET_VIRTUAL_WINDOWS_MIN_FREE_DISK_MIB) return null;
    return `Windows needs about ${FLEET_VIRTUAL_WINDOWS_MIN_FREE_DISK_GIB} GB free on ${hostName}; ${Math.floor(free / 1024)} GB is free`;
}

/** The destroy dialog's sentence (spec §5.6, FR-28). */
export function destroySummary(kind: FleetVirtualKind, name: string, hostName: string): string {
    const noun = kind === 'vm' ? 'VM' : 'container';
    return `Destroy ${name}? Deletes the ${noun} and its disk under ${hostName}'s node data folder. This cannot be undone. Job history is kept.`;
}
