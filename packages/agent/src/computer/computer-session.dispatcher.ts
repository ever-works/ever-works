import type { ComputerChannel, ComputerQuality } from '@ever-works/contracts';
import { requiredCapabilitiesForChannels } from './computer-session.policy';

/**
 * Agent computers — the dispatch port for the `computer-session` fleet job.
 *
 * The agent package declares the contract and the API binds it to the
 * node job-runtime plugin's dispatcher factory, the same way the agent-run
 * path reaches the fleet — so idempotency, capability tags and the rest of
 * the enqueue options follow the one set of semantics that factory already
 * applies. Nothing here imports a runtime: the session service depends on
 * this token, injected `@Optional()`, so an install with no fleet runtime
 * wired reports "unavailable" instead of failing to boot.
 */
export const COMPUTER_SESSION_DISPATCHER = 'COMPUTER_SESSION_DISPATCHER' as const;

/**
 * How long a node holds a `computer-session` lease between keep-alives, in
 * seconds. A node that stops keeping the lease alive for this long has lost
 * its machine, and the lease protocol reclaims the job.
 */
export const COMPUTER_SESSION_LEASE_TTL_SEC = 120;

/** What the node is handed. No credential, no path — the node resolves both itself. */
export interface ComputerSessionDispatchPayload {
    sessionId: string;
    userId: string;
    organizationId: string | null;
    agentId: string;
    /** The ONE machine allowed to claim this session. */
    nodeId: string;
    /** Opaque id of the Agent's own profile on that machine. */
    profileKey: string;
    channels: ComputerChannel[];
    quality: ComputerQuality;
}

export interface ComputerSessionDispatcher {
    /** Enqueue the job; resolves with the fleet job id. */
    enqueue(payload: ComputerSessionDispatchPayload): Promise<{ jobId: string }>;
    /** Withdraw the job (queued → dropped, claimed → the node aborts). False when it could not be delivered. */
    cancel?(jobId: string): Promise<boolean>;
}

/** The fleet enqueue a session becomes — kind, owner, payload and the derived tags. */
export interface ComputerSessionEnqueueRequest {
    kind: 'computer-session';
    userId: string;
    organizationId: string | null;
    payload: Record<string, unknown>;
    requiredCapabilities: string[];
    /** A live view is never retried onto a second attempt: a new view is a new session. */
    maxAttempts: 1;
    /** One job per session, however often the enqueue is re-sent. */
    idempotencyKey: string;
}

/**
 * The job payload, built field by field so nothing a caller attaches by
 * accident travels to the machine. `nodeId` is what the fleet pins the job
 * to — a session job can only ever be leased by the machine it names.
 */
export function buildComputerSessionJobPayload(
    payload: ComputerSessionDispatchPayload,
): Record<string, unknown> {
    return {
        sessionId: payload.sessionId,
        agentId: payload.agentId,
        nodeId: payload.nodeId,
        profileKey: payload.profileKey,
        channels: [...payload.channels],
        quality: payload.quality,
        leaseTtlSec: COMPUTER_SESSION_LEASE_TTL_SEC,
    };
}

/**
 * The whole enqueue for one session. Required capabilities come from
 * {@link requiredCapabilitiesForChannels} and nowhere else: a terminal-only
 * session never asks for `screen`.
 */
export function buildComputerSessionEnqueueRequest(
    payload: ComputerSessionDispatchPayload,
): ComputerSessionEnqueueRequest {
    return {
        kind: 'computer-session',
        userId: payload.userId,
        organizationId: payload.organizationId ?? null,
        payload: buildComputerSessionJobPayload(payload),
        requiredCapabilities: requiredCapabilitiesForChannels(payload.channels),
        maxAttempts: 1,
        idempotencyKey: `computer-session:${payload.sessionId}`,
    };
}
