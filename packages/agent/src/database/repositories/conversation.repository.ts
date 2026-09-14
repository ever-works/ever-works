import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, type FindOptionsWhere } from 'typeorm';
import type {
    ConversationAttachmentRef,
    ConversationAuthorType,
    ConversationContextType,
    ConversationFailureCode,
    ConversationKind,
    ConversationMention,
    ConversationMessageStatus,
    ConversationTitleSource,
} from '@ever-works/contracts';
import { Conversation } from '../../entities/conversation.entity';
import {
    ConversationMessage,
    ConversationMessageRole,
    conversationAuthorTypeForRole,
} from '../../entities/conversation-message.entity';
import { ConversationParticipant } from '../../entities/conversation-participant.entity';
import { ownershipWhere, type OwnershipScope } from '../ownership-scope';

export interface CreateConversationInput {
    userId: string;
    title?: string;
    providerId?: string;
    model?: string;
    // Named Conversations with Agents — every field optional, so an input
    // carrying none of them creates exactly the row it always did.
    kind?: ConversationKind;
    agentId?: string | null;
    titleSource?: ConversationTitleSource | null;
    contextType?: ConversationContextType | null;
    contextId?: string | null;
    tenantId?: string | null;
    organizationId?: string | null;
}

export interface AppendMessageInput {
    conversationId: string;
    role: ConversationMessageRole;
    content: string;
    parts?: unknown[];
    model?: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** A message written by the named-Conversation send path or an Agent reply. */
export interface InsertConversationMessageInput extends AppendMessageInput {
    authorType: ConversationAuthorType;
    authorId?: string | null;
    mentions?: ConversationMention[] | null;
    attachments?: ConversationAttachmentRef[] | null;
    status?: ConversationMessageStatus;
    failureCode?: ConversationFailureCode | null;
    clientMessageId?: string | null;
    replyToMessageId?: string | null;
    tenantId?: string | null;
    organizationId?: string | null;
}

export interface ListConversationSummariesFilter {
    limit?: number;
    offset?: number;
    kind?: ConversationKind;
    agentId?: string;
    contextType?: ConversationContextType;
    contextId?: string;
}

/**
 * Columns a named-Conversation list row carries. The legacy `findByUser`
 * projection is deliberately left exactly as it was — clients that read it
 * pin its key set.
 */
const SUMMARY_COLUMNS: (keyof Conversation)[] = [
    'id',
    'kind',
    'agentId',
    'title',
    'titleSource',
    'providerId',
    'model',
    'contextType',
    'contextId',
    'lastMessageAt',
    'createdAt',
    'updatedAt',
];

/**
 * A legacy append names no author; derive it from the role so a model turn is
 * `system`-authored instead of taking the column's `user` default. A `user`
 * turn is left to that default (it is already right), and an explicit author,
 * where a caller supplies one, always wins.
 */
function withLegacyAuthor(
    input: AppendMessageInput,
): AppendMessageInput & { authorType?: ConversationAuthorType } {
    if ((input as Partial<InsertConversationMessageInput>).authorType || input.role === 'user') {
        return input;
    }
    return { ...input, authorType: conversationAuthorTypeForRole(input.role) };
}

@Injectable()
export class ConversationRepository {
    constructor(
        @InjectRepository(Conversation)
        private readonly conversationRepo: Repository<Conversation>,
        @InjectRepository(ConversationMessage)
        private readonly messageRepo: Repository<ConversationMessage>,
    ) {}

    async create(input: CreateConversationInput): Promise<Conversation> {
        const conversation = this.conversationRepo.create(input);
        return this.conversationRepo.save(conversation);
    }

    async findById(id: string, userId?: string): Promise<Conversation | null> {
        return this.conversationRepo.findOne({
            where: { id, ...(userId && { userId }) },
            relations: ['messages'],
            order: { messages: { createdAt: 'ASC' } },
        });
    }

    async findByUser(
        userId: string,
        options?: { limit?: number; offset?: number },
    ): Promise<{ conversations: Conversation[]; total: number }> {
        const [conversations, total] = await this.conversationRepo.findAndCount({
            where: { userId },
            order: { updatedAt: 'DESC' },
            take: options?.limit ?? 50,
            skip: options?.offset ?? 0,
            select: ['id', 'title', 'providerId', 'model', 'createdAt', 'updatedAt'],
        });

        return { conversations, total };
    }

    async appendMessage(input: AppendMessageInput): Promise<ConversationMessage> {
        const message = this.messageRepo.create(withLegacyAuthor(input));
        const saved = await this.messageRepo.save(message);

        // Touch the conversation's updatedAt — and its last activity, which
        // named-Conversation lists order by.
        const now = new Date();
        await this.conversationRepo.update(input.conversationId, {
            updatedAt: now,
            lastMessageAt: now,
        });
        await this.readThroughLegacyAppend(input.conversationId, saved);

        return saved;
    }

    async appendMessages(messages: AppendMessageInput[]): Promise<ConversationMessage[]> {
        if (messages.length === 0) return [];

        // Save messages sequentially with explicit timestamps to guarantee ordering.
        // Batch save can assign the same createdAt to all rows, breaking ORDER BY on reload.
        const saved: ConversationMessage[] = [];
        const baseTime = Date.now();
        for (let i = 0; i < messages.length; i++) {
            const entity = this.messageRepo.create({
                ...withLegacyAuthor(messages[i]),
                createdAt: new Date(baseTime + i),
            });
            saved.push(await this.messageRepo.save(entity));
        }

        const conversationId = messages[0].conversationId;
        const now = new Date();
        await this.conversationRepo.update(conversationId, { updatedAt: now, lastMessageAt: now });
        await this.readThroughLegacyAppend(conversationId, saved[saved.length - 1]);

        return saved;
    }

    /**
     * The legacy append path is the person's own client persisting turns it
     * has already shown them — the model's replies included, which are
     * `system`-authored and would otherwise count as unread. Move the owner's
     * read position to the newest appended message.
     *
     * The position is copied from the stored row inside the database, so the
     * unread boundary compares a value with itself (a JS `Date` loses
     * sub-millisecond precision on some drivers). Only an existing owner row
     * moves: a Conversation that predates participants has none, and counts
     * nothing as unread until its owner joins.
     *
     * Best-effort: read bookkeeping must never fail an append the legacy
     * contract promised.
     */
    private async readThroughLegacyAppend(
        conversationId: string,
        newest: ConversationMessage | undefined,
    ): Promise<void> {
        if (!newest?.id) return;
        try {
            await this.messageRepo.manager
                .createQueryBuilder()
                .update(ConversationParticipant)
                .set({
                    lastReadMessageId: newest.id,
                    lastReadAt: () =>
                        '(SELECT m."createdAt" FROM conversation_messages m WHERE m.id = :readThroughMessageId)',
                })
                .where('"conversationId" = :conversationId', { conversationId })
                .andWhere('"participantType" = :participantType', { participantType: 'user' })
                .andWhere('"role" = :role', { role: 'owner' })
                .setParameter('readThroughMessageId', newest.id)
                .execute();
        } catch {
            // Swallowed on purpose — see the method note.
        }
    }

    async updateTitle(
        id: string,
        userId: string,
        title: string,
        metadata?: Record<string, unknown>,
    ): Promise<void> {
        await this.conversationRepo.update(
            { id, userId },
            { title, ...(metadata && { metadata }) },
        );
    }

    /**
     * Update the model a conversation is currently pinned to.
     *
     * Deliberately NARROWER than a general-purpose update: `providerId` is
     * NOT settable here. A conversation records the provider it was STARTED
     * with and that record is immutable (the PATCH DTO refuses the field
     * outright — see `UpdateConversationDto`), because the provider is the
     * thread's identity: switching it mid-thread would rewrite history for
     * messages an entirely different vendor produced.
     *
     * The MODEL is not identity — it is a dial the user turns inside one
     * thread ("same provider, think harder"), and the per-message `model`
     * column keeps the audit trail of what actually served each turn. So
     * this column tracks the CURRENT pin, and exists so re-opening a
     * conversation restores the model the user last chose for it instead of
     * silently falling back to whatever the browser last used.
     *
     * `null` clears the pin, which means "resolve the provider's configured
     * default" — not "no model".
     */
    async updateModel(id: string, userId: string, model: string | null): Promise<void> {
        // `null` (not `undefined`) is what makes TypeORM emit `SET model = NULL`;
        // `undefined` is treated as "leave this column alone", which would make
        // clearing the pin silently no-op.
        await this.conversationRepo.update({ id, userId }, { model });
    }

    async delete(id: string, userId: string): Promise<boolean> {
        const result = await this.conversationRepo.delete({ id, userId });
        return (result.affected ?? 0) > 0;
    }

    async deleteAllByUser(userId: string): Promise<number> {
        const result = await this.conversationRepo.delete({ userId });
        return result.affected ?? 0;
    }

    // ── Named Conversations with Agents ─────────────────────────────────

    /**
     * One person's Conversations in the active scope, newest activity first,
     * with the columns a named list needs. Every filter is optional; with
     * none, the rows are the same set `findByUser` returns.
     */
    async findSummariesByUser(
        userId: string,
        filter: ListConversationSummariesFilter = {},
        scope?: OwnershipScope,
    ): Promise<{ conversations: Conversation[]; total: number }> {
        const extra: FindOptionsWhere<Conversation> = {};
        if (filter.kind) extra.kind = filter.kind;
        if (filter.agentId) extra.agentId = filter.agentId;
        if (filter.contextType) extra.contextType = filter.contextType;
        if (filter.contextId) extra.contextId = filter.contextId;

        const [conversations, total] = await this.conversationRepo.findAndCount({
            where: ownershipWhere<Conversation>(userId, scope).map((branch) => ({
                ...branch,
                ...extra,
            })),
            order: { lastMessageAt: { direction: 'DESC', nulls: 'LAST' }, updatedAt: 'DESC' },
            take: filter.limit ?? 50,
            skip: filter.offset ?? 0,
            select: SUMMARY_COLUMNS,
        });
        return { conversations, total };
    }

    /**
     * The Conversation row without its messages, scoped to the caller. `null`
     * for a Conversation that does not exist and for one the caller may not
     * read — callers must not tell the two apart.
     */
    async findByIdForUser(
        id: string,
        userId: string,
        scope?: OwnershipScope,
    ): Promise<Conversation | null> {
        return this.conversationRepo.findOne({
            where: ownershipWhere<Conversation>(userId, scope).map((branch) => ({
                ...branch,
                id,
            })),
        });
    }

    /**
     * Set or clear the name a person gave a Conversation. A name marks the
     * title as `user`-owned, which stops automatic titling for good; clearing
     * it resets the source so automatic titling may run again.
     */
    async setName(id: string, userId: string, name: string | null): Promise<boolean> {
        const result = await this.conversationRepo.update({ id, userId }, {
            title: name,
            titleSource: name === null ? null : 'user',
        } as Partial<Conversation>);
        return (result.affected ?? 0) > 0;
    }

    async touchLastMessageAt(id: string, at: Date = new Date()): Promise<void> {
        await this.conversationRepo.update(id, { updatedAt: at, lastMessageAt: at });
    }

    /**
     * Messages an Agent or the system wrote after the person's read position,
     * per Conversation. A Conversation with nothing unread is absent from the
     * map (read it as 0).
     *
     * Before a person has read anything, the boundary is when they joined:
     * history written before they took part is never unread. A person with no
     * participant row (a Conversation that predates participants and was never
     * opened through a named-Conversation route) has no read position, so
     * nothing counts.
     */
    async unreadCountsFor(userId: string, conversationIds: string[]): Promise<Map<string, number>> {
        const counts = new Map<string, number>();
        if (conversationIds.length === 0) return counts;
        const rows = await this.messageRepo
            .createQueryBuilder('m')
            .select('m.conversationId', 'conversationId')
            .addSelect('COUNT(m.id)', 'count')
            .leftJoin(
                ConversationParticipant,
                'p',
                'p.conversationId = m.conversationId AND p.participantType = :participantType AND p.participantId = :userId',
                { participantType: 'user', userId },
            )
            .where('m.conversationId IN (:...conversationIds)', { conversationIds })
            .andWhere('m.authorType IN (:...authorTypes)', { authorTypes: ['agent', 'system'] })
            .andWhere(
                '((p.lastReadAt IS NOT NULL AND m.createdAt > p.lastReadAt) OR (p.lastReadAt IS NULL AND m.createdAt >= p.joinedAt))',
            )
            .groupBy('m.conversationId')
            .getRawMany<{ conversationId: string; count: string | number }>();
        for (const row of rows) {
            const count = Number(row.count);
            if (count > 0) counts.set(row.conversationId, count);
        }
        return counts;
    }

    /**
     * A page of messages, returned oldest-first. `before` is a message id: the
     * page holds the `limit` messages written just before it.
     */
    async findMessagesPaged(
        conversationId: string,
        limit: number,
        before?: string,
    ): Promise<ConversationMessage[]> {
        if (before) {
            const anchor = await this.messageRepo.findOne({
                where: { id: before, conversationId },
                select: ['id'],
            });
            if (!anchor) return [];
        }
        const query = this.messageRepo
            .createQueryBuilder('m')
            .where('m.conversationId = :conversationId', { conversationId });
        if (before) {
            // Compared inside the database, column to column: a JS Date bound
            // as a parameter is formatted differently from the stored value
            // on some drivers, which silently disables the bound.
            query.andWhere(
                'm.createdAt < (SELECT anchor."createdAt" FROM conversation_messages anchor WHERE anchor.id = :before)',
                { before },
            );
        }
        const rows = await query.orderBy('m.createdAt', 'DESC').take(limit).getMany();
        return rows.reverse();
    }

    async findMessageById(
        conversationId: string,
        messageId: string,
    ): Promise<ConversationMessage | null> {
        return this.messageRepo.findOne({ where: { id: messageId, conversationId } });
    }

    async findByClientMessageId(
        conversationId: string,
        clientMessageId: string,
    ): Promise<ConversationMessage | null> {
        return this.messageRepo.findOne({ where: { conversationId, clientMessageId } });
    }

    /** Messages newer than `since`, oldest-first — the live stream diffs these. */
    async findMessagesSince(
        conversationId: string,
        since: Date,
        limit = 50,
    ): Promise<ConversationMessage[]> {
        return this.messageRepo
            .createQueryBuilder('m')
            .where('m.conversationId = :conversationId', { conversationId })
            .andWhere('m.createdAt >= :since', { since })
            .orderBy('m.createdAt', 'ASC')
            .take(limit)
            .getMany();
    }

    /** Store one message and move the Conversation's activity forward. */
    async insertMessage(input: InsertConversationMessageInput): Promise<ConversationMessage> {
        // Explicit millisecond `createdAt`, as `appendMessages` does: a column
        // default can round to the second on some drivers, which would order
        // a reply before the message it answers and blur the unread boundary.
        const now = new Date();
        const saved = await this.messageRepo.save(
            this.messageRepo.create({ ...input, status: input.status ?? 'sent', createdAt: now }),
        );
        await this.touchLastMessageAt(input.conversationId, now);
        return saved;
    }

    async updateMessageStatus(
        messageId: string,
        status: ConversationMessageStatus,
        failureCode: ConversationFailureCode | null = null,
    ): Promise<void> {
        await this.messageRepo.update(messageId, { status, failureCode });
    }

    /** Remove messages by id inside one Conversation. Returns how many went. */
    async deleteMessages(conversationId: string, messageIds: string[]): Promise<number> {
        if (messageIds.length === 0) return 0;
        const result = await this.messageRepo.delete({ conversationId, id: In(messageIds) });
        return result.affected ?? 0;
    }
}
