import {
    FLEET_VIRTUAL_DEFAULT_CPUS,
    FLEET_VIRTUAL_DEFAULT_DISK_GIB,
    FLEET_VIRTUAL_DEFAULT_MEMORY_GIB,
    fleetVirtualPhasesFor,
    type FleetNodeView,
    type FleetVirtualHostOption,
    type FleetVirtualHostReason,
    type FleetVirtualKind,
    type FleetVirtualPhase,
    type FleetVirtualState,
    type FleetVirtualSystem,
} from '@ever-works/contracts';

/**
 * Virtual computers (FL-16, plan §8, T-20) — the pure half of the web surface:
 * which message key each refusal, phase and state reads as, the form's
 * defaults per system, and which computers can host. Every user-visible
 * string lives under `fleet.virtual.*` in `messages/en.json`; this file only
 * names keys.
 */

/** The message key (under `fleet.virtual.reasons`) of each host refusal (spec §5.8). */
export const VIRTUAL_REASON_KEYS: Readonly<Record<FleetVirtualHostReason, string>> = {
    offline: 'offline',
    'consent-missing': 'consentMissing',
    'no-docker': 'noDocker',
    'no-kvm': 'noKvm',
    'windows-host': 'windowsHost',
    'is-virtual': 'isVirtual',
    limit: 'limit',
    'unsupported-arch': 'unsupportedArch',
    'desktop-node': 'desktopNode',
    'permission-denied': 'permissionDenied',
    'not-upgraded': 'notUpgraded',
    'no-windows-image': 'noWindowsImage',
};

/** The message key (under `fleet.virtual.progress`) of each create phase (FR-13). */
export const VIRTUAL_PHASE_KEYS: Readonly<Record<FleetVirtualPhase, string>> = {
    queued: 'queued',
    'pulling-image': 'pullingImage',
    'downloading-windows': 'downloadingWindows',
    installing: 'installing',
    'first-boot': 'firstBoot',
    starting: 'starting',
    'installing-runtime': 'installingRuntime',
    enrolling: 'enrolling',
    online: 'online',
};

/** The message key (under `fleet.virtual.state`) of each view state. */
export const VIRTUAL_STATE_KEYS: Readonly<Record<FleetVirtualState, string>> = {
    creating: 'creating',
    installing: 'installing',
    enrolling: 'enrolling',
    starting: 'starting',
    running: 'running',
    stopping: 'stopping',
    stopped: 'stopped',
    failed: 'failed',
    'not-enrolled': 'notEnrolled',
    gone: 'gone',
    destroying: 'destroying',
};

/** The glyph a state reads as in a row (● running, ■ stopped, ◌ busy, ✕ failed). */
export function virtualStateGlyph(state: FleetVirtualState): string {
    if (state === 'running') return '●';
    if (state === 'stopped' || state === 'gone') return '■';
    if (state === 'failed' || state === 'not-enrolled') return '✕';
    return '◌';
}

/** True while the child is being built or changed (the hub polls faster). */
export function isVirtualBusy(state: FleetVirtualState | null | undefined): boolean {
    return (
        state === 'creating' ||
        state === 'installing' ||
        state === 'enrolling' ||
        state === 'starting' ||
        state === 'stopping' ||
        state === 'destroying'
    );
}

/** A Node that is a virtual computer (it carries a host). */
export function isVirtualChild(node: Pick<FleetNodeView, 'hostNodeId' | 'origin'>): boolean {
    return node.origin === 'virtual' || Boolean(node.hostNodeId);
}

/** A Node that may be offered as a host at all (never a child, never the desktop app — FR-10, §5.8). */
export function mayBeHost(node: Pick<FleetNodeView, 'hostNodeId' | 'origin' | 'kind'>): boolean {
    return !isVirtualChild(node) && node.kind !== 'desktop-node' && node.kind !== 'k8s';
}

/** The progress line's steps for a kind, with the index of the current phase (spec §5.3). */
export function progressSteps(
    kind: FleetVirtualKind,
    phase: FleetVirtualPhase,
): { steps: FleetVirtualPhase[]; current: number } {
    const steps = fleetVirtualPhasesFor(kind);
    const index = steps.indexOf(phase);
    return { steps, current: index < 0 ? 0 : index };
}

/** The form a fresh dialog starts with (FR-2: 4 CPUs, 8 GB, 64 GB for Windows). */
export interface VirtualForm {
    name: string;
    systemId: FleetVirtualSystem['id'];
    /** `auto` = "Choose for me". */
    hostNodeId: string;
    cpus: number;
    memoryGiB: number;
    diskGiB: number;
}

export function initialVirtualForm(
    systemId: FleetVirtualSystem['id'],
    hostNodeId: string | null,
): VirtualForm {
    return {
        name: '',
        systemId,
        hostNodeId: hostNodeId ?? 'auto',
        cpus: FLEET_VIRTUAL_DEFAULT_CPUS,
        memoryGiB: FLEET_VIRTUAL_DEFAULT_MEMORY_GIB,
        diskGiB: FLEET_VIRTUAL_DEFAULT_DISK_GIB,
    };
}

/** The host the form will create on: the chosen one, or "Choose for me"'s pick (named before Create — S3). */
export function effectiveHost(
    form: Pick<VirtualForm, 'hostNodeId'>,
    hosts: readonly FleetVirtualHostOption[],
    autoPickNodeId: string | null,
): FleetVirtualHostOption | null {
    const id = form.hostNodeId === 'auto' ? autoPickNodeId : form.hostNodeId;
    return hosts.find((host) => host.nodeId === id) ?? null;
}

/** MiB → "23 GB" (one decimal under 10 GB). */
export function formatGiB(mib: number | null | undefined): string | null {
    if (typeof mib !== 'number' || !Number.isFinite(mib)) return null;
    const gib = mib / 1024;
    return gib < 10 ? `${Math.round(gib * 10) / 10} GB` : `${Math.round(gib)} GB`;
}
