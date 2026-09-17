import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';
import { Agent } from '../entities/agent.entity';
import { Mission } from '../entities/mission.entity';
import { Task } from '../entities/task.entity';
import { Work } from '../entities/work.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { ownershipWhere, type OwnershipScope } from '../database/ownership-scope';
import type { ConversationContextType } from './conversation.types';

/** The object a Conversation is about, as the person can see it. */
export interface ConversationContextSummary {
    type: ConversationContextType;
    id: string;
    label: string;
}

interface ContextTarget {
    entity: EntityTarget<ObjectLiteral>;
    labelColumn: string;
}

/**
 * Where each context type lives. An Idea is a `WorkProposal` row; every other
 * type is the entity of the same name. Each table carries `userId`, `tenantId`
 * and `organizationId`, so one ownership predicate covers all five.
 */
const CONTEXT_TARGETS: Record<ConversationContextType, ContextTarget> = {
    mission: { entity: Mission, labelColumn: 'title' },
    task: { entity: Task, labelColumn: 'title' },
    work: { entity: Work, labelColumn: 'name' },
    idea: { entity: WorkProposal, labelColumn: 'title' },
    agent: { entity: Agent, labelColumn: 'name' },
};

/**
 * Checks that a Conversation's attached object exists AND is visible to the
 * person in their active scope, and returns what to call it.
 *
 * An object the person cannot see resolves to `null`, exactly like one that
 * does not exist — attaching a Conversation to it must never confirm it is
 * there.
 */
@Injectable()
export class ConversationContextResolver {
    private readonly logger = new Logger(ConversationContextResolver.name);

    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async resolve(
        userId: string,
        type: ConversationContextType,
        id: string,
        scope?: OwnershipScope,
    ): Promise<ConversationContextSummary | null> {
        const target = CONTEXT_TARGETS[type];
        if (!target) return null;
        try {
            const row = await this.dataSource.getRepository(target.entity).findOne({
                where: ownershipWhere<ObjectLiteral>(userId, scope).map((branch) => ({
                    ...branch,
                    id,
                })),
                select: ['id', target.labelColumn],
            });
            if (!row) return null;
            const label = row[target.labelColumn];
            return { type, id, label: typeof label === 'string' ? label : '' };
        } catch (err) {
            this.logger.warn(
                `Conversation context ${type} could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
        }
    }
}
