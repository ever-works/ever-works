import {
    fleetCommandUtf8Length,
    fleetConsentMissingHint,
    fleetConsentSatisfies,
    isFleetCommandCwd,
    FLEET_COMMAND_DEFAULT_TIMEOUT_SEC,
    FLEET_COMMAND_MAX_CONCURRENT_PER_OWNER,
    FLEET_COMMAND_MAX_LENGTH,
    FLEET_COMMAND_MAX_NODES,
    FLEET_COMMAND_MAX_TIMEOUT_SEC,
    FLEET_COMMAND_MIN_TIMEOUT_SEC,
    FLEET_COMMAND_RUNS_PER_MINUTE,
    type FleetCommandTargetSummary,
    type FleetConsents,
    type FleetLinkError,
} from '@ever-works/contracts';

/**
 * Commands on computers (FL-12) — the pure rules: what a Command request may
 * carry, which computers may take it, and what the confirmation shows. No
 * Nest, no TypeORM, no clock of its own: every input is a fact handed in, so
 * the truth tables (spec §3.2, CONTRACTS §8, §10) are testable on their own.
 *
 * A refusal is a VALUE — the CONTRACTS §8 error with a hint a person can act
 * on — and `null` means allowed. Never a discriminated union: this package
 * compiles without `strictNullChecks`, under which such unions do not narrow.
 */

export type FleetCommandRefusal = FleetLinkError | null;

const refuse = (
    code: FleetLinkError['code'],
    hint: string,
    details?: Record<string, unknown>,
): FleetLinkError => (details ? { code, hint, details } : { code, hint });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A request after its shape was checked: the values the service runs with. */
export interface FleetCommandRequestShape {
    command: string;
    nodeIds: string[];
    cwd: string | null;
    timeoutSec: number;
}

/**
 * Check a run request's shape (spec FR-1, FR-8, U5). Answers the refusal, or
 * null with `out` filled. Limits answer `limit_exceeded` naming the limit
 * (U5); anything malformed answers `invalid` naming the field.
 */
export function checkFleetCommandRequest(
    raw: {
        command?: unknown;
        nodeIds?: unknown;
        cwd?: unknown;
        timeoutSec?: unknown;
        cadence?: unknown;
    },
    out: FleetCommandRequestShape,
): FleetCommandRefusal {
    if (raw.cadence !== undefined && raw.cadence !== null) {
        // A Command with a cadence is a Schedule (FL-13 owns its validation, spec FR-8).
        return refuse('invalid', 'schedules are not available on this deployment yet', {
            field: 'cadence',
        });
    }
    if (typeof raw.command !== 'string' || raw.command.trim().length === 0) {
        return refuse('invalid', 'type a command', { field: 'command' });
    }
    if (raw.command.includes('\0')) {
        return refuse('invalid', 'the command contains a NUL character', { field: 'command' });
    }
    if (fleetCommandUtf8Length(raw.command) > FLEET_COMMAND_MAX_LENGTH) {
        return refuse('limit_exceeded', 'a command is at most 8 KiB', {
            field: 'command',
            limit: FLEET_COMMAND_MAX_LENGTH,
        });
    }
    if (!Array.isArray(raw.nodeIds) || raw.nodeIds.length === 0) {
        return refuse('invalid', 'choose at least one computer', { field: 'nodeIds' });
    }
    const nodeIds: string[] = [];
    for (const id of raw.nodeIds) {
        if (typeof id !== 'string' || !UUID.test(id)) {
            return refuse('invalid', 'a computer id is not valid', { field: 'nodeIds' });
        }
        const lower = id.toLowerCase();
        if (!nodeIds.includes(lower)) nodeIds.push(lower);
    }
    if (nodeIds.length > FLEET_COMMAND_MAX_NODES) {
        return refuse('limit_exceeded', `a command runs on at most ${FLEET_COMMAND_MAX_NODES} computers`, {
            field: 'nodeIds',
            limit: FLEET_COMMAND_MAX_NODES,
        });
    }
    let cwd: string | null = null;
    if (raw.cwd !== undefined && raw.cwd !== null && raw.cwd !== '') {
        if (!isFleetCommandCwd(raw.cwd)) {
            return refuse('invalid', 'the folder is not a path', { field: 'cwd' });
        }
        cwd = raw.cwd.trim();
        if (cwd === '~') cwd = null;
    }
    let timeoutSec = FLEET_COMMAND_DEFAULT_TIMEOUT_SEC;
    if (raw.timeoutSec !== undefined && raw.timeoutSec !== null) {
        if (typeof raw.timeoutSec !== 'number' || !Number.isFinite(raw.timeoutSec)) {
            return refuse('invalid', 'the timeout is a number of seconds', { field: 'timeoutSec' });
        }
        if (raw.timeoutSec > FLEET_COMMAND_MAX_TIMEOUT_SEC) {
            return refuse('limit_exceeded', 'the timeout is at most 60 minutes (3 600 s)', {
                field: 'timeoutSec',
                limit: FLEET_COMMAND_MAX_TIMEOUT_SEC,
            });
        }
        if (raw.timeoutSec < FLEET_COMMAND_MIN_TIMEOUT_SEC) {
            return refuse('invalid', 'the timeout is at least 1 s', { field: 'timeoutSec' });
        }
        timeoutSec = Math.floor(raw.timeoutSec);
    }
    out.command = raw.command;
    out.nodeIds = nodeIds;
    out.cwd = cwd;
    out.timeoutSec = timeoutSec;
    return null;
}

/** May this person send one more Command right now (CONTRACTS §10, §10.1)? */
export function checkFleetCommandAdmission(facts: {
    killSwitchOn: boolean;
    /** This person's Commands still running. */
    running: number;
    /** This person's confirmed Commands in the last minute (this replica's count). */
    lastMinute: number;
}): FleetCommandRefusal {
    if (facts.killSwitchOn) return refuse('kill_switch', 'clear it under Settings → Fleet');
    if (facts.running >= FLEET_COMMAND_MAX_CONCURRENT_PER_OWNER) {
        return refuse(
            'limit_exceeded',
            `${facts.running} commands are still running; wait for one to finish`,
            { limit: FLEET_COMMAND_MAX_CONCURRENT_PER_OWNER },
        );
    }
    if (facts.lastMinute >= FLEET_COMMAND_RUNS_PER_MINUTE) {
        return refuse(
            'limit_exceeded',
            `at most ${FLEET_COMMAND_RUNS_PER_MINUTE} commands a minute; try again shortly`,
            { limit: FLEET_COMMAND_RUNS_PER_MINUTE },
        );
    }
    return null;
}

/** Everything one target decision reads — gathered by the service, judged here. */
export interface FleetCommandTargetFacts {
    node: {
        name: string;
        status: string;
        kind: string;
        platform: string | null;
    };
    /** What the node's live link presented, else what its last heartbeat stored. */
    consents: FleetConsents;
    /** The platform holds the node's link right now. */
    linkConnected: boolean;
    /** When the node was last heard, as a person reads it (`12 min`), or null. */
    lastSeenAgo: string | null;
}

/**
 * May this computer take a Command? First refusal wins (the `commands`
 * family audience was checked by the caller first — a stranger never
 * reaches these facts):
 *
 *  1. a cluster node — `unsupported_on_node`;
 *  2. the computer's own state (paused, disabled, enrolling) — `busy`, naming it;
 *  3. `--manage` — `consent_missing` with the start hint (FR-9, U8);
 *  4. the link — `unreachable` with when it was last seen (FR-3, nothing queued).
 */
export function fleetCommandTargetRefusal(facts: FleetCommandTargetFacts): FleetCommandRefusal {
    const { node } = facts;
    if (node.kind === 'k8s') {
        return refuse('unsupported_on_node', `${node.name} is a cluster node; commands run on computers`);
    }
    if (node.status === 'paused' || node.status === 'disabled' || node.status === 'enrolling') {
        const words: Record<string, string> = {
            paused: `${node.name} is paused — resume it to run commands`,
            disabled: `${node.name} is disabled — enable it to run commands`,
            enrolling: `${node.name} has not finished enrolling`,
        };
        return refuse('busy', words[node.status], { nodeState: node.status });
    }
    if (!fleetConsentSatisfies(facts.consents, 'manage')) {
        return refuse('consent_missing', fleetConsentMissingHint('manage', node.name), {
            consent: 'manage',
        });
    }
    if (!facts.linkConnected) {
        return refuse(
            'unreachable',
            facts.lastSeenAgo
                ? `${node.name} is offline — last seen ${facts.lastSeenAgo} ago`
                : `${node.name} is not connected`,
        );
    }
    return null;
}

/** `Linux` · `macOS` · `Windows` from a node's `platform` (`linux/x64`), or null. */
export function fleetCommandOsLabel(platform: string | null | undefined): string | null {
    const os = (platform ?? '').split('/')[0].trim().toLowerCase();
    if (os === 'linux') return 'Linux';
    if (os === 'darwin' || os === 'macos') return 'macOS';
    if (os === 'win32' || os === 'windows') return 'Windows';
    return null;
}

/** The shell the confirmation names (spec FR-2): PowerShell on Windows, else the login shell. */
export function fleetCommandShellLabel(platform: string | null | undefined): string {
    return fleetCommandOsLabel(platform) === 'Windows' ? 'PowerShell' : 'the login shell';
}

/** One line of the confirmation summary (spec §5.1, FR-11). */
export function fleetCommandTargetSummary(input: {
    nodeId: string;
    nodeName: string;
    platform: string | null;
    cwd: string | null;
    refusal: FleetCommandRefusal;
}): FleetCommandTargetSummary {
    return {
        nodeId: input.nodeId,
        nodeName: input.nodeName,
        os: fleetCommandOsLabel(input.platform),
        shell: fleetCommandShellLabel(input.platform),
        user: 'machine-owner',
        folder: input.cwd ?? '~',
        runnable: input.refusal === null,
        error: input.refusal,
    };
}

/** When something was last heard, as a person reads it: `40 s`, `12 min`, `2 h`, `3 d`. */
export function describeFleetCommandAgo(
    since: Date | string | null | undefined,
    now: number,
): string | null {
    if (!since) return null;
    const at = since instanceof Date ? since.getTime() : Date.parse(since);
    if (!Number.isFinite(at)) return null;
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 90) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 36) return `${hours} h`;
    return `${Math.round(hours / 24)} d`;
}

/** The refusal an older node's `unsupported_on_node` becomes on a card (spec §6 compatibility). */
export function fleetCommandOlderNodeHint(nodeName: string): string {
    return `update the node on ${nodeName} to run commands`;
}
