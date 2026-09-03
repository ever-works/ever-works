import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    INBOX_MAX_BODY_CHARS,
    INBOX_MAX_REPLY_CHARS,
    INBOX_MAX_TITLE_CHARS,
    normalizeInboxOptions,
    normalizeInboxSourceMeta,
    type InboxItemKind,
    type InboxItemOption,
    type InboxItemSourceMeta,
    type InboxItemSourceType,
    type InboxItemStatus,
} from '@ever-works/contracts';
import { InboxItem } from '../../entities/inbox-item.entity';

export interface CreateInboxItemInput {
    userId: string;
    kind: InboxItemKind;
    title: string;
    body: string;
    sourceType: InboxItemSourceType;
    options?: InboxItemOption[] | unknown | null;
    /** Fleet provenance of a `fleet-run` question (slice Q); normalized before the write. */
    sourceMeta?: InboxItemSourceMeta | null;
    agentId?: string | null;
    agentRunId?: string | null;
    taskId?: string | null;
    workId?: string | null;
    escalationId?: string | null;
    proposalId?: string | null;
    organizationId?: string | null;
    tenantId?: string | null;
}

export interface ListInboxItemsOptions {
    /** `undefined` = active view (open + answered, i.e. everything not archived). */
    status?: InboxItemStatus;
    /** Only items linked to this Task (the Task page's open-question lookup, slice Q). */
    taskId?: string;
    limit?: number;
    offset?: number;
}

/**
 * Inbox (operator message center) — the store.
 *
 * Owner scoping lives HERE, not in callers: every read and every write
 * other than `create` takes the owner's `userId` and applies it in the
 * WHERE clause, so a controller that forgets its own guard still cannot
 * touch a foreign row (foreign and missing are the same `null`/`false`).
 *
 * Producer idempotency is per LINK, not per free-form key: an
 * escalation or proposal mirrors into at most one item
 * (`findByEscalationId` / `findByProposalId` pre-checks in
 * `InboxService`), because the upstream stores are themselves
 * idempotent and re-notifying an existing card would just stack
 * duplicates.
 */
@Injectable()
export class InboxItemRepository {
    private readonly logger = new Logger(InboxItemRepository.name);

    constructor(
        @InjectRepository(InboxItem)
        private readonly repository: Repository<InboxItem>,
    ) {}

    async create(input: CreateInboxItemInput): Promise<InboxItem> {
        const row = this.repository.create({
            userId: input.userId,
            kind: input.kind,
            title: (input.title ?? '').trim().slice(0, INBOX_MAX_TITLE_CHARS),
            body: (input.body ?? '').slice(0, INBOX_MAX_BODY_CHARS),
            options: normalizeInboxOptions(input.options),
            sourceType: input.sourceType,
            agentId: input.agentId ?? null,
            agentRunId: input.agentRunId ?? null,
            taskId: input.taskId ?? null,
            workId: input.workId ?? null,
            escalationId: input.escalationId ?? null,
            proposalId: input.proposalId ?? null,
            status: 'open' as InboxItemStatus,
            unread: true,
            ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
            ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
            ...(input.sourceMeta !== undefined
                ? { sourceMeta: normalizeInboxSourceMeta(input.sourceMeta) }
                : {}),
        });
        return this.repository.save(row);
    }

    /** Producer dedup: the item already mirroring this escalation, if any. */
    async findByEscalationId(escalationId: string): Promise<InboxItem | null> {
        return this.repository.findOne({ where: { escalationId } });
    }

    /** Producer dedup: the item already mirroring this proposal, if any. */
    async findByProposalId(proposalId: string): Promise<InboxItem | null> {
        return this.repository.findOne({ where: { proposalId } });
    }

    /**
     * Producer dedup (slice Q): the OPEN question already filed for this
     * run, if any. A fleet completion event can be replayed and a node can
     * report the same job twice; one parked run gets one question.
     */
    async findOpenQuestionByRunId(agentRunId: string): Promise<InboxItem | null> {
        return this.repository.findOne({
            where: {
                agentRunId,
                kind: 'question' as InboxItemKind,
                status: 'open' as InboxItemStatus,
            },
        });
    }

    /**
     * One user's inbox, newest first. No `status` = the ACTIVE view
     * (everything not archived) — that is what the message list renders;
     * `archived` is its own tab.
     */
    async listForUser(
        userId: string,
        options: ListInboxItemsOptions = {},
    ): Promise<{ rows: InboxItem[]; total: number }> {
        const qb = this.repository
            .createQueryBuilder('item')
            .where('item.userId = :userId', { userId });
        if (options.status) {
            qb.andWhere('item.status = :status', { status: options.status });
        } else {
            qb.andWhere('item.status != :archived', { archived: 'archived' });
        }
        // Owner predicate first, Task filter second: the Task page asks
        // "is there an open question for THIS Task" and must never see
        // another owner's item through a guessed Task id.
        if (options.taskId) {
            qb.andWhere('item.taskId = :taskId', { taskId: options.taskId });
        }
        const [rows, total] = await qb
            .orderBy('item.createdAt', 'DESC')
            .skip(Math.max(0, options.offset ?? 0))
            .take(Math.max(1, Math.min(100, options.limit ?? 50)))
            .getManyAndCount();
        return { rows, total };
    }

    /** Unread badge count — unread AND not archived. */
    async countUnreadForUser(userId: string): Promise<number> {
        return this.repository
            .createQueryBuilder('item')
            .where('item.userId = :userId', { userId })
            .andWhere('item.unread = :unread', { unread: true })
            .andWhere('item.status != :archived', { archived: 'archived' })
            .getCount();
    }

    /** One item, owner-scoped. `null` for foreign AND missing ids. */
    async findOwned(id: string, userId: string): Promise<InboxItem | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    /** Flip the read state. Owner-scoped; returns whether a row changed. */
    async setUnread(id: string, userId: string, unread: boolean): Promise<boolean> {
        const result = await this.repository.update({ id, userId }, { unread });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Archive / unarchive. Unarchive restores the pre-archive state,
     * derived from `answeredAt` (answered items come back `answered`,
     * everything else `open`) — one boolean of history nobody needs a
     * column for.
     */
    async setArchived(id: string, userId: string, archived: boolean): Promise<InboxItem | null> {
        const row = await this.findOwned(id, userId);
        if (!row) return null;
        row.status = archived ? 'archived' : row.answeredAt ? 'answered' : 'open';
        return this.repository.save(row);
    }

    /**
     * Record the answer. Owner-scoped CAS on `status='open'` so a
     * double-submit answers once — the second call reports `false` and
     * the caller re-reads the winner's row.
     */
    async markAnswered(
        id: string,
        userId: string,
        answer: { text?: string | null; optionId?: string | null },
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(InboxItem)
            .set({
                status: 'answered' as InboxItemStatus,
                unread: false,
                answeredAt: new Date(),
                answerText: answer.text ? answer.text.slice(0, INBOX_MAX_REPLY_CHARS) : null,
                answerOptionId: answer.optionId ?? null,
            })
            .where('id = :id', { id })
            .andWhere('userId = :userId', { userId })
            .andWhere('status = :open', { open: 'open' })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Release a claim whose downstream routing blew up, so the human can
     * answer again. Owner-scoped and CAS'd on `status='answered'` so it
     * can only ever undo THIS reply's claim, never reopen an item that
     * was meanwhile archived. `unread` deliberately stays `false`: the
     * human has read it either way.
     */
    async reopen(id: string, userId: string): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(InboxItem)
            .set({
                status: 'open' as InboxItemStatus,
                answeredAt: null,
                answerText: null,
                answerOptionId: null,
            })
            .where('id = :id', { id })
            .andWhere('userId = :userId', { userId })
            .andWhere('status = :answered', { answered: 'answered' })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Hard delete one item, owner-scoped. The inbox row is a MESSAGE,
     * not the system of record (escalations / proposals / runs keep
     * their own rows), so deleting it destroys no audit trail.
     */
    async deleteOwned(id: string, userId: string): Promise<boolean> {
        const result = await this.repository.delete({ id, userId });
        return (result.affected ?? 0) > 0;
    }
}
