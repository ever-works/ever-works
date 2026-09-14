import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentInbox } from '../../entities/agent-inbox.entity';

/**
 * Agent email (AW-05) — repository for `agent_inboxes`, the per-Agent
 * approval mode and send ceilings.
 *
 * Every lookup a person can trigger is owner-scoped (`...ForUser`): a
 * foreign id finds nothing, which the API turns into the same 404 a missing
 * id gets. `findByAgent` is unscoped on purpose — it serves the send path,
 * which is keyed on an Agent id the server already resolved.
 */
@Injectable()
export class AgentInboxRepository {
    constructor(
        @InjectRepository(AgentInbox)
        private readonly repository: Repository<AgentInbox>,
    ) {}

    create(entry: Partial<AgentInbox>): AgentInbox {
        return this.repository.create(entry);
    }

    async save(entry: AgentInbox): Promise<AgentInbox> {
        return this.repository.save(entry);
    }

    async findByAgent(agentId: string): Promise<AgentInbox | null> {
        return this.repository.findOne({ where: { agentId } });
    }

    async findByAgentForUser(agentId: string, userId: string): Promise<AgentInbox | null> {
        return this.repository.findOne({ where: { agentId, userId } });
    }

    async findByIdForUser(id: string, userId: string): Promise<AgentInbox | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    async listForUser(userId: string): Promise<AgentInbox[]> {
        return this.repository.find({ where: { userId }, order: { createdAt: 'ASC' } });
    }

    async setCapPausedUntil(id: string, until: Date | null): Promise<void> {
        await this.repository.update({ id }, { capPausedUntil: until });
    }
}
