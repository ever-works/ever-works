import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    AgentEmailAssignment,
    AgentEmailAssignmentDirection,
} from '../../entities/agent-email-assignment.entity';

/**
 * Notifications v2 — Email Providers (EW-650, EW-667).
 *
 * Repository for `agent_email_assignments`. Used by the inbound
 * dispatcher to resolve `(emailAddress, direction='inbound') → Agent`
 * and by the EmailFacade to resolve `(agent, direction='outbound')
 * → primary outbound address`.
 */
@Injectable()
export class AgentEmailAssignmentRepository {
    constructor(
        @InjectRepository(AgentEmailAssignment)
        private readonly repository: Repository<AgentEmailAssignment>,
    ) {}

    create(entry: Partial<AgentEmailAssignment>): AgentEmailAssignment {
        return this.repository.create(entry);
    }

    async save(entry: AgentEmailAssignment): Promise<AgentEmailAssignment> {
        return this.repository.save(entry);
    }

    async findByAgent(
        agentId: string,
        direction?: AgentEmailAssignmentDirection,
    ): Promise<AgentEmailAssignment[]> {
        const where: Record<string, unknown> = { agentId };
        if (direction) {
            where.direction = direction;
        }
        return this.repository.find({
            where,
            order: { priority: 'ASC', createdAt: 'ASC' },
            relations: ['emailAddress'],
        });
    }

    async findByEmailAddress(
        emailAddressId: string,
        direction?: AgentEmailAssignmentDirection,
    ): Promise<AgentEmailAssignment[]> {
        const where: Record<string, unknown> = { emailAddressId };
        if (direction) {
            where.direction = direction;
        }
        return this.repository.find({
            where,
            order: { priority: 'ASC', createdAt: 'ASC' },
        });
    }

    /** Primary (lowest-priority) outbound assignment for an Agent. */
    async findPrimaryOutboundForAgent(agentId: string): Promise<AgentEmailAssignment | null> {
        const rows = await this.findByAgent(agentId, 'outbound');
        return rows[0] ?? null;
    }

    async delete(id: string): Promise<void> {
        await this.repository.delete({ id });
    }
}
