import {
    describeFleetOtherPorts,
    groupFleetPorts,
    isFleetPortNumber,
    type FleetListeningPort,
    type FleetPortOpenTarget,
    type FleetPortOpenUnavailableReason,
    type FleetPortsGroups,
    type FleetPortsListResponse,
    type FleetPortTunnelOpenResponse,
    type FleetPortTunnelView,
} from '@ever-works/contracts';
import { readSessionError, type SessionErrorRead } from '../sessions/sessions.shared';

/**
 * Servers and ports (FL-10, spec §5) — the pure half of the Ports tab and the
 * Overview's Servers block: ordering and folding (contracts'
 * `groupFleetPorts`), the row's program line, the Open menu's disabled reasons
 * as message keys, the preview's time left, the "Open a port…" parser, and the
 * fetch helpers for the BFF routes. No React, so the specs drive it directly.
 */

export type PortsErrorRead = SessionErrorRead;

/** The CONTRACTS §8 envelope off a BFF answer (or a status-derived one). */
export function readPortsError(status: number, body: unknown): PortsErrorRead {
    return readSessionError(status, body);
}

/** The groups the tab renders, in order. */
export function portsGroups(list: Pick<FleetPortsListResponse, 'ports'> | null): FleetPortsGroups {
    return groupFleetPorts(list?.ports ?? []);
}

/** `:22 ssh · :5432 postgres` for the folded line. */
export function otherPortsLine(ports: readonly FleetListeningPort[]): string {
    return describeFleetOtherPorts(ports);
}

/** `node (pid 4812) · ~/code/api`, or `acme-proxy (container)`, or null. */
export function programLine(port: FleetListeningPort): string | null {
    if (port.container) return `${port.container.name} (container)`;
    if (!port.program) return null;
    const pid = port.program.pid !== null ? ` (pid ${port.program.pid})` : '';
    return port.program.cwd
        ? `${port.program.name}${pid} · ${port.program.cwd}`
        : `${port.program.name}${pid}`;
}

/** The message key (under `fleet.ports.reasons`) for an unavailable Open target. */
export function reasonKey(reason: FleetPortOpenUnavailableReason | undefined): string {
    switch (reason) {
        case 'attend-missing':
            return 'attendMissing';
        case 'desktop-family':
            return 'desktopFamily';
        case 'no-desktop':
            return 'noDesktop';
        case 'preview-off':
            return 'previewOff';
        case 'no-browser':
            return 'noBrowser';
        case 'ports-family':
        default:
            return 'portsFamily';
    }
}

/** `59:12` — minutes and seconds left until `endsAt`, never negative. */
export function timeLeft(endsAt: string | null | undefined, nowMs: number): string {
    if (!endsAt) return '';
    const ends = new Date(endsAt).getTime();
    if (!Number.isFinite(ends)) return '';
    const totalSeconds = Math.max(0, Math.floor((ends - nowMs) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** "Open a port…" input → a port number, or null (1–65535, digits only). */
export function parsePortInput(value: string): number | null {
    const trimmed = value.trim().replace(/^:/, '');
    if (!/^\d{1,5}$/.test(trimmed)) return null;
    const port = Number(trimmed);
    return isFleetPortNumber(port) ? port : null;
}

/** The address the row's "Copy address" copies. */
export function portAddress(port: FleetListeningPort): string {
    return `${port.web?.scheme ?? 'http'}://127.0.0.1:${port.port}/`;
}

/** `1.2 MB` — a tunnel's bytes, for its row. */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** The open tunnel of a port in a list response, if the viewer holds one. */
export function tunnelFor(
    list: FleetPortsListResponse | null,
    port: number,
): FleetPortTunnelView | null {
    return (
        list?.tunnel?.open.find((tunnel) => tunnel.port === port && tunnel.state === 'open') ?? null
    );
}

/**
 * Phase 3 (FR-33) — which WATCHED ports stopped between two lists: a watched
 * port that was listening (a live row) and now is not (stopped, waiting, or
 * gone). `wasLive` is the set the caller keeps between lists.
 */
export function watchedStopped(
    list: Pick<FleetPortsListResponse, 'ports'>,
    watched: readonly number[],
    wasLive: ReadonlySet<number>,
): { stopped: number[]; live: Set<number> } {
    const live = new Set<number>();
    for (const port of list.ports) {
        if (watched.includes(port.port) && port.kind !== 'waiting' && !port.stopped)
            live.add(port.port);
    }
    const stopped = [...wasLive].filter((port) => watched.includes(port) && !live.has(port));
    return { stopped, live };
}

/** The target Open uses for a row (the response's default), or null when nothing is available. */
export function defaultOpenTarget(list: FleetPortsListResponse | null): FleetPortOpenTarget | null {
    return list?.defaultTarget ?? null;
}

// ─── BFF calls ──────────────────────────────────────────────────────────────

export type PortsResult<T> = { ok: true; data: T } | { ok: false; error: PortsErrorRead };

export interface PortOpenAnswer {
    target: FleetPortOpenTarget;
    url: string;
    previewViewId?: string;
    endsAt?: string;
    attach?: { token: string; wsUrl: string; expiresInSec?: number; role?: string };
}

async function call<T>(input: string, init?: RequestInit): Promise<PortsResult<T>> {
    try {
        const response = await fetch(input, { cache: 'no-store', ...init });
        const body = (await response.json().catch(() => null)) as unknown;
        if (!response.ok) return { ok: false, error: readPortsError(response.status, body) };
        return { ok: true, data: body as T };
    } catch {
        return {
            ok: false,
            error: { code: 'network', hint: null, details: {}, status: 0 } as PortsErrorRead,
        };
    }
}

export const portsClient = {
    list(nodeId: string, watch: readonly number[]): Promise<PortsResult<FleetPortsListResponse>> {
        const query = watch.length > 0 ? `?watch=${watch.join(',')}` : '';
        return call(`/api/fleet/nodes/${encodeURIComponent(nodeId)}/ports${query}`);
    },
    /** Phase 3 — a watched server stopped: file the Inbox item (best-effort). */
    async watchStopped(nodeId: string, port: number): Promise<void> {
        try {
            await fetch(
                `/api/fleet/nodes/${encodeURIComponent(nodeId)}/ports/${port}/watch-stopped`,
                {
                    method: 'POST',
                    cache: 'no-store',
                },
            );
        } catch {
            // the inline notice is shown either way
        }
    },
    /** Phase 2 — open (or re-open) the person's preview tunnel; the answer carries a one-time `openUrl`. */
    openPreview(nodeId: string, port: number): Promise<PortsResult<FleetPortTunnelOpenResponse>> {
        return call(`/api/fleet/nodes/${encodeURIComponent(nodeId)}/ports/${port}/preview`, {
            method: 'POST',
        });
    },
    /** Phase 2 — the open tunnel with a fresh one-time `openUrl`. */
    readPreview(nodeId: string, port: number): Promise<PortsResult<FleetPortTunnelOpenResponse>> {
        return call(`/api/fleet/nodes/${encodeURIComponent(nodeId)}/ports/${port}/preview`);
    },
    /** Phase 2 — close the person's preview tunnel. */
    async closePreview(nodeId: string, port: number): Promise<PortsResult<null>> {
        try {
            const response = await fetch(
                `/api/fleet/nodes/${encodeURIComponent(nodeId)}/ports/${port}/preview`,
                {
                    method: 'DELETE',
                    cache: 'no-store',
                },
            );
            if (response.ok) return { ok: true, data: null };
            const body = (await response.json().catch(() => null)) as unknown;
            return { ok: false, error: readPortsError(response.status, body) };
        } catch {
            return {
                ok: false,
                error: { code: 'network', hint: null, details: {}, status: 0 } as PortsErrorRead,
            };
        }
    },
    open(
        nodeId: string,
        port: number,
        body: { target?: FleetPortOpenTarget; scheme?: 'http' | 'https' },
    ): Promise<PortsResult<PortOpenAnswer>> {
        return call(`/api/fleet/nodes/${encodeURIComponent(nodeId)}/ports/${port}/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    },
};
