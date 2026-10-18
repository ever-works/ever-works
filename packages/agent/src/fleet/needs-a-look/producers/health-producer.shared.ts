import {
    FLEET_CLEAR_MODEL_THROTTLE_COMMAND,
    resolveComputerState,
    type ComputerStateResolution,
    type FleetNodeView,
} from '@ever-works/contracts';
import { config } from '../../../config';

/**
 * Shared pieces of FL-03's five "needs a look" producers: which computers a
 * producer looks at, the routes and named commands their actions use, and the
 * English sentences of their items. An item is exactly CONTRACTS §4.6 — the
 * renderer (FL-01) shows `title` and `detail` as they are and resolves the
 * computer's name from `nodeId` — so the sentences are written to be read
 * as is, by a person on the hub and by an Agent through MCP or the CLI.
 */

/** The computer page's Overview tab (CONTRACTS §11.1 `/fleet/computers/[id]?tab=`). */
export function computerRoute(nodeId: string): string {
    return `/fleet/computers/${encodeURIComponent(nodeId)}?tab=overview`;
}

/**
 * Where a computer's resource limits are changed today: Settings → Fleet
 * (`PUT /api/fleet/nodes/:id/limits`). The computer page's own Settings tab
 * is FL-01's and still a placeholder, so "Change limits" leads where the
 * limits can actually be changed — the same place the computer page's own
 * Change limits link goes.
 */
export const CHANGE_LIMITS_ROUTE = '/settings/fleet';

/** The named web command behind "Clear limit now" — see {@link FLEET_CLEAR_MODEL_THROTTLE_COMMAND}. */
export const CLEAR_MODEL_THROTTLE_COMMAND = FLEET_CLEAR_MODEL_THROTTLE_COMMAND;

/**
 * The computer's state as the cards, the header and the health read judge
 * it — WITH the platform's offline window. The hub's list read sweeps only
 * `online` rows, and a single-computer read does not sweep at all, so a
 * machine silent for hours can still carry a stored `online`, `paused` or
 * `disabled`; its last report (quarantine, throttle, disk) is then stale and
 * must not raise an item as if current (FR-30).
 */
export function stateOf(node: FleetNodeView, now: Date): ComputerStateResolution {
    return resolveComputerState(node, {
        now,
        offlineAfterMs: config.fleet.getNodeOfflineAfterMs(),
    });
}

/** True when the computer reads `offline` — by its status, or by its silence. */
export function isOfflineNow(node: FleetNodeView, now: Date): boolean {
    return stateOf(node, now).state === 'offline';
}

/**
 * Stored computers that have checked in at least once. Live-merged cluster
 * rows are never stored and carry no machine facts (README rule 18), and an
 * enrolling row has reported nothing yet.
 */
export function reportingNodes(nodes: readonly FleetNodeView[]): FleetNodeView[] {
    return nodes.filter(
        (node) => node.persisted !== false && node.kind !== 'k8s' && node.status !== 'enrolling',
    );
}

/** What the CLI is called in a sentence. */
export function cliDisplayName(provider: string): string {
    switch (provider) {
        case 'claude-code':
            return 'Claude Code';
        case 'codex':
            return 'Codex';
        default:
            return provider;
    }
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Binary, labelled binary — `6 GiB`, `1.5 GiB`, `512 MiB` — as the node itself speaks of its floor. */
export function formatBinaryBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
    if (bytes >= 10 * GIB) return `${Math.round(bytes / GIB)} GiB`;
    if (bytes >= GIB) return `${(bytes / GIB).toFixed(1).replace(/\.0$/, '')} GiB`;
    return `${Math.round(bytes / MIB)} MiB`;
}

/** An unambiguous instant for a sentence an Agent reads: `Mon 19 Oct 01:00 UTC`. */
export function formatUtcInstant(iso: string): string {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return iso;
    const day = date.toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
    });
    const time = date.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'UTC',
    });
    return `${day} ${time} UTC`;
}

/** The first parseable instant among the candidates, else `fallback` — a stable `since`. */
export function firstInstant(
    fallback: Date,
    ...candidates: Array<string | null | undefined>
): string {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && Number.isFinite(Date.parse(candidate))) {
            return new Date(candidate).toISOString();
        }
    }
    return fallback.toISOString();
}
