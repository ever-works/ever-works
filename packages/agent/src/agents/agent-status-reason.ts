import type { AgentStatusDto, AgentStatusReasonCode } from '@ever-works/contracts';
import { AgentHaltReason, AgentStatus } from '../entities/agent.entity';

/**
 * AW-23 — the one place "what is this agent doing, and why is it not
 * working?" is answered.
 *
 * PURE: no Nest decorators, no repository, no IO. Everything it needs
 * arrives as an argument, which is what lets the full identity card, the
 * compact card on a list and the batched roster poll all call the SAME
 * function server-side. That is what makes "the two can never disagree" a
 * structural fact instead of a promise — the alternative (each surface
 * deriving its own story in the browser) is exactly the drift that leaves
 * one screen saying "Idle" while another says "Error".
 *
 * Nothing here is stored. The halt REASON is persisted at the moment an
 * agent stops (`agents.haltReason` and friends); the STATUS reason below
 * is computed from it per request.
 */

/** Everything the resolver reads. All of it is already loaded by the caller. */
export interface AgentStatusReasonInput {
    status: AgentStatus | string;
    haltReason?: AgentHaltReason | string | null;
    haltNote?: string | null;
    haltedAt?: Date | null;
    haltedRunId?: string | null;
    haltRepeatCount?: number | null;
    haltSubjectLabel?: string | null;
    /** The run in flight right now, if any. */
    inFlightRunId?: string | null;
    inFlightActivity?: string | null;
    inFlightStartedAt?: Date | null;
    /** Runs still finishing (a pause lets them finish). */
    inFlightCount?: number | null;
    /** Runs parked because this agent is stopped. */
    heldCount?: number | null;
    /** Open escalations + pending approval proposals. */
    openDecisionCount?: number | null;
    /**
     * The oldest open decision, when the caller resolved one. Absent, the
     * surface links to the decisions queue filtered to this agent rather
     * than to a specific row — the reason still links somewhere.
     */
    openDecisionId?: string | null;
    /** The newest failed run, for the one-click link out of `stoppedByFailures`. */
    lastFailedRunId?: string | null;
    consecutiveFailures?: number | null;
    nextHeartbeatAt?: Date | null;
    lastRunAt?: Date | null;
}

/** How a halt reason maps onto the reason a person reads. */
const HALT_REASON_TO_STATUS: Record<string, AgentStatusReasonCode> = {
    [AgentHaltReason.CREDENTIAL]: 'blockedOnCredential',
    [AgentHaltReason.CAP]: 'stoppedAtACap',
    [AgentHaltReason.PLATFORM]: 'stoppedByThePlatform',
    [AgentHaltReason.FAILURES]: 'stoppedByFailures',
    [AgentHaltReason.USER]: 'pausedByYou',
};

/** The reasons that mean "this agent is stopped right now". */
const HALTED_REASONS: ReadonlySet<AgentStatusReasonCode> = new Set<AgentStatusReasonCode>([
    'pausedByYou',
    'blockedOnCredential',
    'stoppedByFailures',
    'stoppedAtACap',
    'stoppedByThePlatform',
]);

function nonNegative(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function iso(value: Date | null | undefined): string | null {
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;
}

/**
 * Which reason applies, evaluated top to bottom. The ORDER is the whole
 * design; every case below is exercised in precedence order by the spec.
 *
 *  1. `archived`              — retired beats everything. An archived agent
 *                               is not idle, paused or broken; it is out.
 *  2. `working`               — a live run outranks an open decision: what
 *                               the agent is doing RIGHT NOW is the more
 *                               useful sentence, and the decision is still
 *                               one click away in the queue.
 *  3-6. the halt reasons      — a paused agent states WHY it is paused.
 *                               An agent paused before this shipped has no
 *                               stored reason and still reads "Paused by
 *                               you", which is the truth about it.
 *  7. `stoppedByFailures`     — `status = error` with no stored reason.
 *  8. `waitingOnYou`          — nothing running, but something needs a
 *                               person.
 *  9. `notStarted`            — a draft agent, or one that has never run.
 * 10. `idle`                  — nothing wrong, nothing running.
 */
export function resolveAgentStatusReason(input: AgentStatusReasonInput): AgentStatusReasonCode {
    if (input.status === AgentStatus.ARCHIVED) return 'archived';
    if (input.status === AgentStatus.RUNNING || input.inFlightRunId) return 'working';
    if (input.status === AgentStatus.PAUSED) {
        const mapped = input.haltReason ? HALT_REASON_TO_STATUS[input.haltReason] : undefined;
        // A halt written as `failures` still transitions the agent to
        // paused, so honour the stored reason rather than the status.
        return mapped ?? 'pausedByYou';
    }
    if (input.status === AgentStatus.ERROR) return 'stoppedByFailures';
    if (nonNegative(input.openDecisionCount) > 0) return 'waitingOnYou';
    if (input.status === AgentStatus.DRAFT || !input.lastRunAt) return 'notStarted';
    return 'idle';
}

/**
 * The reason plus everything a surface needs to render its sentence and
 * its one action link — the link kind and id included, so no client has
 * to know which reason links where.
 *
 * `agentId` is supplied by the caller; every other field is derived here.
 */
export function buildAgentStatus(agentId: string, input: AgentStatusReasonInput): AgentStatusDto {
    const reason = resolveAgentStatusReason(input);
    const status: AgentStatusDto = {
        agentId,
        reason,
        inFlightCount: nonNegative(input.inFlightCount),
        heldCount: nonNegative(input.heldCount),
    };

    // The repeat counter OUTLIVES a resume (that is what makes a
    // halt/resume loop visible), so it is reported only while the agent
    // is actually stopped — an idle agent must never carry the ghost of
    // a halt it has recovered from.
    const repeatCount = HALTED_REASONS.has(reason) ? nonNegative(input.haltRepeatCount) : 0;
    if (repeatCount > 0) status.repeatCount = repeatCount;

    switch (reason) {
        case 'working': {
            const startedAt = iso(input.inFlightStartedAt);
            if (startedAt) status.since = startedAt;
            status.activity = input.inFlightActivity ?? null;
            if (input.inFlightRunId) {
                status.linkKind = 'run';
                status.linkId = input.inFlightRunId;
            }
            break;
        }
        case 'pausedByYou': {
            status.since = iso(input.haltedAt);
            status.note = input.haltNote ?? null;
            break;
        }
        case 'blockedOnCredential': {
            status.since = iso(input.haltedAt);
            // 🛑 A display name only. The classifier never copies any part
            // of the provider's error body into the halt detail, so there
            // is nothing here that could carry a credential.
            status.subjectLabel = input.haltSubjectLabel ?? null;
            if (input.haltedRunId) {
                status.linkKind = 'run';
                status.linkId = input.haltedRunId;
            }
            break;
        }
        case 'stoppedByFailures': {
            status.since = iso(input.haltedAt);
            status.failureCount = nonNegative(input.consecutiveFailures);
            const runId = input.haltedRunId ?? input.lastFailedRunId;
            if (runId) {
                status.linkKind = 'run';
                status.linkId = runId;
            }
            break;
        }
        case 'stoppedAtACap':
        case 'stoppedByThePlatform': {
            status.since = iso(input.haltedAt);
            break;
        }
        case 'waitingOnYou': {
            status.openDecisionCount = nonNegative(input.openDecisionCount);
            status.linkKind = 'decision';
            if (input.openDecisionId) status.linkId = input.openDecisionId;
            break;
        }
        case 'idle': {
            status.since = iso(input.nextHeartbeatAt);
            break;
        }
        default:
            break;
    }

    return status;
}
