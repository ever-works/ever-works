import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    In,
    IsNull,
    MoreThan,
    MoreThanOrEqual,
    Not,
    Repository,
    type FindOptionsWhere,
} from 'typeorm';
import type { EmailMessageStatus } from '@ever-works/contracts';
import { AgentActionProposal } from '../../entities/agent-action-proposal.entity';
import { EmailMessage, EmailMessageDirection } from '../../entities/email-message.entity';
import { advisoryLockObjectId } from './agent-run.repository';

/** AW-05 — rows per page when a recipient window is read in full. */
export const EMAIL_RECIPIENT_WINDOW_PAGE_SIZE = 500;

/**
 * AW-05 — which sends a ceiling window counts: one Agent's (`agentId`) or a
 * whole account's (`userId`). Exactly one should be set.
 */
export interface EmailSendWindowFilter {
    agentId?: string;
    userId?: string;
}

/**
 * AW-05 — advisory-lock namespaces (`classid`) for send admission: one for
 * an Agent's per-Agent windows, one for an account's windows. Apart from
 * each other and from run admission (`0x6577_0001`) and live-view admission
 * (`0x6577_000b` / `0x6577_000c`). Arbitrary but STABLE: changing one would
 * make an old and a new replica lock on different keys during a rolling
 * restart — exactly the window the lock exists for.
 */
export const EMAIL_SEND_AGENT_ADMISSION_LOCK_CLASS_ID = 0x6577_0e01 | 0;
export const EMAIL_SEND_ACCOUNT_ADMISSION_LOCK_CLASS_ID = 0x6577_0e02 | 0;

/** What one send admission serializes on. Omit a key whose windows the send does not count. */
export interface EmailSendAdmissionLockKeys {
    /** The Agent whose per-Agent windows (minute, 5 minutes, 24 hours) are counted. */
    agentId?: string | null;
    /** The account whose account-wide windows (24 hours, 30 days) are counted. */
    userId?: string | null;
}

export interface EmailMessageQueryOptions {
    direction?: EmailMessageDirection;
    agentId?: string;
    taskId?: string;
    conversationId?: string;
    emailAddressId?: string;
    limit?: number;
    offset?: number;
}

/**
 * Notifications v2 — Email Providers (EW-650, EW-667).
 *
 * Repository for `email_messages`. Both directions live in the same
 * table — direction discriminator + indexed `(userId, agentId,
 * createdAt)` keeps the per-Agent inbox query cheap.
 */
@Injectable()
export class EmailMessageRepository {
    private readonly logger = new Logger(EmailMessageRepository.name);

    constructor(
        @InjectRepository(EmailMessage)
        private readonly repository: Repository<EmailMessage>,
    ) {}

    /**
     * AW-05 — serialize a send's count-then-reserve against every other send
     * counting the same windows, so a burst cannot walk past a hard ceiling.
     * The run-admission lock's pattern (`AgentRunRepository.withAdmissionLock`)
     * in its own namespaces.
     *
     * POSTGRES: opens ONE transaction, takes `pg_advisory_xact_lock` on the
     * Agent key and then the account key (fixed order, so two admissions can
     * never hold one key each while waiting for the other's), and runs `fn`
     * with a repository bound to THAT transaction. The count and the
     * reservation row `fn` writes therefore commit together, and the lock is
     * released by that same commit: the next waiter's count starts after it
     * and sees the reservation. Doing the work on the transaction's own
     * connection (not the pool's) also means a burst of waiters, each holding
     * a connection, can never starve the lock holder of one.
     *
     * EVERY OTHER DRIVER (better-sqlite3 — the e2e/CI stack): advisory locks
     * do not exist, so this is a documented no-op that calls `fn` with this
     * repository. No keys = nothing to serialize = the same.
     *
     * A failure to TAKE the lock degrades to running `fn` unlocked (logged),
     * like the run-admission lock: a broken safety valve must never stop
     * legitimate mail. A failure INSIDE `fn` (or its commit) is re-raised and
     * `fn` is never re-run, since it may already have reserved capacity.
     */
    // ── EW-P4-2 — change notifications (domain events) ─────────────────

    /**
     * Set once at bootstrap by `EmailMessageDomainEventsBridge` (the one
     * component that records `email.message.*`): this repository is the single
     * writer of `email_messages`, so every row it creates or moves is reported
     * here, after the write. Unset (unit tests, the worker) = nothing reported.
     */
    setChangeListener(listener: EmailMessageChangeListener | undefined): void {
        this.changeListener = listener;
    }

    private changeListener?: EmailMessageChangeListener;

    /** Set on the transaction-scoped twin {@link withSendAdmissionLock} hands out: changes wait for the commit. */
    private deferredChanges?: EmailMessageChange[];

    private async notify(change: EmailMessageChange): Promise<void> {
        if (this.deferredChanges) {
            this.deferredChanges.push(change);
            return;
        }
        if (!this.changeListener) return;
        try {
            await this.changeListener(change);
        } catch (error) {
            this.logger.warn(
                `email_messages change listener failed for ${change.id}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    async withSendAdmissionLock<T>(
        keys: EmailSendAdmissionLockKeys,
        fn: (messages: EmailMessageRepository) => Promise<T>,
    ): Promise<T> {
        const connection = this.repository.manager.connection;
        if (connection.options.type !== 'postgres') {
            return fn(this);
        }
        const locks: Array<[number, number]> = [];
        if (keys.agentId) {
            locks.push([
                EMAIL_SEND_AGENT_ADMISSION_LOCK_CLASS_ID,
                advisoryLockObjectId(`agent:${keys.agentId}`),
            ]);
        }
        if (keys.userId) {
            locks.push([
                EMAIL_SEND_ACCOUNT_ADMISSION_LOCK_CLASS_ID,
                advisoryLockObjectId(`user:${keys.userId}`),
            ]);
        }
        if (locks.length === 0) {
            return fn(this);
        }
        let entered = false;
        // EW-P4-2 — what the locked unit of work writes is reported once it has
        // committed (a rolled-back reservation reports nothing).
        const deferred: EmailMessageChange[] = [];
        try {
            const result = await connection.transaction(async (manager) => {
                for (const [classId, objectId] of locks) {
                    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [
                        classId,
                        objectId,
                    ]);
                }
                entered = true;
                const scoped = new EmailMessageRepository(manager.getRepository(EmailMessage));
                scoped.deferredChanges = deferred;
                return fn(scoped);
            });
            for (const change of deferred) await this.notify(change);
            return result;
        } catch (error) {
            if (entered) throw error;
            this.logger.warn(
                `Send admission lock unavailable (${locks.length} key(s)) — admitting unlocked: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return fn(this);
        }
    }

    create(entry: Partial<EmailMessage>): EmailMessage {
        return this.repository.create(entry);
    }

    async save(entry: EmailMessage): Promise<EmailMessage> {
        // EW-P4-2 — a re-save of an existing row reports what it really
        // changed (read before the write, only while someone listens).
        const tracking = !!this.changeListener || !!this.deferredChanges;
        const before =
            tracking && entry.id
                ? await this.repository.findOne({ where: { id: entry.id } })
                : null;
        // `version` and `updatedAt` belong to the domain-event recorder (and
        // TypeORM): a caller re-saving a copy read before an event must never
        // roll them back, or the integration's `updatedSince` sync would miss
        // the change.
        const saved = await this.repository.save(entry.id ? withoutRecorderColumns(entry) : entry);
        if (!saved?.id || !tracking) return saved;
        if (!before) {
            await this.notify({ kind: 'created', id: saved.id });
            return saved;
        }
        const change = describeEmailMessageChange(before, saved);
        // Nothing the integration DTO shows moved: no event, no version bump.
        if (change.changedFields.length > 0) {
            await this.notify({ kind: 'status', id: saved.id, ...change });
        }
        return saved;
    }

    async findById(id: string): Promise<EmailMessage | null> {
        return this.repository.findOne({ where: { id } });
    }

    // Security: tenant-scoped single-message lookup. Service-layer callers that
    // resolve a message on behalf of an authenticated user MUST use this instead
    // of the unscoped findById so another tenant's message body/subject/recipients
    // can never be returned (IDOR). The unscoped findById is retained for internal
    // system paths keyed on a trusted id (e.g. provider delivery-status callbacks).
    async findByIdAndUserId(id: string, userId: string): Promise<EmailMessage | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    async findByProviderMessageId(
        pluginId: string,
        providerMessageId: string,
    ): Promise<EmailMessage | null> {
        return this.repository.findOne({
            where: { pluginId, providerMessageId },
        });
    }

    /**
     * EW-P4-3 — RFC threading: this owner's messages whose `Message-ID` is one
     * of `ids` (bare ids, see `normalizeMessageId`). Owner-scoped: a header is
     * sender-written, so a reply can never thread into another owner's mail.
     * Newest first; callers rank by the order of `ids` themselves.
     */
    async findByMessageIdHeaders(userId: string, ids: readonly string[]): Promise<EmailMessage[]> {
        if (ids.length === 0) return [];
        return this.repository.find({
            where: { userId, messageIdHeader: In([...ids]) },
            order: { createdAt: 'DESC' },
            take: 100,
        });
    }

    /**
     * EW-P4-3 — link a message to the Task it spawned or joined. Only fills an
     * EMPTY link: a message already bound to a Task keeps it.
     */
    async linkTask(id: string, taskId: string): Promise<boolean> {
        const result = await this.repository.update({ id, taskId: IsNull() }, { taskId });
        const linked = (result.affected ?? 0) > 0;
        if (linked) {
            await this.notify({
                kind: 'status',
                id,
                changedFields: ['taskId'],
                previous: { taskId: null },
            });
        }
        return linked;
    }

    async findByUser(
        userId: string,
        options: EmailMessageQueryOptions = {},
    ): Promise<EmailMessage[]> {
        const qb = this.repository.createQueryBuilder('m').where('m.userId = :userId', { userId });
        if (options.direction)
            qb.andWhere('m.direction = :direction', { direction: options.direction });
        if (options.agentId) qb.andWhere('m.agentId = :agentId', { agentId: options.agentId });
        if (options.taskId) qb.andWhere('m.taskId = :taskId', { taskId: options.taskId });
        if (options.conversationId)
            qb.andWhere('m.conversationId = :conversationId', {
                conversationId: options.conversationId,
            });
        if (options.emailAddressId)
            qb.andWhere('m.emailAddressId = :emailAddressId', {
                emailAddressId: options.emailAddressId,
            });
        qb.orderBy('m.createdAt', 'DESC')
            .skip(options.offset ?? 0)
            .take(Math.min(options.limit ?? 50, 100));
        return qb.getMany();
    }

    async updateDeliveryStatus(id: string, deliveryStatus: string): Promise<void> {
        const result = await this.repository.update({ id }, { deliveryStatus });
        if ((result.affected ?? 0) > 0) {
            await this.notify({
                kind: 'status',
                id,
                changedFields: ['deliveryStatus'],
                previous: {},
            });
        }
    }

    // ── AW-05 — send ceilings + draft lifecycle ─────────────────────

    /**
     * Outbound messages that actually went out (`sentAt` set) since `since`.
     * A draft, a discarded draft and a refused send have no `sentAt`, so none
     * of them spends capacity.
     */
    async countOutboundSentSince(filter: EmailSendWindowFilter, since: Date): Promise<number> {
        return this.repository.count({ where: this.sentWindowWhere(filter, since) });
    }

    /** Send times inside the window, oldest first — used to say when capacity returns. */
    async listOutboundSentAtSince(
        filter: EmailSendWindowFilter,
        since: Date,
        limit = 1000,
    ): Promise<Date[]> {
        const rows = await this.repository.find({
            select: { id: true, sentAt: true },
            where: this.sentWindowWhere(filter, since),
            order: { sentAt: 'ASC' },
            take: Math.max(1, Math.min(limit, 10_000)),
        });
        return rows.map((row) => row.sentAt).filter((value): value is Date => !!value);
    }

    /**
     * Every recipient (to + cc + bcc) an Agent reached since `since`.
     *
     * Reads the WHOLE window by default. The distinct-recipient ceiling is
     * computed from this list, so stopping at a row count would undercount a
     * busy window and admit a recipient past the ceiling. Rows are read in
     * pages keyed on `id` (never an offset): a reservation released while the
     * window is being read (its `sentAt` cleared) cannot shift a later page
     * and hide a row that is still in the window.
     *
     * `limit` (optional) caps the number of ROWS read, for callers that only
     * want a sample.
     */
    async listOutboundRecipientsSince(
        agentId: string,
        since: Date,
        limit?: number,
    ): Promise<string[]> {
        const base = this.sentWindowWhere({ agentId }, since);
        const maxRows =
            limit === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(limit));
        const recipients: string[] = [];
        let read = 0;
        let afterId: string | null = null;
        while (read < maxRows) {
            const take = Math.min(EMAIL_RECIPIENT_WINDOW_PAGE_SIZE, maxRows - read);
            const rows: EmailMessage[] = await this.repository.find({
                select: { id: true, toAddresses: true, ccAddresses: true, bccAddresses: true },
                where: afterId === null ? base : { ...base, id: MoreThan(afterId) },
                order: { id: 'ASC' },
                take,
            });
            for (const row of rows) {
                recipients.push(
                    ...(row.toAddresses ?? []),
                    ...(row.ccAddresses ?? []),
                    ...(row.bccAddresses ?? []),
                );
            }
            read += rows.length;
            if (rows.length < take) break;
            afterId = rows[rows.length - 1].id;
        }
        return recipients;
    }

    /**
     * Held drafts a PERSON approved in the approvals queue that were never
     * released: still `draft`, never attempted (no `failureReason` — a draft
     * a ceiling sent back carries one and waits for a person again), linked
     * to a proposal decided `approved` by a user at or before `decidedBefore`.
     *
     * The decision event that normally releases them is in-process; this is
     * the durable half that finds what a lost event or a failed listener
     * left behind. Oldest decision first.
     */
    async findApprovedUnreleasedDrafts(
        decidedBefore: Date,
        limit = 50,
    ): Promise<Array<{ messageId: string; userId: string; decidedById: string }>> {
        const rows = await this.repository
            .createQueryBuilder('m')
            .innerJoin(AgentActionProposal, 'p', 'p.id = m.approvalId AND p.userId = m.userId')
            .select('m.id', 'messageId')
            .addSelect('m.userId', 'userId')
            .addSelect('p.decidedById', 'decidedById')
            .where('m.direction = :direction', { direction: 'outbound' })
            .andWhere('m.status = :status', { status: 'draft' })
            .andWhere('m.failureReason IS NULL')
            .andWhere('p.status = :approved', { approved: 'approved' })
            .andWhere('p.decidedVia = :via', { via: 'user' })
            .andWhere('p.decidedById IS NOT NULL')
            .andWhere('p.decidedAt <= :decidedBefore', { decidedBefore })
            .orderBy('p.decidedAt', 'ASC')
            .limit(Math.max(1, Math.min(limit, 500)))
            .getRawMany<{ messageId: string; userId: string; decidedById: string }>();
        return rows;
    }

    /**
     * Compare-and-set on `status`: move a row from one of `from` to `to`,
     * applying `patch` in the same UPDATE. Returns the number of rows that
     * moved — `0` means somebody else moved it first. Every race guard on the
     * draft lifecycle is built on this.
     */
    async transitionStatus(
        id: string,
        from: readonly EmailMessageStatus[],
        to: EmailMessageStatus,
        patch: Partial<
            Pick<
                EmailMessage,
                | 'approvedById'
                | 'approvedAt'
                | 'failureReason'
                | 'approvalId'
                | 'providerMessageId'
                | 'sentAt'
                | 'deliveryStatus'
                | 'pluginId'
                | 'messageIdHeader'
                | 'inReplyTo'
                | 'references'
            >
        > = {},
    ): Promise<number> {
        const result = await this.repository.update(
            { id, status: In([...from]) },
            { ...patch, status: to },
        );
        const moved = result.affected ?? 0;
        if (moved > 0) {
            await this.notify({
                kind: 'status',
                id,
                to,
                changedFields: ['status', ...emailMessageDtoFields(Object.keys(patch))],
                previous: from.length === 1 ? { status: from[0] } : {},
            });
        }
        return moved;
    }

    /**
     * Prompt-injection hardening (agent email) — everyone one Agent of this
     * owner has actually corresponded with: the senders of the mail it
     * received, and the recipients of the mail it really SENT (`sentAt` set —
     * a draft or a refused send is not correspondence). The newest `limit`
     * messages are read; addresses are returned as stored (callers normalize).
     */
    async listCorrespondentAddresses(
        userId: string,
        agentId: string,
        limit = 500,
    ): Promise<string[]> {
        const rows = await this.repository.find({
            select: {
                id: true,
                direction: true,
                from: true,
                toAddresses: true,
                ccAddresses: true,
                bccAddresses: true,
            },
            where: [
                { userId, agentId, direction: 'inbound' },
                { userId, agentId, direction: 'outbound', sentAt: Not(IsNull()) },
            ],
            order: { createdAt: 'DESC' },
            take: Math.max(1, Math.min(limit, 2_000)),
        });
        const out: string[] = [];
        for (const row of rows) {
            if (row.direction === 'inbound') {
                if (row.from) out.push(row.from);
                continue;
            }
            out.push(
                ...(row.toAddresses ?? []),
                ...(row.ccAddresses ?? []),
                ...(row.bccAddresses ?? []),
            );
        }
        return out;
    }

    private sentWindowWhere(
        filter: EmailSendWindowFilter,
        since: Date,
    ): FindOptionsWhere<EmailMessage> {
        if (!filter.agentId && !filter.userId) {
            // Never count across every account: a window with no owner is a bug.
            throw new Error('EmailMessageRepository: a send window needs an agentId or a userId.');
        }
        const where: FindOptionsWhere<EmailMessage> = {
            direction: 'outbound',
            sentAt: MoreThanOrEqual(since),
        };
        if (filter.agentId) where.agentId = filter.agentId;
        if (filter.userId) where.userId = filter.userId;
        return where;
    }
}

/**
 * EW-P4-2 — the integration DTO field (`IntegrationEmailMessageDto`) each
 * `email_messages` column shows as. A column the DTO does not show (bcc, the
 * provider ids, approval bookkeeping, metadata …) changes no event.
 */
const EMAIL_MESSAGE_DTO_FIELDS: Readonly<Record<string, string>> = {
    userId: 'ownerUserId',
    agentId: 'agentId',
    taskId: 'taskId',
    conversationId: 'conversationId',
    direction: 'direction',
    status: 'status',
    deliveryStatus: 'deliveryStatus',
    from: 'from',
    toAddresses: 'to',
    ccAddresses: 'cc',
    subject: 'subject',
    bodyText: 'text',
    bodyHtml: 'html',
    messageIdHeader: 'messageId',
    inReplyTo: 'inReplyTo',
    references: 'references',
    attachments: 'attachments',
    sentAt: 'sentAt',
    receivedAt: 'receivedAt',
};

/** Small values an event carries in `previous` (never a body or an address list). */
const EMAIL_MESSAGE_PREVIOUS_FIELDS = new Set([
    'status',
    'deliveryStatus',
    'taskId',
    'conversationId',
]);

/** The DTO names of `columns`, de-duplicated, dropping columns the DTO does not show. */
export function emailMessageDtoFields(columns: readonly string[]): string[] {
    const fields = columns
        .map((column) => EMAIL_MESSAGE_DTO_FIELDS[column])
        .filter((field): field is string => !!field);
    return [...new Set(fields)];
}

function withoutRecorderColumns(entry: EmailMessage): EmailMessage {
    const {
        version: _version,
        updatedAt: _updatedAt,
        ...writable
    } = entry as EmailMessage & { version?: number; updatedAt?: Date };
    return writable as EmailMessage;
}

function comparable(value: unknown): unknown {
    if (value === undefined || value === null) return null;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
}

/**
 * EW-P4-2 — what a `save` of an existing row changed, as DTO fields: only the
 * columns the write carried and whose value differs from the row before it.
 */
export function describeEmailMessageChange(
    before: EmailMessage,
    after: Partial<EmailMessage>,
): {
    to?: EmailMessageStatus;
    changedFields: string[];
    previous: Record<string, unknown>;
} {
    const columns = Object.keys(EMAIL_MESSAGE_DTO_FIELDS).filter(
        (column) =>
            Object.prototype.hasOwnProperty.call(after, column) &&
            comparable((after as Record<string, unknown>)[column]) !==
                comparable((before as unknown as Record<string, unknown>)[column]),
    );
    const previous: Record<string, unknown> = {};
    for (const column of columns) {
        if (EMAIL_MESSAGE_PREVIOUS_FIELDS.has(column)) {
            previous[EMAIL_MESSAGE_DTO_FIELDS[column]] =
                (before as unknown as Record<string, unknown>)[column] ?? null;
        }
    }
    const statusMoved = columns.includes('status') && !!after.status;
    return {
        ...(statusMoved ? { to: after.status as EmailMessageStatus } : {}),
        changedFields: emailMessageDtoFields(columns),
        previous,
    };
}

/**
 * EW-P4-2 — one write {@link EmailMessageRepository} made to `email_messages`:
 * a new row (`created`), or a change to an existing one (`status`: its status,
 * delivery status or Task link; `to` set when the lifecycle status moved).
 */
export type EmailMessageChange =
    | { readonly kind: 'created'; readonly id: string }
    | {
          readonly kind: 'status';
          readonly id: string;
          readonly to?: EmailMessageStatus;
          readonly changedFields: readonly string[];
          readonly previous: Readonly<Record<string, unknown>>;
      };

/** Receives every {@link EmailMessageChange}, after the write. Must not throw into the write. */
export type EmailMessageChangeListener = (change: EmailMessageChange) => Promise<void>;
