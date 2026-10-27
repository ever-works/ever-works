import {
    fleetCommandUtf8Length,
    fleetConsentSatisfies,
    fleetScheduleNeverRunsHint,
    isFleetCommandCwd,
    parseFleetScheduleCadence,
    FLEET_COMMAND_MAX_LENGTH,
    FLEET_SCHEDULE_NAME_MAX_LENGTH,
    FLEET_SCHEDULES_PER_NODE,
    FLEET_SCHEDULE_WRITES_PER_MINUTE,
    type FleetConsents,
    type FleetLinkError,
    type FleetScheduleCadence,
    type FleetScheduleNeverRunsReason,
} from '@ever-works/contracts';

/**
 * Schedules on computers (FL-13) — the pure rules: what a schedule request
 * may carry, which computers may hold one, and why a saved one would never
 * run there. No Nest, no TypeORM, no clock of its own: every input is a fact
 * handed in, so the truth tables (spec §3.2, CONTRACTS §8, §10) are testable
 * on their own.
 *
 * A refusal is a VALUE — the CONTRACTS §8 error with a hint a person can act
 * on — and `null` means allowed (never a discriminated union: this package
 * compiles without `strictNullChecks`).
 */

export type FleetScheduleRefusal = FleetLinkError | null;

const refuse = (
    code: FleetLinkError['code'],
    hint: string,
    details?: Record<string, unknown>,
): FleetLinkError => (details ? { code, hint, details } : { code, hint });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A schedule's definition after its shape was checked. */
export interface FleetScheduleShape {
    name: string;
    nodeId: string;
    command: string;
    /** Null = the machine owner's home folder. */
    cwd: string | null;
    cadence: FleetScheduleCadence;
}

function checkName(raw: unknown): { name: string | null; refusal: FleetScheduleRefusal } {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return { name: null, refusal: refuse('invalid', 'name the schedule', { field: 'name' }) };
    }
    if (/[\0\r\n]/.test(raw)) {
        return { name: null, refusal: refuse('invalid', 'a name is one line', { field: 'name' }) };
    }
    if (raw.trim().length > FLEET_SCHEDULE_NAME_MAX_LENGTH) {
        return {
            name: null,
            refusal: refuse(
                'limit_exceeded',
                `a name is at most ${FLEET_SCHEDULE_NAME_MAX_LENGTH} characters`,
                {
                    field: 'name',
                    limit: FLEET_SCHEDULE_NAME_MAX_LENGTH,
                },
            ),
        };
    }
    return { name: raw.trim(), refusal: null };
}

function checkCommand(raw: unknown): FleetScheduleRefusal {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return refuse('invalid', 'type a command', { field: 'command' });
    }
    if (raw.includes('\0'))
        return refuse('invalid', 'the command contains a NUL character', { field: 'command' });
    if (fleetCommandUtf8Length(raw) > FLEET_COMMAND_MAX_LENGTH) {
        return refuse('limit_exceeded', 'a command is at most 8 KiB', {
            field: 'command',
            limit: FLEET_COMMAND_MAX_LENGTH,
        });
    }
    return null;
}

function checkCwd(raw: unknown): { cwd: string | null; refusal: FleetScheduleRefusal } {
    if (raw === undefined || raw === null || raw === '') return { cwd: null, refusal: null };
    if (!isFleetCommandCwd(raw)) {
        return {
            cwd: null,
            refusal: refuse('invalid', 'the folder is not a path', { field: 'cwd' }),
        };
    }
    const cwd = raw.trim();
    return { cwd: cwd === '~' ? null : cwd, refusal: null };
}

function checkCadence(raw: unknown): {
    cadence: FleetScheduleCadence | null;
    refusal: FleetScheduleRefusal;
} {
    const parsed = parseFleetScheduleCadence(raw);
    if (!parsed.cadence) {
        return {
            cadence: null,
            refusal: refuse('invalid', parsed.error ?? 'choose when it runs', { field: 'cadence' }),
        };
    }
    return { cadence: parsed.cadence, refusal: null };
}

/** The ONE computer of a create: `nodeId`, or `nodeIds` holding exactly one id. */
function checkNode(raw: { nodeId?: unknown; nodeIds?: unknown }): {
    nodeId: string | null;
    refusal: FleetScheduleRefusal;
} {
    let candidate: unknown = raw.nodeId;
    if (candidate === undefined && Array.isArray(raw.nodeIds)) {
        if (raw.nodeIds.length !== 1) {
            return {
                nodeId: null,
                refusal: refuse('invalid', 'a schedule runs on one computer', { field: 'nodeIds' }),
            };
        }
        candidate = raw.nodeIds[0];
    }
    if (typeof candidate !== 'string' || !UUID.test(candidate)) {
        return {
            nodeId: null,
            refusal: refuse('invalid', 'choose a computer', { field: 'nodeId' }),
        };
    }
    return { nodeId: candidate.toLowerCase(), refusal: null };
}

/**
 * Check a create request's shape (spec FR-5, FR-6, FR-28). Answers the
 * refusal, or null with `out` filled. Limits answer `limit_exceeded` naming
 * the limit; anything malformed answers `invalid` naming the field.
 */
export function checkFleetScheduleCreate(
    raw: {
        name?: unknown;
        nodeId?: unknown;
        nodeIds?: unknown;
        command?: unknown;
        cwd?: unknown;
        cadence?: unknown;
    },
    out: FleetScheduleShape,
): FleetScheduleRefusal {
    const name = checkName(raw.name);
    if (name.refusal) return name.refusal;
    const node = checkNode(raw);
    if (node.refusal) return node.refusal;
    const command = checkCommand(raw.command);
    if (command) return command;
    const cwd = checkCwd(raw.cwd);
    if (cwd.refusal) return cwd.refusal;
    const cadence = checkCadence(raw.cadence);
    if (cadence.refusal) return cadence.refusal;
    out.name = name.name as string;
    out.nodeId = node.nodeId as string;
    out.command = raw.command as string;
    out.cwd = cwd.cwd;
    out.cadence = cadence.cadence as FleetScheduleCadence;
    return null;
}

/**
 * Check an update (spec FR-10): every field but the kind, each optional.
 * `out` starts as the stored definition and ends as the new one; `changed`
 * lists the fields that differ (an empty list is a no-op update).
 */
export function checkFleetScheduleUpdate(
    raw: {
        name?: unknown;
        nodeId?: unknown;
        command?: unknown;
        cwd?: unknown;
        cadence?: unknown;
        kind?: unknown;
        prompt?: unknown;
        agentId?: unknown;
    },
    out: FleetScheduleShape,
    changed: Array<keyof FleetScheduleShape>,
): FleetScheduleRefusal {
    if (raw.kind !== undefined || raw.prompt !== undefined || raw.agentId !== undefined) {
        return refuse(
            'invalid',
            'a command schedule stays a command schedule; create a new one instead',
            {
                field: 'kind',
            },
        );
    }
    if (raw.name !== undefined) {
        const name = checkName(raw.name);
        if (name.refusal) return name.refusal;
        if (name.name !== out.name) {
            out.name = name.name as string;
            changed.push('name');
        }
    }
    if (raw.nodeId !== undefined) {
        const node = checkNode({ nodeId: raw.nodeId });
        if (node.refusal) return node.refusal;
        if (node.nodeId !== out.nodeId) {
            out.nodeId = node.nodeId as string;
            changed.push('nodeId');
        }
    }
    if (raw.command !== undefined) {
        const command = checkCommand(raw.command);
        if (command) return command;
        if (raw.command !== out.command) {
            out.command = raw.command as string;
            changed.push('command');
        }
    }
    if (raw.cwd !== undefined) {
        const cwd = checkCwd(raw.cwd);
        if (cwd.refusal) return cwd.refusal;
        if (cwd.cwd !== out.cwd) {
            out.cwd = cwd.cwd;
            changed.push('cwd');
        }
    }
    if (raw.cadence !== undefined) {
        const cadence = checkCadence(raw.cadence);
        if (cadence.refusal) return cadence.refusal;
        if (JSON.stringify(cadence.cadence) !== JSON.stringify(out.cadence)) {
            out.cadence = cadence.cadence as FleetScheduleCadence;
            changed.push('cadence');
        }
    }
    return null;
}

/**
 * The command line tripped the secret scanner. A schedule's line must be
 * STORED to be synced again on every link open, and the platform never
 * stores a secret — so the save is refused with a way out (lane-log decision 5).
 */
export function fleetScheduleSecretRefusal(): FleetLinkError {
    return refuse(
        'invalid',
        'the command looks like it contains a secret; keep it in a file or an environment variable on the computer and refer to that instead',
        { field: 'command' },
    );
}

/** May this person write one more schedule now (CONTRACTS §10.1: 30 a minute)? */
export function checkFleetScheduleWriteRate(lastMinute: number): FleetScheduleRefusal {
    if (lastMinute >= FLEET_SCHEDULE_WRITES_PER_MINUTE) {
        return refuse(
            'limit_exceeded',
            `at most ${FLEET_SCHEDULE_WRITES_PER_MINUTE} schedule changes a minute; try again shortly`,
            { limit: FLEET_SCHEDULE_WRITES_PER_MINUTE },
        );
    }
    return null;
}

/** May one more schedule land on this computer (CONTRACTS §10: 50; the 51st is refused, FR-5)? */
export function checkFleetSchedulesPerNode(held: number, nodeName: string): FleetScheduleRefusal {
    if (held >= FLEET_SCHEDULES_PER_NODE) {
        return refuse(
            'limit_exceeded',
            `${nodeName} already holds ${FLEET_SCHEDULES_PER_NODE} schedules; delete one first`,
            { limit: FLEET_SCHEDULES_PER_NODE },
        );
    }
    return null;
}

/**
 * May this computer hold a Command schedule at all? Only an enrolled
 * command-line node does: a cluster node runs no commands, and the desktop
 * app's node does not run schedules yet (R-10). Offline and missing-consent
 * computers DO save (spec U1, U2) — they read NEVER RUNS or "will sync".
 */
export function fleetScheduleNodeRefusal(node: {
    name: string;
    kind: string;
    status: string;
}): FleetScheduleRefusal {
    if (node.kind === 'k8s') {
        return refuse(
            'unsupported_on_node',
            `${node.name} is a cluster node; schedules run on computers`,
        );
    }
    if (node.kind === 'desktop-node') {
        return refuse(
            'unsupported_on_node',
            `schedules are not available on this kind of node yet (${node.name})`,
        );
    }
    if (node.status === 'enrolling')
        return refuse('busy', `${node.name} has not finished enrolling`);
    return null;
}

/**
 * Why a saved schedule would never run on its computer (FR-21), first
 * reason wins: the computer was removed (repair: move it), the node is older
 * than schedules (update it), or it was not started with `--manage` (only
 * its owner can fix that). Null when it can run.
 */
export function fleetScheduleNeverRuns(facts: {
    nodeExists: boolean;
    nodeName: string;
    unsupported: boolean;
    consents: FleetConsents | null;
}): { reason: FleetScheduleNeverRunsReason; hint: string } | null {
    let reason: FleetScheduleNeverRunsReason | null = null;
    if (!facts.nodeExists) reason = 'node-removed';
    else if (facts.unsupported) reason = 'node-unsupported';
    else if (!fleetConsentSatisfies(facts.consents, 'manage')) reason = 'consent-missing';
    if (!reason) return null;
    return { reason, hint: fleetScheduleNeverRunsHint(reason, facts.nodeName) };
}

/** `PowerShell` on Windows, else `the login shell` (the confirmation's words, FR-25). */
export function fleetScheduleShellLabel(platform: string | null | undefined): string {
    const os = (platform ?? '').split('/')[0].trim().toLowerCase();
    return os === 'win32' || os === 'windows' ? 'PowerShell' : 'the login shell';
}
