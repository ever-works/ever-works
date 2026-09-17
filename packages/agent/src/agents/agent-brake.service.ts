import { Injectable, Logger } from '@nestjs/common';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentStatus } from '../entities/agent.entity';
import type { AgentBrakeVerdict, RunAgentBrake } from './run-agent-brake';

/**
 * AW-23 — the implementation behind {@link RUN_AGENT_BRAKE}.
 *
 * One indexed read of an agent's `status` (and its stored halt reason,
 * for the run-log line) by primary key, per admission. That is the whole
 * cost of making Pause bind on every dispatch path instead of one.
 *
 * 🛑 FAIL CLOSED. A read that throws is folded into `halted: true` HERE
 * as well as at the middleware, so both layers agree and neither depends
 * on the other: if the platform cannot determine whether an agent is
 * paused, the work is parked rather than run. An unreadable brake that
 * let work through would break the exact promise the control makes.
 *
 * An agent that no longer exists is NOT halted: nothing can be paused
 * that is not there, and refusing would turn a missing-agent bug into a
 * silent, permanent park with no surface to unpause.
 */
@Injectable()
export class AgentBrakeService implements RunAgentBrake {
    private readonly logger = new Logger(AgentBrakeService.name);

    constructor(private readonly agents: AgentRepository) {}

    async shouldHaltForAgent(agentId: string): Promise<AgentBrakeVerdict> {
        if (!agentId) return { halted: false };
        try {
            const agent = await this.agents.findById(agentId);
            if (!agent) return { halted: false };
            // `paused` and `archived` are the two statuses that mean "do
            // not pick anything new up". `error` deliberately does NOT
            // park: an errored agent is still resumable by its own
            // schedule dispatcher today, and turning that into a park
            // would change behaviour this epic promised to leave alone.
            const halted =
                agent.status === AgentStatus.PAUSED || agent.status === AgentStatus.ARCHIVED;
            if (!halted) return { halted: false };
            const verdict: AgentBrakeVerdict = { halted: true };
            if (agent.haltReason) verdict.reason = agent.haltReason;
            return verdict;
        } catch (err) {
            this.logger.warn(
                `Agent brake: could not read agent ${agentId} — holding the run (fail-closed): ${err}`,
            );
            return { halted: true };
        }
    }
}
