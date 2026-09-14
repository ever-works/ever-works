import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type {
    ConversationParticipantRole,
    ConversationParticipantType,
} from '@ever-works/contracts';
import { ConversationParticipant } from '../../entities/conversation-participant.entity';
import { isUniqueConstraintError } from '../../utils/db-error.utils';

export interface AddConversationParticipantInput {
    conversationId: string;
    participantType: ConversationParticipantType;
    participantId: string;
    role?: ConversationParticipantRole;
    tenantId?: string | null;
    organizationId?: string | null;
}

/**
 * Persistence for who takes part in a Conversation.
 *
 * Membership is read in both directions — "who is in this Conversation" for
 * the header and the reply dispatch, "which Conversations is this Agent in"
 * for an Agent's list — and every write is safe against the
 * `uq_conversation_participants` constraint: adding a participant twice, or
 * from two requests at once, yields one row.
 */
@Injectable()
export class ConversationParticipantRepository {
    constructor(
        @InjectRepository(ConversationParticipant)
        private readonly repository: Repository<ConversationParticipant>,
    ) {}

    /** Current participants, oldest first. Departed ones only when asked. */
    async listForConversation(
        conversationId: string,
        options: { includeLeft?: boolean } = {},
    ): Promise<ConversationParticipant[]> {
        return this.repository.find({
            where: options.includeLeft ? { conversationId } : { conversationId, leftAt: IsNull() },
            order: { joinedAt: 'ASC' },
        });
    }

    /** Conversation ids a person or an Agent currently takes part in. */
    async listConversationsFor(
        participantType: ConversationParticipantType,
        participantId: string,
    ): Promise<string[]> {
        const rows = await this.repository.find({
            where: { participantType, participantId, leftAt: IsNull() },
            select: ['conversationId'],
        });
        return rows.map((row) => row.conversationId);
    }

    async findOne(
        conversationId: string,
        participantType: ConversationParticipantType,
        participantId: string,
    ): Promise<ConversationParticipant | null> {
        return this.repository.findOne({
            where: { conversationId, participantType, participantId },
        });
    }

    /**
     * Insert the participant unless it is already there. A lost race against
     * the unique constraint is not an error: the row the other request wrote
     * is loaded and returned, so both callers agree on one participant.
     *
     * A participant that had LEFT is returned as-is — re-joining is an
     * explicit membership change, never a side effect of adding.
     */
    async addIfAbsent(input: AddConversationParticipantInput): Promise<ConversationParticipant> {
        const existing = await this.findOne(
            input.conversationId,
            input.participantType,
            input.participantId,
        );
        if (existing) return existing;
        try {
            return await this.repository.save(
                this.repository.create({
                    conversationId: input.conversationId,
                    participantType: input.participantType,
                    participantId: input.participantId,
                    role: input.role ?? 'member',
                    joinedAt: new Date(),
                    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
                    ...(input.organizationId !== undefined
                        ? { organizationId: input.organizationId }
                        : {}),
                }),
            );
        } catch (err) {
            if (!isUniqueConstraintError(err)) throw err;
            const winner = await this.findOne(
                input.conversationId,
                input.participantType,
                input.participantId,
            );
            if (!winner) throw err;
            return winner;
        }
    }

    /** Departure, never deletion — authored messages keep their author. */
    async markLeft(
        conversationId: string,
        participantType: ConversationParticipantType,
        participantId: string,
    ): Promise<boolean> {
        const result = await this.repository.update(
            { conversationId, participantType, participantId, leftAt: IsNull() },
            { leftAt: new Date() },
        );
        return (result.affected ?? 0) > 0;
    }

    /**
     * Move the read position forward to `messageId`, and never backward.
     *
     * The write is conditional in the database: it only lands while the stored
     * position is unset or not later than `readAt`. A delayed request for an
     * older message that arrives after a newer one was read therefore changes
     * nothing, instead of turning messages the person already read unread
     * again. Returns whether the position moved (`false` also when there is no
     * participant row).
     */
    async markRead(
        conversationId: string,
        participantType: ConversationParticipantType,
        participantId: string,
        messageId: string,
        readAt: Date = new Date(),
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(ConversationParticipant)
            .set({ lastReadMessageId: messageId, lastReadAt: readAt })
            .where('"conversationId" = :conversationId', { conversationId })
            .andWhere('"participantType" = :participantType', { participantType })
            .andWhere('"participantId" = :participantId', { participantId })
            .andWhere('("lastReadAt" IS NULL OR "lastReadAt" <= :readAt)', { readAt })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /** Agents currently in the Conversation — the group-size check reads this. */
    async countActiveAgents(conversationId: string): Promise<number> {
        return this.repository.count({
            where: { conversationId, participantType: 'agent', leftAt: IsNull() },
        });
    }
}
