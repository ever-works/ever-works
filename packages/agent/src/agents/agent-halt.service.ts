import { Injectable, Logger } from '@nestjs/common';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentHaltReason, AgentStatus, type AgentHaltDetail } from '../entities/agent.entity';

/**
 * AW-23 — the one place an agent's stop is turned into a RECORD.
 *
 * Today the platform knows why an agent stopped in every case — a person
 * pressed Pause, a run failed n times, a provider rejected a
 * credential — and it persists none of it. The one place the reason
 * exists is a raw error string on the newest failed run, which nothing
 * links to from the agent. This service writes the reason at the moment
 * it is true, with its time, its author and its run, so the card can
 * state it rather than recompute a story out of run history.
 *
 * It adds NO status member and NO transition. `halt()` moves the agent to
 * the EXISTING `paused` status through the repository's existing CAS
 * primitive — the same primitive the dispatcher already uses for
 * automatic transitions — and records the reason alongside it.
 *
 * 🛑 Nothing written here may carry a credential. `detail.subjectLabel`
 * is a display name resolved by the caller through the facade the failing
 * call already went through; no raw provider error body, no token
 * fragment and no plugin id ever reaches this service.
 */

/** Everything a halt can say about itself. Every field is optional. */
export interface AgentHaltInput {
    /** The human note from the pause dialog. Secret-scanned by the caller. */
    note?: string | null;
    /** Who pressed Pause. Absent for every automatic halt. */
    byUserId?: string | null;
    /** The run behind an automatic halt. */
    runId?: string | null;
    /** Display name + coarse kind of whatever refused the agent. */
    detail?: AgentHaltDetail | null;
}

export interface AgentHaltResult {
    /**
     * False when the agent was ALREADY halted for this same reason: a
     * stale tab re-posting a pause is a no-op that preserves the first
     * note, time and author — and tells the caller not to write a second
     * activity row either.
     */
    written: boolean;
    /** Consecutive halts carrying this reason. `2` is what the card reports. */
    repeatCount: number;
    /** True when THIS call moved the agent's status to `paused`. */
    transitioned: boolean;
}

@Injectable()
export class AgentHaltService {
    private readonly logger = new Logger(AgentHaltService.name);

    constructor(private readonly agents: AgentRepository) {}

    /**
     * Record why this agent stopped, and stop it.
     *
     * Order matters: the halt record is written FIRST and the status
     * transition follows. A transition that lands without its reason is a
     * degraded label ("Paused by you" with no time); a reason that lands
     * without its transition would be an outright lie — the agent would
     * claim to be stopped while still picking work up.
     *
     * An agent that is already `archived` is left alone: archived is the
     * one terminal status, and halting it would invent a transition this
     * epic promised not to add.
     */
    async halt(
        agentId: string,
        reason: AgentHaltReason,
        input: AgentHaltInput = {},
    ): Promise<AgentHaltResult> {
        const agent = await this.agents.findById(agentId);
        if (!agent) return { written: false, repeatCount: 0, transitioned: false };
        if (agent.status === AgentStatus.ARCHIVED) {
            return { written: false, repeatCount: agent.haltRepeatCount ?? 0, transitioned: false };
        }

        // Consecutive-halt bookkeeping. `haltRepeatReason` outlives a
        // resume precisely so this comparison still works after one: an
        // agent resumed without its credential being fixed halts again
        // and the card says so, instead of the loop staying mysterious.
        const sameReasonAsBefore = agent.haltRepeatReason === reason;
        const repeatCount = sameReasonAsBefore ? (agent.haltRepeatCount ?? 0) + 1 : 1;

        const written = await this.agents.writeHalt(agentId, {
            haltReason: reason,
            haltNote: input.note ?? null,
            haltedAt: new Date(),
            haltedByUserId: input.byUserId ?? null,
            haltedRunId: input.runId ?? null,
            haltDetail: input.detail ?? null,
            haltRepeatCount: repeatCount,
        });

        let transitioned = false;
        if (agent.status !== AgentStatus.PAUSED) {
            try {
                transitioned = await this.agents.transitionStatus(
                    agentId,
                    agent.status,
                    AgentStatus.PAUSED,
                );
            } catch (err) {
                // A failed transition is the serious half. Surface it —
                // the caller decides whether that is fatal for its flow.
                this.logger.warn(
                    `Agent ${agentId}: halt recorded (${reason}) but the status transition failed: ${err}`,
                );
            }
        }

        return {
            written,
            repeatCount: written ? repeatCount : (agent.haltRepeatCount ?? 0),
            transitioned,
        };
    }

    /**
     * Forget why the agent stopped. Called on resume, on activation from
     * draft and on unarchive — and at nowhere else, so a reason survives
     * for exactly as long as it is true.
     *
     * Best-effort: a resume must never fail because the reason could not
     * be cleared. A stale reason on an ACTIVE agent is invisible anyway —
     * the status resolver only consults it while the agent is paused.
     */
    async clear(agentId: string): Promise<void> {
        try {
            await this.agents.clearHalt(agentId);
        } catch (err) {
            this.logger.warn(`Agent ${agentId}: failed to clear the halt reason: ${err}`);
        }
    }
}
