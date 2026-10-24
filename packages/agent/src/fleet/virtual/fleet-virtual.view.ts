import {
    FLEET_VIRTUAL_ENROLL_TIMEOUT_MS,
    fleetVirtualSystem,
    isFleetVirtualPhase,
    isFleetVirtualState,
    isFleetVirtualSystemId,
    type FleetNodeVirtualView,
    type FleetVirtualMeta,
    type FleetVirtualPhase,
    type FleetVirtualState,
} from '@ever-works/contracts';

/** The row facts the view derivation reads (a `FleetNode` satisfies it). */
export interface FleetVirtualViewSource {
    origin?: string | null;
    hostNodeId?: string | null;
    status: string;
    virtualMeta?: FleetVirtualMeta | null;
}

/** A stored meta off the row, normalised (an unknown phase / state is dropped to its safest reading). */
export function normalizeVirtualMeta(raw: unknown): FleetVirtualMeta | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const meta = raw as Record<string, unknown>;
    if (!isFleetVirtualSystemId(meta.systemId)) return null;
    const num = (value: unknown): number | null =>
        typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
    const iso = (value: unknown): string | null =>
        typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
    const image =
        meta.image && typeof meta.image === 'object' && typeof (meta.image as { ref?: unknown }).ref === 'string'
            ? {
                  ref: String((meta.image as { ref: string }).ref).slice(0, 300),
                  digest:
                      typeof (meta.image as { digest?: unknown }).digest === 'string'
                          ? String((meta.image as { digest: string }).digest).slice(0, 100)
                          : null,
              }
            : null;
    return {
        systemId: meta.systemId,
        cpus: num(meta.cpus) ?? 0,
        memoryGiB: num(meta.memoryGiB) ?? 0,
        diskGiB: num(meta.diskGiB),
        image,
        phase: isFleetVirtualPhase(meta.phase) ? meta.phase : 'queued',
        phaseAt: iso(meta.phaseAt),
        state: isFleetVirtualState(meta.state) ? meta.state : 'creating',
        stateAt: iso(meta.stateAt),
        error: typeof meta.error === 'string' ? meta.error.slice(0, 300) : null,
        activated: typeof meta.activated === 'boolean' ? meta.activated : null,
        createJobId: typeof meta.createJobId === 'string' ? meta.createJobId : null,
        lastControlJobId: typeof meta.lastControlJobId === 'string' ? meta.lastControlJobId : null,
        enrollRequestedAt: iso(meta.enrollRequestedAt),
        viewerPort:
            typeof meta.viewerPort === 'number' && Number.isInteger(meta.viewerPort) && meta.viewerPort > 0 && meta.viewerPort < 65536
                ? meta.viewerPort
                : null,
    };
}

/** The create phase that maps to each in-progress view state. */
function creatingStateOf(phase: FleetVirtualPhase): FleetVirtualState {
    if (phase === 'enrolling') return 'enrolling';
    if (phase === 'downloading-windows' || phase === 'installing' || phase === 'first-boot') return 'installing';
    return 'creating';
}

/**
 * What a child is right now (`FleetVirtualState`), from the row alone:
 *
 *  - while the row is `enrolling` (the guest has not heartbeated yet): the
 *    create's phase, `failed` once the host reported a failure, and
 *    `not-enrolled` once the guest asked for its token more than 20 minutes
 *    ago and still has not heartbeated (U10);
 *  - once enrolled: `running` while the child heartbeats (unless a stop or a
 *    destroy is in flight), otherwise the machine state the host or the
 *    reconcile last reported (`stopped` when nothing better is known).
 */
export function deriveVirtualState(source: FleetVirtualViewSource, now: number = Date.now()): FleetVirtualState {
    const meta = normalizeVirtualMeta(source.virtualMeta);
    const stored = meta?.state ?? 'creating';
    if (stored === 'destroying' || stored === 'gone') return stored;
    if (source.status === 'enrolling') {
        if (stored === 'failed') return 'failed';
        if (stored === 'not-enrolled') return 'not-enrolled';
        const asked = meta?.enrollRequestedAt ? Date.parse(meta.enrollRequestedAt) : NaN;
        if (Number.isFinite(asked) && now - asked > FLEET_VIRTUAL_ENROLL_TIMEOUT_MS) return 'not-enrolled';
        return creatingStateOf(meta?.phase ?? 'queued');
    }
    if (source.status === 'online') {
        return stored === 'stopping' ? 'stopping' : 'running';
    }
    if (stored === 'starting' || stored === 'stopping' || stored === 'stopped' || stored === 'failed') return stored;
    return 'stopped';
}

/**
 * `FleetNodeView.virtual` for a row, or null for a Node that is not a
 * virtual computer. `hostName` is filled in by a reader that knows the host.
 */
export function fleetVirtualViewOf(
    source: FleetVirtualViewSource,
    hostName: string | null = null,
    now: number = Date.now(),
): FleetNodeVirtualView | null {
    if (source.origin !== 'virtual' && !source.hostNodeId) return null;
    const meta = normalizeVirtualMeta(source.virtualMeta);
    if (!meta) return null;
    const system = fleetVirtualSystem(meta.systemId);
    const state = deriveVirtualState(source, now);
    return {
        state,
        phase: source.status === 'enrolling' ? meta.phase : 'online',
        phaseAt: meta.phaseAt,
        systemId: meta.systemId,
        systemLabel: system?.label ?? meta.systemId,
        cpus: meta.cpus,
        memoryGiB: meta.memoryGiB,
        diskGiB: meta.diskGiB,
        activated: meta.activated,
        error: state === 'failed' ? meta.error : null,
        imageDigest: meta.image?.digest ?? null,
        // The installer's screen is worth opening only while Windows installs.
        viewerPort: state === 'installing' || state === 'creating' || state === 'enrolling' ? (meta.viewerPort ?? null) : null,
        hostName,
    };
}
