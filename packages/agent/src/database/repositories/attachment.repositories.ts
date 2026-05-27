import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MissionAttachment } from '../../entities/mission-attachment.entity';
import { WorkProposalAttachment } from '../../entities/work-proposal-attachment.entity';
import { AgentAttachment } from '../../entities/agent-attachment.entity';

/**
 * Side-table repositories for Mission / Idea (WorkProposal) / Agent
 * attachments. All three share the exact same CRUD shape as
 * {@link TaskAttachmentRepository} — easier to reason about across
 * the four attachment-bearing entity families.
 *
 * Each repository:
 *   - `findByParentId(parentId)` — list attachments for one parent
 *   - `add(parentId, uploadId)` — create the edge; relies on the
 *     unique (parentId, uploadId) index for "already attached" idempotency
 *     (callers can catch the QueryFailedError on the duplicate path)
 *   - `findOne(id)` — fetch one edge (used by detach to validate
 *     ownership before deleting)
 *   - `remove(id)` — drop the edge
 */

@Injectable()
export class MissionAttachmentRepository {
    constructor(
        @InjectRepository(MissionAttachment)
        private readonly repo: Repository<MissionAttachment>,
    ) {}

    async findByMissionId(missionId: string): Promise<MissionAttachment[]> {
        return this.repo.find({ where: { missionId }, order: { createdAt: 'DESC' } });
    }
    async findOne(id: string): Promise<MissionAttachment | null> {
        return this.repo.findOne({ where: { id } });
    }
    async add(missionId: string, uploadId: string): Promise<MissionAttachment> {
        const entity = this.repo.create({ missionId, uploadId });
        return this.repo.save(entity);
    }
    async remove(id: string): Promise<void> {
        await this.repo.delete(id);
    }
}

@Injectable()
export class WorkProposalAttachmentRepository {
    constructor(
        @InjectRepository(WorkProposalAttachment)
        private readonly repo: Repository<WorkProposalAttachment>,
    ) {}

    async findByWorkProposalId(workProposalId: string): Promise<WorkProposalAttachment[]> {
        return this.repo.find({ where: { workProposalId }, order: { createdAt: 'DESC' } });
    }
    async findOne(id: string): Promise<WorkProposalAttachment | null> {
        return this.repo.findOne({ where: { id } });
    }
    async add(workProposalId: string, uploadId: string): Promise<WorkProposalAttachment> {
        const entity = this.repo.create({ workProposalId, uploadId });
        return this.repo.save(entity);
    }
    async remove(id: string): Promise<void> {
        await this.repo.delete(id);
    }
}

@Injectable()
export class AgentAttachmentRepository {
    constructor(
        @InjectRepository(AgentAttachment) private readonly repo: Repository<AgentAttachment>,
    ) {}

    async findByAgentId(agentId: string): Promise<AgentAttachment[]> {
        return this.repo.find({ where: { agentId }, order: { createdAt: 'DESC' } });
    }
    async findOne(id: string): Promise<AgentAttachment | null> {
        return this.repo.findOne({ where: { id } });
    }
    async add(agentId: string, uploadId: string): Promise<AgentAttachment> {
        const entity = this.repo.create({ agentId, uploadId });
        return this.repo.save(entity);
    }
    async remove(id: string): Promise<void> {
        await this.repo.delete(id);
    }
}
