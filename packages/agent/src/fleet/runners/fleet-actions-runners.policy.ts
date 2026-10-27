import {
    FLEET_ACTIONS_RUNNER_CAPABILITY,
    FLEET_ACTIONS_RUNNERS_MAX_PER_NODE,
    fleetActionsRunnerDefaultLabels,
    fleetActionsRunnerLogSourceId,
    fleetActionsRunnerSettingsUrl,
    type FleetActionsRunnerHostReason,
    type FleetActionsRunnerView,
    type FleetConsents,
    type FleetLinkErrorCode,
} from '@ever-works/contracts';
import type { FleetActionsRunner } from '../../entities/fleet-actions-runner.entity';
import type { FleetNode } from '../../entities/fleet-node.entity';

/**
 * Actions runners on computers (FL-18) — the pure rules of the service: can
 * this computer host runners (spec FR-1, U1–U5, U9), what each refusal is
 * called (CONTRACTS §8) and says, and how a row reads on the wire. No IO.
 */

/** The facts of a Node the eligibility rule reads. */
export type RunnerHostFacts = Pick<FleetNode, 'kind' | 'status' | 'lastHeartbeatAt' | 'capabilities' | 'name'> & {
    consents?: FleetConsents | null;
};

/** `os:*` / `arch:*` off a capability list. */
export function capabilityValue(capabilities: readonly string[] | null | undefined, prefix: 'os' | 'arch'): string | null {
    for (const tag of capabilities ?? []) {
        if (tag.startsWith(`${prefix}:`)) return tag.slice(prefix.length + 1) || null;
    }
    return null;
}

export function isRunnerHostOnline(node: Pick<RunnerHostFacts, 'status' | 'lastHeartbeatAt'>, offlineCutoffMs: number): boolean {
    if (node.status !== 'online') return false;
    const at = node.lastHeartbeatAt ? new Date(node.lastHeartbeatAt).getTime() : NaN;
    return Number.isFinite(at) && at >= offlineCutoffMs;
}

/**
 * Why a computer cannot take runners right now, or null (spec FR-1). The
 * order is the gate order of CONTRACTS §2.1 after existence: kill switch,
 * audience, then the machine (offline, consent, service manager), then the
 * limit — the first reason is the one named.
 */
export function runnerHostReason(input: {
    node: RunnerHostFacts;
    allowed: boolean;
    stopped: boolean;
    offlineCutoffMs: number;
    /** Runners already on it (CONTRACTS §10); `null` skips the limit (acting on an existing runner). */
    existing: number | null;
    /** How many more the request adds. */
    adding?: number;
}): FleetActionsRunnerHostReason | null {
    const { node } = input;
    if (node.kind === 'k8s') return 'cluster';
    if (input.stopped) return 'kill-switch';
    if (!input.allowed) return 'permission-denied';
    if (!isRunnerHostOnline(node, input.offlineCutoffMs)) return 'offline';
    if (node.consents?.work !== true) return 'consent-missing';
    if (!(node.capabilities ?? []).includes(FLEET_ACTIONS_RUNNER_CAPABILITY)) return 'no-service-manager';
    if (input.existing !== null && input.existing + (input.adding ?? 1) > FLEET_ACTIONS_RUNNERS_MAX_PER_NODE) return 'limit';
    return null;
}

/** The CONTRACTS §8 code each reason answers with. */
export function runnerHostReasonCode(reason: FleetActionsRunnerHostReason): FleetLinkErrorCode {
    switch (reason) {
        case 'offline':
            return 'unreachable';
        case 'consent-missing':
            return 'consent_missing';
        case 'no-service-manager':
        case 'cluster':
            return 'unsupported_on_node';
        case 'permission-denied':
            return 'permission_denied';
        case 'limit':
            return 'limit_exceeded';
        case 'kill-switch':
            return 'kill_switch';
    }
}

/** The sentence each reason carries (spec U1–U3, U9, U14, U15). */
export function runnerHostReasonHint(
    reason: FleetActionsRunnerHostReason,
    node: Pick<RunnerHostFacts, 'name'>,
    extra: { lastSeen?: string | null } = {},
): string {
    switch (reason) {
        case 'offline':
            return extra.lastSeen ? `${node.name} last heartbeated ${extra.lastSeen} ago` : `${node.name} is offline`;
        case 'consent-missing':
            return `start the node with --work on ${node.name}`;
        case 'no-service-manager':
            return `no service manager was found on ${node.name}, or its node is too old to install runners — update it and start it with --work`;
        case 'cluster':
            return 'a cluster computer cannot host Actions runners';
        case 'permission-denied':
            return `Only the people allowed to change computers on ${node.name} can install or control its runners`;
        case 'limit':
            return `${node.name} already has ${FLEET_ACTIONS_RUNNERS_MAX_PER_NODE} runners, the most one computer may have`;
        case 'kill-switch':
            return 'All computers are stopped — runners keep running; installing and controlling them is paused. Clear it under Settings → Fleet';
    }
}

/** "2 h", "12 min" since an instant, or null. */
export function describeAgo(at: Date | string | null | undefined, now: number = Date.now()): string | null {
    const ms = at ? now - new Date(at).getTime() : NaN;
    if (!Number.isFinite(ms) || ms < 0) return null;
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return `${Math.max(1, minutes)} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.round(hours / 24)} days`;
}

function iso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A `bigint` column comes back as a string on Postgres: the wire carries a number. */
export function githubRunnerIdOf(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** One row on the wire (spec §5.2). Never a token, never a path of the machine. */
export function fleetActionsRunnerViewOf(
    row: FleetActionsRunner,
    node: Pick<FleetNode, 'capabilities'> | null,
    extra: { updateAvailable?: string | null } = {},
): FleetActionsRunnerView {
    const os = capabilityValue(node?.capabilities, 'os');
    const arch = capabilityValue(node?.capabilities, 'arch');
    return {
        id: row.id,
        nodeId: row.nodeId,
        name: row.name,
        scope: row.scope,
        target: row.target,
        labels: Array.isArray(row.labels) ? row.labels.filter((label) => typeof label === 'string') : [],
        defaultLabels: fleetActionsRunnerDefaultLabels(os, arch),
        mode: row.mode,
        state: row.state,
        stateSource: row.stateSource ?? null,
        stoppedByOwner: row.stoppedByOwner === true,
        phase: row.state === 'installing' ? (row.phase ?? 'queued') : (row.phase ?? null),
        lastError: row.lastError ?? null,
        githubRunnerId: githubRunnerIdOf(row.githubRunnerId),
        runnerVersion: row.runnerVersion ?? null,
        ...(extra.updateAvailable !== undefined ? { updateAvailable: extra.updateAvailable } : {}),
        currentJob: row.state === 'working' ? (row.currentJob ?? null) : null,
        lastSeenAt: iso(row.lastSeenAt),
        lastCheckAt: iso(row.lastCheckAt),
        installedAt: iso(row.installedAt),
        githubUrl: fleetActionsRunnerSettingsUrl(row.scope, row.target),
        logSource: fleetActionsRunnerLogSourceId(row.name),
    };
}

/**
 * The Actions jobs panel's default watched list (FR-21): every repository and
 * organisation the person has runners registered for, once each
 * (case-insensitively), in name order.
 */
export function defaultWatchedTargets(
    rows: ReadonlyArray<Pick<FleetActionsRunner, 'scope' | 'target' | 'state' | 'removedAt'>>,
): Array<{ scope: 'org' | 'repo'; target: string }> {
    const seen = new Map<string, { scope: 'org' | 'repo'; target: string }>();
    for (const row of rows) {
        if (row.removedAt || row.state === 'removed') continue;
        const key = `${row.scope}:${row.target.toLowerCase()}`;
        if (!seen.has(key)) seen.set(key, { scope: row.scope, target: row.target });
    }
    return [...seen.values()].sort((a, b) => a.target.localeCompare(b.target));
}
