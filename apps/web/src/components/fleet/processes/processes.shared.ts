import { fleetProcessMatchesFind, type FleetGpuView, type FleetProcessView } from '@ever-works/contracts';
import { formatBytes } from '../machine/machine-actions.shared';

/**
 * Processes tab (FL-09 P1, spec §5.4) — the pure part: find, the GPU strip's
 * text, protected rows, and the "still running — Kill?" timing.
 */

/** After Stop, the row offers Kill once this long has passed with the process still there (spec S8). */
export const STILL_RUNNING_AFTER_MS = 5_000;

export function visibleProcesses(processes: readonly FleetProcessView[], find: string): FleetProcessView[] {
    return processes.filter((process) => fleetProcessMatchesFind(process, find));
}

/** True when the row has no buttons (the node, its daemon, PID 1 — U10). */
export function isProtected(process: FleetProcessView): boolean {
    return process.protected !== null;
}

/**
 * The GPU strip's parts (spec §5.4): `NVIDIA RTX 4090 · 61% · 9.2 / 24 GB`,
 * or `Apple M2 Max · 38 GB shared · utilisation unavailable` — never a dash
 * for a utilisation the vendor tool does not report.
 */
export function gpuParts(gpu: FleetGpuView): {
    model: string;
    utilization: number | null;
    memory: string | null;
    shared: boolean;
} {
    const model = gpu.model ?? gpu.vendor.toUpperCase();
    const total = gpu.memTotalBytes;
    const used = gpu.memUsedBytes;
    const memory =
        total !== null && used !== null
            ? `${formatBytes(used)} / ${formatBytes(total)}`
            : total !== null
              ? formatBytes(total)
              : null;
    return { model, utilization: gpu.utilizationPercent, memory, shared: gpu.sharedMemory === true };
}

/** Whether a Stop sent at `stoppedAt` should now offer Kill, given the process is still listed. */
export function shouldOfferKill(stoppedAt: number | undefined, stillListed: boolean, now: number = Date.now()): boolean {
    return stoppedAt !== undefined && stillListed && now - stoppedAt >= STILL_RUNNING_AFTER_MS;
}
