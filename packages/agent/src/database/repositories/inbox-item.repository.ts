import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, IsNull, Repository, type SelectQueryBuilder } from 'typeorm';
import {
    INBOX_DECISION_KINDS,
    INBOX_DECISION_MAX_LIMIT,
    INBOX_DECISION_PAGE_SIZE,
    INBOX_DECISION_UNSCORED_RANK,
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
import { AgentRun } from '../../entities/agent-run.entity';
import { Task } from '../../entities/task.entity';
import { AgentEscalation } from '../../entities/agent-escalation.entity';
import { AgentActionProposal } from '../../entities/agent-action-proposal.entity';
import { Agent } from '../../entities/agent.entity';
import {
    buildCaseInsensitiveLikeClause,
    prepareCaseInsensitiveContainsPattern,
} from '../utils/db.utils';

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

/** Filters of the decision view of the Inbox (My Decisions). */
export interface ListInboxDecisionsOptions {
    /** Defaults to `open` — the queue. `answered` and `archived` are its other two tabs. */
    status?: InboxItemStatus;
    /** One decision kind; omitted = all three. A non-decision kind matches nothing. */
    kind?: InboxItemKind;
    agentId?: string;
    /** The item's own Task link, or the linked run's Task. */
    taskId?: string;
    /** The Mission the linked Task was raised under. */
    missionId?: string;
    /** Case-insensitive contains-match over the title and the body. */
    search?: string;
    /** Clamped to 1..{@link INBOX_DECISION_MAX_LIMIT}; defaults to {@link INBOX_DECISION_PAGE_SIZE}. */
    limit?: number;
    offset?: number;
}

/**
 * One decision-view row: the Inbox item plus the few facts the queue reads
 * from the records it links to. Raw, driver-shaped values are normalised
 * here so the service maps plain values.
 */
export interface InboxDecisionRow {
    item: InboxItem;
    runStatus: string | null;
    runParked: boolean;
    taskId: string | null;
    taskTitle: string | null;
    taskStatus: string | null;
    missionId: string | null;
    reasonCode: string | null;
    confidence: number | null;
    confidenceSource: string | null;
    attempted: unknown;
    actionType: string | null;
    riskFlags: unknown;
    agentName: string | null;
}

export interface InboxDecisionCountsRow {
    open: number;
    blocking: number;
    lastRaisedAt: Date | null;
}

/**
 * The one definition of "work is stopped behind this decision": the linked
 * run is parked waiting for the human, or the linked Task is `blocked`.
 * Used by the ranking AND the header count so the two can never disagree.
 */
const DECISION_BLOCKING_SQL =
    '(run.awaitingInput = :decisionParked OR task.status = :decisionBlocked)';

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

    /**
     * My Decisions — one user's decision items (questions, approvals,
     * escalations), with the facts the queue ranks and filters on read
     * from the records each item already links to.
     *
     * One page query plus one count, however long the page: every join is
     * at most one row per item (a run, a Task, an escalation, a proposal,
     * an Agent — each by primary key), and every join repeats the owner
     * predicate so a stale or foreign link reads as absent rather than
     * leaking another owner's Task title or run state.
     *
     * The open queue is ranked: blocking first, then escalation confidence
     * (an unscored item ranks at {@link INBOX_DECISION_UNSCORED_RANK}),
     * then OLDEST first — among equals the decision that has waited
     * longest goes to the top. The answered and archived tabs read newest
     * first, like the rest of the Inbox.
     */
    async listDecisionsForUser(
        userId: string,
        options: ListInboxDecisionsOptions = {},
    ): Promise<{ rows: InboxDecisionRow[]; total: number }> {
        const status = options.status ?? ('open' as InboxItemStatus);
        const limit = Math.max(
            1,
            Math.min(INBOX_DECISION_MAX_LIMIT, options.limit ?? INBOX_DECISION_PAGE_SIZE),
        );
        const offset = Math.max(0, options.offset ?? 0);
        if (options.kind && !(INBOX_DECISION_KINDS as readonly string[]).includes(options.kind)) {
            // A notice is not a decision: an explicit non-decision kind
            // matches nothing rather than silently widening to all three.
            return { rows: [], total: 0 };
        }

        const qb = this.decisionQuery(userId)
            .andWhere('item.status = :status', { status })
            .andWhere('item.kind IN (:...decisionKinds)', {
                decisionKinds: options.kind ? [options.kind] : [...INBOX_DECISION_KINDS],
            });
        if (options.agentId) {
            qb.andWhere('item.agentId = :agentId', { agentId: options.agentId });
        }
        if (options.taskId) {
            qb.andWhere('COALESCE(item.taskId, run.taskId) = :taskId', {
                taskId: options.taskId,
            });
        }
        if (options.missionId) {
            qb.andWhere('task.missionId = :missionId', { missionId: options.missionId });
        }
        const searchPattern = prepareCaseInsensitiveContainsPattern(options.search);
        if (searchPattern) {
            qb.andWhere(
                new Brackets((sub) => {
                    sub.where(buildCaseInsensitiveLikeClause('item.title', 'decisionSearch'), {
                        decisionSearch: searchPattern,
                    }).orWhere(buildCaseInsensitiveLikeClause('item.body', 'decisionSearch'), {
                        decisionSearch: searchPattern,
                    });
                }),
            );
        }

        const total = await qb.clone().getCount();

        qb.addSelect('run.status', 'decision_run_status')
            .addSelect('run.awaitingInput', 'decision_run_parked')
            .addSelect('task.id', 'decision_task_id')
            .addSelect('task.title', 'decision_task_title')
            .addSelect('task.status', 'decision_task_status')
            .addSelect('task.missionId', 'decision_mission_id')
            .addSelect('esc.reasonCode', 'decision_reason_code')
            .addSelect('esc.confidence', 'decision_confidence')
            .addSelect('esc.confidenceSource', 'decision_confidence_source')
            .addSelect('esc.attempted', 'decision_attempted')
            .addSelect('proposal.actionType', 'decision_action_type')
            .addSelect('proposal.riskFlags', 'decision_risk_flags')
            .addSelect('agent.name', 'decision_agent_name');

        if (status === 'open') {
            qb.addSelect(
                `CASE WHEN ${DECISION_BLOCKING_SQL} THEN 1 ELSE 0 END`,
                'decision_blocking_rank',
            )
                .addSelect('COALESCE(esc.confidence, :unscoredRank)', 'decision_confidence_rank')
                .setParameter('unscoredRank', INBOX_DECISION_UNSCORED_RANK)
                .orderBy('decision_blocking_rank', 'DESC')
                .addOrderBy('decision_confidence_rank', 'DESC')
                .addOrderBy('item.createdAt', 'ASC');
        } else if (status === 'answered') {
            qb.orderBy('item.answeredAt', 'DESC').addOrderBy('item.createdAt', 'DESC');
        } else {
            qb.orderBy('item.updatedAt', 'DESC');
        }
        // Stable paging across equal ranks.
        qb.addOrderBy('item.id', 'ASC');

        // `offset`/`limit` (SQL) rather than `skip`/`take`: every join is
        // one-to-one, so there is nothing for TypeORM's two-query
        // pagination to de-duplicate, and it cannot order by a select alias.
        const { entities, raw } = await qb.offset(offset).limit(limit).getRawAndEntities();
        const rawById = new Map<string, Record<string, unknown>>();
        for (const record of raw as Array<Record<string, unknown>>) {
            const id = record.item_id;
            if (typeof id === 'string' && !rawById.has(id)) rawById.set(id, record);
        }

        const rows = entities.map((item) => {
            const record = rawById.get(item.id) ?? {};
            return {
                item,
                runStatus: asString(record.decision_run_status),
                runParked: asBoolean(record.decision_run_parked),
                taskId: asString(record.decision_task_id),
                taskTitle: asString(record.decision_task_title),
                taskStatus: asString(record.decision_task_status),
                missionId: asString(record.decision_mission_id),
                reasonCode: asString(record.decision_reason_code),
                confidence: asNumber(record.decision_confidence),
                confidenceSource: asString(record.decision_confidence_source),
                attempted: asJson(record.decision_attempted),
                actionType: asString(record.decision_action_type),
                riskFlags: asJson(record.decision_risk_flags),
                agentName: asString(record.decision_agent_name),
            };
        });
        return { rows, total };
    }

    /**
     * My Decisions header + sidebar badge: open decisions, how many of
     * them have work stopped behind them (same predicate as the ranking),
     * and when the latest decision of any status was raised — which is
     * what separates "quiet lately" from "never had one".
     */
    async countDecisionsForUser(userId: string): Promise<InboxDecisionCountsRow> {
        const raw = await this.decisionQuery(userId)
            .select('COUNT(item.id)', 'open')
            .addSelect(`SUM(CASE WHEN ${DECISION_BLOCKING_SQL} THEN 1 ELSE 0 END)`, 'blocking')
            .andWhere('item.status = :status', { status: 'open' })
            .andWhere('item.kind IN (:...decisionKinds)', {
                decisionKinds: [...INBOX_DECISION_KINDS],
            })
            .getRawOne<{ open: unknown; blocking: unknown }>();

        const latest = await this.repository.findOne({
            where: { userId, kind: In([...INBOX_DECISION_KINDS]) },
            order: { createdAt: 'DESC' },
            select: { id: true, createdAt: true },
        });

        return {
            open: asNumber(raw?.open) ?? 0,
            blocking: asNumber(raw?.blocking) ?? 0,
            lastRaisedAt: latest?.createdAt ?? null,
        };
    }

    /**
     * Record the first time a human opened an item. Owner-scoped and
     * guarded on `firstViewedAt IS NULL`, so a second open never moves it.
     * Returns whether this call was the one that stamped it.
     */
    async stampFirstViewed(id: string, userId: string, at: Date = new Date()): Promise<boolean> {
        const result = await this.repository.update(
            { id, userId, firstViewedAt: IsNull() },
            { firstViewedAt: at },
        );
        return (result.affected ?? 0) > 0;
    }

    /**
     * The owner-scoped base of both decision reads: the item plus its
     * one-to-one links, each join repeating the owner predicate.
     */
    private decisionQuery(userId: string): SelectQueryBuilder<InboxItem> {
        return this.repository
            .createQueryBuilder('item')
            .leftJoin(AgentRun, 'run', 'run.id = item.agentRunId AND run.userId = item.userId')
            .leftJoin(
                Task,
                'task',
                'task.id = COALESCE(item.taskId, run.taskId) AND task.userId = item.userId',
            )
            .leftJoin(
                AgentEscalation,
                'esc',
                'esc.id = item.escalationId AND esc.userId = item.userId',
            )
            .leftJoin(
                AgentActionProposal,
                'proposal',
                'proposal.id = item.proposalId AND proposal.userId = item.userId',
            )
            .leftJoin(Agent, 'agent', 'agent.id = item.agentId AND agent.userId = item.userId')
            .where('item.userId = :userId', { userId })
            .setParameter('decisionParked', true)
            .setParameter('decisionBlocked', 'blocked');
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

// ── raw-value normalisers (Postgres and SQLite hand back different shapes) ──

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

/** SQLite returns 1/0, Postgres returns true/false. */
function asBoolean(value: unknown): boolean {
    return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}

/** A raw `simple-json` column: text on the wire, already-parsed on some drivers. */
function asJson(value: unknown): unknown {
    if (typeof value !== 'string') return value ?? null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}
