import {
    FLEET_DESKTOP_REASON_FIXES,
    isFleetDesktopReason,
    type ComputerQuality,
    type FleetDesktopAttachGrant,
    type FleetDesktopAvailabilityView,
    type FleetDesktopBlocker,
    type FleetDesktopOpenResult,
    type FleetDisplayView,
} from '@ever-works/contracts';
import { readSessionError, type SessionErrorRead } from '../sessions/sessions.shared';

/**
 * Desktop view & control (FL-07, spec §5, plan §8) — the Desktop tab's pure
 * half: which sentence a blocker reads, what fixes it, the display labels, the
 * remembered display, and the calls to the BFF
 * (`app/api/fleet/nodes/[id]/desktop/**`). No React here.
 */

/** The i18n leaf (camelCase, under `fleet.desktop.unavailable`) of each blocker. */
export const DESKTOP_BLOCKER_KEYS = {
    'kill-switch': 'killSwitch',
    'kind-unsupported': 'kindUnsupported',
    offline: 'offline',
    'consent-missing': 'consentMissing',
    'permission-denied': 'permissionDenied',
    'wayland-unsupported': 'waylandUnsupported',
    'helper-missing': 'helperMissing',
    'helper-unadmitted': 'helperUnadmitted',
    'helper-untrusted': 'helperUntrusted',
    'no-display-session': 'noDisplaySession',
    'permission-screen-recording': 'permissionScreenRecording',
    'link-unavailable': 'linkUnavailable',
} as const satisfies Readonly<Record<FleetDesktopBlocker, string>>;

/** The command a blocker's card offers to copy (run on the machine), or null. */
export function desktopBlockerCommand(blocker: FleetDesktopBlocker): string | null {
    if (blocker === 'consent-missing') return 'ever-works-node start --attend';
    return isFleetDesktopReason(blocker) ? (FLEET_DESKTOP_REASON_FIXES[blocker].command ?? null) : null;
}

/** The settings path a blocker's card names (followed on the machine), or null. */
export function desktopBlockerSettingsPath(blocker: FleetDesktopBlocker): string | null {
    return isFleetDesktopReason(blocker) ? (FLEET_DESKTOP_REASON_FIXES[blocker].settingsPath ?? null) : null;
}

/** Whether the card offers "Try again" (a state the machine or the platform may leave on its own). */
export function desktopBlockerRetries(blocker: FleetDesktopBlocker): boolean {
    return blocker !== 'kind-unsupported' && blocker !== 'permission-denied';
}

/** `Display 2 of 3` — 1-based, in the machine's order (the primary first). */
export function displayPosition(
    displays: readonly FleetDisplayView[],
    displayId: string | null,
): { index: number; count: number } {
    const position = displays.findIndex((display) => display.id === displayId);
    return { index: position >= 0 ? position + 1 : 1, count: Math.max(displays.length, 1) };
}

/** `3024 × 1964 @2×` — the size, and the scale when it is not 1. */
export function displaySize(display: FleetDisplayView): string {
    const scale = display.scale && display.scale !== 1 ? ` @${display.scale}×` : '';
    return `${display.width} × ${display.height}${scale}`;
}

/** Where the remembered display lives, per viewer per computer (FR-10). */
export function displayStorageKey(nodeId: string): string {
    return `ew:fleet:desktop:display:${nodeId}`;
}

export function readRememberedDisplay(nodeId: string): string | null {
    try {
        return globalThis.localStorage?.getItem(displayStorageKey(nodeId)) ?? null;
    } catch {
        return null;
    }
}

export function rememberDisplay(nodeId: string, displayId: string | null): void {
    try {
        if (displayId) globalThis.localStorage?.setItem(displayStorageKey(nodeId), displayId);
        else globalThis.localStorage?.removeItem(displayStorageKey(nodeId));
    } catch {
        // private mode: the choice is just not remembered
    }
}

export type DesktopResult<T> = { ok: true; data: T } | { ok: false; error: SessionErrorRead };

/** A grant made browser-reachable by the BFF (`wsUrl` instead of a relative path). */
export interface DesktopBrowserGrant extends Omit<FleetDesktopAttachGrant, 'wsPath'> {
    wsUrl: string;
}

export interface DesktopBrowserOpenResult extends Omit<FleetDesktopOpenResult, 'attach'> {
    attach: DesktopBrowserGrant;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<DesktopResult<T>> {
    try {
        const response = await fetch(path, { cache: 'no-store', ...init });
        const body = (await response.json().catch(() => null)) as unknown;
        if (response.ok) return { ok: true, data: body as T };
        return { ok: false, error: readSessionError(response.status, body) };
    } catch {
        return { ok: false, error: { code: 'unreachable', hint: null, details: {}, status: 0 } };
    }
}

function base(nodeId: string): string {
    return `/api/fleet/nodes/${encodeURIComponent(nodeId)}/desktop`;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** The Desktop tab's calls to its BFF routes. */
export const desktopClient = {
    availability(nodeId: string): Promise<DesktopResult<FleetDesktopAvailabilityView>> {
        return call(`${base(nodeId)}/availability`);
    },
    open(
        nodeId: string,
        body: { displayId?: string; quality?: ComputerQuality },
    ): Promise<DesktopResult<DesktopBrowserOpenResult>> {
        return call(`${base(nodeId)}/views`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
    },
    update(
        nodeId: string,
        viewId: string,
        body: { displayId?: string; quality?: ComputerQuality },
    ): Promise<DesktopResult<DesktopBrowserOpenResult>> {
        return call(`${base(nodeId)}/views/${encodeURIComponent(viewId)}`, {
            method: 'PATCH',
            headers: JSON_HEADERS,
            body: JSON.stringify(body),
        });
    },
    reattach(nodeId: string, viewId: string): Promise<DesktopResult<DesktopBrowserGrant>> {
        return call(`${base(nodeId)}/views/${encodeURIComponent(viewId)}/attach-token`, { method: 'POST' });
    },
    async end(nodeId: string, viewId: string): Promise<void> {
        try {
            await fetch(`${base(nodeId)}/views/${encodeURIComponent(viewId)}`, { method: 'DELETE', cache: 'no-store' });
        } catch {
            // the socket close ends the picture anyway
        }
    },
};
