import {
    FLEET_AGENT_SESSION_LEASE_TTL_SEC,
    fleetAgentSessionRequiredCapabilities,
    type FleetAgentSessionPayload,
} from '@ever-works/contracts';

/**
 * Sessions on computers (FL-04 P2, CONTRACTS R-28) — the dispatch port for the
 * `agent-session` fleet job; the twin of `computer-session.dispatcher.ts`.
 *
 * The agent package declares the contract; the API binds it to the node
 * job-runtime plugin's dispatcher factory, so idempotency, capability tags and
 * the rest of the enqueue options follow the one set of semantics every
 * fleet job has. `@Optional()` in the session service: an install with no
 * fleet runtime wired answers "this deployment does not run Agent sessions"
 * instead of failing to boot.
 */
export const AGENT_SESSION_DISPATCHER = 'AGENT_SESSION_DISPATCHER' as const;

/** The key that makes "one job per session" hold however often the enqueue is re-sent. */
export function agentSessionIdempotencyKey(fleetSessionId: string): string {
    return `fleet-session:${fleetSessionId}`;
}

export interface AgentSessionDispatchInput {
    payload: FleetAgentSessionPayload;
    userId: string;
    organizationId: string | null;
}

export interface AgentSessionDispatcher {
    /** Enqueue the job; resolves with the fleet job id. */
    enqueue(input: AgentSessionDispatchInput): Promise<{ jobId: string }>;
    /**
     * Withdraw the session's job (queued → dropped, claimed → the node ends the
     * session on its next keep-alive). False when it could not be delivered.
     */
    cancelForSession?(fleetSessionId: string): Promise<boolean>;
}

/** The fleet enqueue a session becomes — kind, owner, payload, the pinned node and the tags. */
export interface AgentSessionEnqueueRequest {
    kind: 'agent-session';
    userId: string;
    organizationId: string | null;
    payload: Record<string, unknown>;
    /** `sessions` and the CLI's tag (`claude-code` / `codex`). */
    requiredCapabilities: string[];
    /** A session is never retried onto a second attempt: a new session is a new start. */
    maxAttempts: 1;
    idempotencyKey: string;
    leaseTtlSec: number;
}

/**
 * The job payload, built field by field so nothing a caller attaches by
 * accident travels to the machine. `nodeId` is what the fleet pins the job
 * to; the first message travels already redacted.
 */
export function buildAgentSessionJobPayload(
    payload: FleetAgentSessionPayload,
): Record<string, unknown> {
    return {
        fleetSessionId: payload.fleetSessionId,
        agentId: payload.agentId,
        agentRunId: payload.agentRunId,
        nodeId: payload.nodeId,
        provider: payload.provider,
        cwd: payload.cwd,
        title: payload.title,
        firstMessage: payload.firstMessage,
        cols: payload.cols,
        rows: payload.rows,
        permissionMode: payload.permissionMode,
        leaseTtlSec: payload.leaseTtlSec || FLEET_AGENT_SESSION_LEASE_TTL_SEC,
    };
}

export function buildAgentSessionEnqueueRequest(
    input: AgentSessionDispatchInput,
): AgentSessionEnqueueRequest {
    return {
        kind: 'agent-session',
        userId: input.userId,
        organizationId: input.organizationId ?? null,
        payload: buildAgentSessionJobPayload(input.payload),
        requiredCapabilities: fleetAgentSessionRequiredCapabilities(input.payload.provider),
        maxAttempts: 1,
        idempotencyKey: agentSessionIdempotencyKey(input.payload.fleetSessionId),
        leaseTtlSec: input.payload.leaseTtlSec || FLEET_AGENT_SESSION_LEASE_TTL_SEC,
    };
}
