import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, type FindOptionsWhere } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import type {
    ConversationAttachmentRef,
    ConversationAuthorType,
    ConversationContextType,
    ConversationFailureCode,
    ConversationKind,
    ConversationMention,
    ConversationMessageStatus,
    ConversationParticipantRole,
    ConversationParticipantType,
    ConversationTitleSource,
} from '@ever-works/contracts';
import { Conversation } from '../../entities/conversation.entity';
import {
    ConversationMessage,
    ConversationMessageRole,
    conversationAuthorTypeForRole,
} from '../../entities/conversation-message.entity';
import { ConversationParticipant } from '../../entities/conversation-participant.entity';
import { readPositionMovesForward } from './conversation-participant.repository';
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

/** Where a forward page of messages starts: just after this message. */
export interface ConversationMessageCursor {
    id: string;
    createdAt: Date | string;
}

/** A participant a Conversation is created with. */
export interface ConversationInitialParticipant {
    participantType: ConversationParticipantType;
    participantId: string;
    role?: ConversationParticipantRole;
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

    /**
     * Store a Conversation and the people and Agents it opens with in ONE
     * transaction: either every row lands or none does. Saving them one by
     * one could leave a Conversation its owner can see but that has no
     * participants, and a retried create would then open a second one.
     *
     * Each participant takes the Conversation's scope as stored, so a scope
     * the ambient subscriber stamped on the Conversation reaches them too.
     */
    async createWithParticipants(
        input: CreateConversationInput,
        participants: readonly ConversationInitialParticipant[],
    ): Promise<Conversation> {
        return this.conversationRepo.manager.transaction(async (manager) => {
            const conversation = await manager.save(manager.create(Conversation, input));
            for (const participant of participants) {
                await manager.save(
                    manager.create(ConversationParticipant, {
                        conversationId: conversation.id,
                        participantType: participant.participantType,
                        participantId: participant.participantId,
                        role: participant.role ?? 'member',
                        joinedAt: new Date(),
                        tenantId: conversation.tenantId ?? null,
                        organizationId: conversation.organizationId ?? null,
                    }),
                );
            }
            return conversation;
        });
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
            // Built through TypeORM rather than spelled out, so the table and
            // the column are escaped for the driver in use: raw `"createdAt"`
            // quoting is Postgres/SQLite-only and MySQL rejects it without
            // ANSI_QUOTES.
            const readAtExpression = `(${this.messageRepo
                .createQueryBuilder('rtm')
                .select('rtm.createdAt')
                .where('rtm.id = :readThroughMessageId')
                .getQuery()})`;
            await this.messageRepo.manager
                .createQueryBuilder()
                .update(ConversationParticipant)
                .set({
                    lastReadMessageId: newest.id,
                    lastReadAt: () => readAtExpression,
                })
                .where('conversationId = :conversationId', { conversationId })
                .andWhere('participantType = :participantType', { participantType: 'user' })
                .andWhere('role = :role', { role: 'owner' })
                // Forward only, and on the same `(createdAt, id)` pair
                // `markRead` compares: a slower append that finishes after a
                // newer one must not pull the position back, not even when
                // both messages share a stored timestamp.
                .andWhere(readPositionMovesForward(readAtExpression, 'readThroughMessageId'))
                .setParameter('readThroughMessageId', newest.id)
                .execute();
        } catch {
            // Swallowed on purpose — see the method note.
        }
    }

    /**
     * Write a title for a Conversation the caller owns.
     *
     * `onlyWhenNotUserTitled` makes the write a compare-and-set on
     * `titleSource`: an automatic title is generated from a read taken before
     * a slow model call, and by the time it comes back the person may have
     * renamed the Conversation themselves. Without the condition that stale
     * write would land on top of their name and FR-6 ("a name a person chose
     * is never overwritten by a model") would hold only until the next race.
     * Returns whether a row was written, so a caller can tell a refused stale
     * write from a successful one instead of assuming success.
     */
    async updateTitle(
        id: string,
        userId: string,
        title: string,
        metadata?: Record<string, unknown>,
        options: { onlyWhenNotUserTitled?: boolean } = {},
    ): Promise<boolean> {
        const query = this.conversationRepo
            .createQueryBuilder()
            .update(Conversation)
            .set({ title, ...(metadata && { metadata }) } as QueryDeepPartialEntity<Conversation>)
            .where('id = :id', { id })
            .andWhere('userId = :userId', { userId });
        if (options.onlyWhenNotUserTitled) {
            query.andWhere('(titleSource IS NULL OR titleSource != :userTitleSource)', {
                userTitleSource: 'user' satisfies ConversationTitleSource,
            });
        }
        const result = await query.execute();
        return (result.affected ?? 0) > 0;
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
            // The read boundary is the pair `(createdAt, id)`, exactly as
            // `markRead` stores it: several messages can share one stored
            // timestamp, and a plain `createdAt > lastReadAt` would silently
            // count every one of those later ids as already read.
            .andWhere(
                '((p.lastReadAt IS NOT NULL AND (m.createdAt > p.lastReadAt OR (m.createdAt = p.lastReadAt AND p.lastReadMessageId IS NOT NULL AND m.id > p.lastReadMessageId))) OR (p.lastReadAt IS NULL AND m.createdAt >= p.joinedAt))',
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
            // on some drivers, which silently disables the bound. The
            // sub-select is built through TypeORM so its table and column are
            // escaped for the driver in use (raw `"createdAt"` quoting is
            // Postgres/SQLite-only; MySQL rejects it without ANSI_QUOTES).
            const anchorCreatedAt = query
                .subQuery()
                .select('anchor.createdAt')
                .from(ConversationMessage, 'anchor')
                .where('anchor.id = :before')
                .getQuery();
            query.andWhere(`m.createdAt < ${anchorCreatedAt}`, { before });
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

    /**
     * A message by id alone, when the caller knows the message but not its
     * Conversation (an Agent run records only the message it answers). Callers
     * must still check the Conversation belongs to whoever they act for.
     */
    async findMessageByIdUnscoped(messageId: string): Promise<ConversationMessage | null> {
        return this.messageRepo.findOne({ where: { id: messageId } });
    }

    async findByClientMessageId(
        conversationId: string,
        clientMessageId: string,
    ): Promise<ConversationMessage | null> {
        return this.messageRepo.findOne({ where: { conversationId, clientMessageId } });
    }

    /**
     * Messages whose send status may still move, plus any extra ids the
     * caller is still watching — newest first, capped at `limit`.
     *
     * A person's message is not finished when it is written: the reply job can
     * refuse it (`sent` → `failed`) long afterwards, and a Retry sends it
     * again (`failed` → `sent`). The live stream re-reads the newest window
     * for status changes, but in a busy Conversation a message waiting for its
     * outcome drops out of that window while it is still moving. Keyed on
     * status and on the ids a connection is watching rather than on recency,
     * this read keeps delivering those changes.
     */
    async findUnsettledMessages(
        conversationId: string,
        statuses: ConversationMessageStatus[],
        watchedIds: string[],
        limit = 50,
    ): Promise<ConversationMessage[]> {
        const branches: string[] = [];
        const query = this.messageRepo
            .createQueryBuilder('m')
            .where('m.conversationId = :conversationId', { conversationId });
        if (statuses.length > 0) {
            branches.push('m.status IN (:...statuses)');
            query.setParameter('statuses', statuses);
        }
        if (watchedIds.length > 0) {
            branches.push('m.id IN (:...watchedIds)');
            query.setParameter('watchedIds', watchedIds);
        }
        if (branches.length === 0) return [];
        const rows = await query
            .andWhere(`(${branches.join(' OR ')})`)
            .orderBy('m.createdAt', 'DESC')
            .addOrderBy('m.id', 'DESC')
            .take(limit)
            .getMany();
        return rows.reverse();
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

    /**
     * One page of the messages written after `after`, oldest first — a keyset
     * page on (`createdAt`, `id`). Paging with the last row of each page as the
     * next `after` walks every message exactly once, however many arrived at
     * once and even when several share a timestamp. With no `after`, the page
     * starts at the Conversation's first message.
     *
     * The cursor carries the row's own values, not just its id, so it keeps
     * working when the message it points at was deleted (a discarded send).
     */
    async findMessagesAfter(
        conversationId: string,
        after: ConversationMessageCursor | null,
        limit: number,
    ): Promise<ConversationMessage[]> {
        const query = this.messageRepo
            .createQueryBuilder('m')
            .where('m.conversationId = :conversationId', { conversationId });
        if (after) {
            const afterAt =
                after.createdAt instanceof Date ? after.createdAt : new Date(after.createdAt);
            query.andWhere(
                '(m.createdAt > :afterAt OR (m.createdAt = :afterAt AND m.id > :afterId))',
                { afterAt, afterId: after.id },
            );
        }
        return query.orderBy('m.createdAt', 'ASC').addOrderBy('m.id', 'ASC').take(limit).getMany();
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

    /**
     * Move a `failed` message back to `sent`, but only while it is still
     * `failed` — a compare-and-set in one statement. Two Retries that both read
     * the message as `failed` cannot both move it: exactly one write matches,
     * and only that caller may dispatch a reply. Returns whether this call won.
     */
    async claimFailedMessage(conversationId: string, messageId: string): Promise<boolean> {
        const result = await this.messageRepo.update(
            { id: messageId, conversationId, status: 'failed' },
            { status: 'sent', failureCode: null },
        );
        return (result.affected ?? 0) > 0;
    }

    /** Remove messages by id inside one Conversation. Returns how many went. */
    async deleteMessages(conversationId: string, messageIds: string[]): Promise<number> {
        if (messageIds.length === 0) return 0;
        const result = await this.messageRepo.delete({ conversationId, id: In(messageIds) });
        return result.affected ?? 0;
    }
}
