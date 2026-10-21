import {
    fleetConsentMissingHint,
    fleetConsentSatisfies,
    fleetSessionConsentFor,
    fleetSessionOutcomeForExit,
    FLEET_SESSION_MAX_OWNER_PER_NODE,
    FLEET_SESSION_MAX_VIEWERS,
    FLEET_SESSION_PROVIDER_CAPABILITY,
    FLEET_SESSIONS_CAPABILITY,
    isFleetSessionLive,
    type FleetConsents,
    type FleetLinkError,
    type FleetSessionDaemonReport,
    type FleetSessionEndedReason,
    type FleetSessionEventMessage,
    type FleetSessionKind,
    type FleetSessionOutcome,
    type FleetSessionStartableProvider,
    type FleetSessionState,
} from '@ever-works/contracts';

/**
 * Sessions on computers (FL-04) — the pure rules: who may start what where,
 * and how a session's row moves when the node reports evidence. No Nest, no
 * TypeORM, no clock of its own: every input is a fact handed in, so the
 * truth tables (spec §3.2, CONTRACTS §5.1, §8, §10) are testable on their own.
 *
 * A refusal is a VALUE — the CONTRACTS §8 error (`{ code, hint, details }`)
 * with a hint a person can act on — and `null` means allowed. Never a throw
 * (the posture of the terminal launcher), and never a discriminated union:
 * this package compiles without `strictNullChecks`, under which such unions
 * do not narrow.
 */

/** `null` = allowed; otherwise the first refusal. */
export type FleetSessionRefusal = FleetLinkError | null;

const refuse = (
    code: FleetLinkError['code'],
    hint: string,
    details?: Record<string, unknown>,
): FleetLinkError => (details ? { code, hint, details } : { code, hint });

/** A live owner session as a limit refusal lists it (spec U7). */
export interface FleetSessionListing {
    id: string;
    title: string;
    startedBy: string;
    startedAt: string | null;
}

/** Everything a start decision reads — gathered by the service, judged here. */
export interface FleetSessionStartFacts {
    node: {
        name: string;
        status: string;
        kind: string;
        capabilities: readonly string[] | null;
        lastHeartbeatAt: Date | string | null;
        sessionDaemon: FleetSessionDaemonReport | null;
    };
    /** What the node's live link presented, else what its last heartbeat stored. */
    consents: FleetConsents;
    kind: FleetSessionKind;
    provider: FleetSessionStartableProvider;
    killSwitchOn: boolean;
    /** The platform holds the node's link right now. */
    linkConnected: boolean;
    /** Live owner sessions already on this Node. */
    liveOwnerSessions: readonly FleetSessionListing[];
    /** When the node was last heard, as a person reads it (`12 min`), or null. */
    lastSeenAgo: string | null;
}

/** Display names for the providers, in hints. */
export const FLEET_SESSION_PROVIDER_LABELS: Readonly<
    Record<FleetSessionStartableProvider, string>
> = {
    shell: 'A shell',
    'claude-code': 'Claude Code',
    codex: 'Codex',
};

/**
 * May this session start on this Node? First refusal wins, in this order
 * (the family audience was already checked by the caller, before any of
 * these facts were read — a stranger never learns them):
 *
 *  1. kill switch — `kill_switch`;
 *  2. the Node's own state (paused, disabled, enrolling) — `busy`, naming it (FR-39);
 *  3. consent — owner sessions need `manage`, Agent sessions `work` (R-5, FR-13, FR-46);
 *  4. reachability — `unreachable` with when it was last seen (U4);
 *  5. the daemon — no `sessions` tag → `unsupported_on_node` with the node's own reason (U3);
 *  6. the provider — its CLI tag absent → `unsupported_on_node` (FR-14);
 *  7. the limit — the ninth owner session → `limit_exceeded`, listing the eight (FR-16, U7).
 *
 * Agent sessions are not limited here: they queue against the node's
 * `--concurrency` like any job (CONTRACTS §10, R-28 — P2).
 */
export function canStartFleetSession(facts: FleetSessionStartFacts): FleetSessionRefusal {
    const { node } = facts;
    if (facts.killSwitchOn) return refuse('kill_switch', 'clear it under Settings → Fleet');

    if (node.kind === 'k8s') {
        return refuse(
            'unsupported_on_node',
            `${node.name} is a cluster node; sessions run on computers`,
        );
    }
    if (node.status === 'paused' || node.status === 'disabled' || node.status === 'enrolling') {
        const words: Record<string, string> = {
            paused: `${node.name} is paused — resume it to start sessions`,
            disabled: `${node.name} is disabled — enable it to start sessions`,
            enrolling: `${node.name} has not finished enrolling`,
        };
        return refuse('busy', words[node.status], { nodeState: node.status });
    }

    const consent = fleetSessionConsentFor(facts.kind);
    if (!fleetConsentSatisfies(facts.consents, consent)) {
        return refuse('consent_missing', fleetConsentMissingHint(consent, node.name), {
            consent,
            kind: facts.kind,
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

    const tags = node.capabilities ?? [];
    if (!tags.includes(FLEET_SESSIONS_CAPABILITY)) {
        const reason = node.sessionDaemon?.reason;
        return refuse(
            'unsupported_on_node',
            reason
                ? `the session daemon is not running on ${node.name} — ${reason}`
                : `the session daemon is not running on ${node.name}`,
            { daemon: node.sessionDaemon?.state ?? 'unknown' },
        );
    }

    const providerTag = FLEET_SESSION_PROVIDER_CAPABILITY[facts.provider];
    if (providerTag && !tags.includes(providerTag)) {
        return refuse(
            'unsupported_on_node',
            `${FLEET_SESSION_PROVIDER_LABELS[facts.provider]} is not installed on ${node.name}`,
            { provider: facts.provider },
        );
    }

    if (
        facts.kind === 'owner' &&
        facts.liveOwnerSessions.length >= FLEET_SESSION_MAX_OWNER_PER_NODE
    ) {
        return refuse(
            'limit_exceeded',
            `${node.name} already has ${facts.liveOwnerSessions.length} sessions. End one to start another.`,
            {
                limit: FLEET_SESSION_MAX_OWNER_PER_NODE,
                sessions: facts.liveOwnerSessions.map((session) => ({ ...session })),
            },
        );
    }
    return null;
}

/** Facts for an attach decision. */
export interface FleetSessionAttachFacts {
    state: FleetSessionState;
    killSwitchOn: boolean;
    linkConnected: boolean;
    nodeName: string;
    /** People attached right now (names when known, else ids) — the five a refusal names (U8). */
    attached: readonly string[];
}

/**
 * May one more viewer attach? (The family audience and the role were
 * decided by the caller.) Ended sessions are not attachable — their detail
 * shows the kept last screen instead.
 */
export function canAttachFleetSession(facts: FleetSessionAttachFacts): FleetSessionRefusal {
    if (facts.killSwitchOn) return refuse('kill_switch', 'clear it under Settings → Fleet');
    if (!isFleetSessionLive(facts.state)) {
        return refuse('invalid', 'the session has ended; its last screen is on its page', {
            state: facts.state,
        });
    }
    if (!facts.linkConnected) return refuse('unreachable', `${facts.nodeName} is not connected`);
    if (facts.attached.length >= FLEET_SESSION_MAX_VIEWERS) {
        return refuse(
            'limit_exceeded',
            `This session already has ${facts.attached.length} watchers.`,
            { limit: FLEET_SESSION_MAX_VIEWERS, watchers: [...facts.attached] },
        );
    }
    return null;
}

// ─── State transitions (CONTRACTS §5.1) ─────────────────────────────────────

/** The columns a transition reads. */
export interface FleetSessionRowFacts {
    state: FleetSessionState;
    outcome: FleetSessionOutcome | null;
    endedReason: FleetSessionEndedReason | null;
    title: string;
    startedAt: Date | null;
    lastScreen: string | null;
    exitCode: number | null;
}

/** The columns a transition writes (only those that change). */
export interface FleetSessionPatch {
    state?: FleetSessionState;
    outcome?: FleetSessionOutcome | null;
    endedReason?: FleetSessionEndedReason | null;
    endedAt?: Date;
    startedAt?: Date;
    lastActivityAt?: Date;
    title?: string;
    lastScreen?: string;
    exitCode?: number | null;
}

/**
 * The outcome an end proves (set once): somebody ending it is a
 * cancellation; an exit is the exit code's verdict; a loss or a start that
 * never confirmed is `unconfirmed` — absence of evidence is never success.
 */
export function fleetSessionOutcomeForEnd(
    reason: FleetSessionEndedReason,
    exitCode: number | null | undefined,
): FleetSessionOutcome {
    switch (reason) {
        case 'user':
        case 'agent':
        case 'drain':
        case 'kill-switch':
            return 'cancelled';
        case 'exit':
            return fleetSessionOutcomeForExit(exitCode);
        case 'node-restart':
        case 'timeout':
        default:
            return 'unconfirmed';
    }
}

/** The patch that ends a live row (`* → ended`), or null when it already ended. */
export function endFleetSessionPatch(
    row: FleetSessionRowFacts,
    reason: FleetSessionEndedReason,
    now: Date,
    evidence: { exitCode?: number | null; screen?: string } = {},
): FleetSessionPatch | null {
    if (!isFleetSessionLive(row.state)) return null;
    const patch: FleetSessionPatch = {
        state: 'ended',
        endedReason: reason,
        endedAt: now,
    };
    if (row.outcome === null) patch.outcome = fleetSessionOutcomeForEnd(reason, evidence.exitCode);
    if (evidence.exitCode !== undefined) patch.exitCode = evidence.exitCode;
    if (evidence.screen !== undefined) patch.lastScreen = evidence.screen;
    return patch;
}

/**
 * Apply one node event to a row (CONTRACTS §5.1, spec FR-9, FR-11, U13, U14).
 * Returns the patch to write, or null when the event changes nothing.
 *
 *  - `started` — `starting → working`; `startedAt` stamped once.
 *  - `activity` — `lastActivityAt`; `idle → working` (silence never ends a session).
 *  - `title` — the daemon's title (a rename the node applied).
 *  - `exited` — `ended`, with the exit code and the last screen; the reason is
 *    the one the node names (`user`, `drain`, `kill-switch`), else `exit`.
 *  - `lost` — `ended (node-restart)` with the last persisted screen.
 *
 * An ENDED row is terminal: a late `exited` only fills in what the end did
 * not know yet (the exit code and the screen — an end the user asked for
 * lands before the process is gone), never its reason or outcome.
 */
export function applyFleetSessionEvent(
    row: FleetSessionRowFacts,
    event: Pick<FleetSessionEventMessage, 'event' | 'exitCode' | 'title' | 'screen' | 'reason'>,
    now: Date,
): FleetSessionPatch | null {
    const live = isFleetSessionLive(row.state);
    switch (event.event) {
        case 'started': {
            if (!live) return null;
            const patch: FleetSessionPatch = { lastActivityAt: now };
            if (row.state === 'starting') patch.state = 'working';
            if (!row.startedAt) patch.startedAt = now;
            return patch;
        }
        case 'activity': {
            if (!live) return null;
            const patch: FleetSessionPatch = { lastActivityAt: now };
            if (row.state === 'idle' || row.state === 'starting') patch.state = 'working';
            if (row.state === 'starting' && !row.startedAt) patch.startedAt = now;
            return patch;
        }
        case 'title': {
            if (!live || !event.title || event.title === row.title) return null;
            return { title: event.title };
        }
        case 'exited':
        case 'lost': {
            const exitCode = event.event === 'exited' ? (event.exitCode ?? null) : null;
            if (live) {
                const reason: FleetSessionEndedReason =
                    event.event === 'lost' ? 'node-restart' : (event.reason ?? 'exit');
                return endFleetSessionPatch(row, reason, now, {
                    exitCode,
                    ...(event.screen !== undefined ? { screen: event.screen } : {}),
                });
            }
            // Already ended: fill in the facts the end could not know yet.
            const patch: FleetSessionPatch = {};
            if (row.exitCode === null && typeof exitCode === 'number') patch.exitCode = exitCode;
            if (row.lastScreen === null && event.screen !== undefined)
                patch.lastScreen = event.screen;
            return Object.keys(patch).length > 0 ? patch : null;
        }
        default:
            return null;
    }
}
