import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Repository } from 'typeorm';
import {
    approverDecisionCountsTowardDone,
    isCommitBoundApproverDecision,
} from '../../tasks-domain/task-agent-review';
import { serializeOnSingleConnection } from './single-connection-write-queue';
import { TaskAssignee } from '../../entities/task-assignee.entity';
import { TaskReviewer } from '../../entities/task-reviewer.entity';
import { TaskApprover } from '../../entities/task-approver.entity';
import { TaskBlock } from '../../entities/task-block.entity';
import { TaskRelation } from '../../entities/task-relation.entity';
import { TaskChatMessage } from '../../entities/task-chat-message.entity';
import { TaskAttachment } from '../../entities/task-attachment.entity';
import { TaskWatcher } from '../../entities/task-watcher.entity';
import { TaskKbMention } from '../../entities/task-kb-mention.entity';
import { UserTaskCounter } from '../../entities/user-task-counter.entity';

/**
 * Tasks feature — Phase 11.5. Side-table repositories for the Task
 * family. Grouped in one file so future contributors see the full
 * surface in one place; each class has the narrow CRUD it needs to
 * support the service.
 */

@Injectable()
export class TaskAssigneeRepository {
    constructor(@InjectRepository(TaskAssignee) private readonly repo: Repository<TaskAssignee>) {}

    async findByTaskId(taskId: string): Promise<TaskAssignee[]> {
        return this.repo.find({ where: { taskId } });
    }
    async findAgentAssignees(taskId: string): Promise<TaskAssignee[]> {
        return this.repo.find({ where: { taskId, assigneeType: 'agent' } });
    }
    /**
     * Tasks upgrades — batch lookup for the sub-tasks projection. ONE
     * IN query instead of a per-row fetch; callers group by `taskId`.
     * Security: `taskIds` must already be owner-scoped by the caller.
     */
    async findByTaskIds(taskIds: string[]): Promise<TaskAssignee[]> {
        if (taskIds.length === 0) return [];
        return this.repo.find({ where: { taskId: In(taskIds) } });
    }
    async add(
        taskId: string,
        assigneeType: 'user' | 'agent',
        assigneeId: string,
    ): Promise<TaskAssignee> {
        const entity = this.repo.create({ taskId, assigneeType, assigneeId });
        return this.repo.save(entity);
    }
    // Security (IDOR): optional `taskId` scopes the delete to a single
    // task so a side-row PK from another tenant's task can never be
    // removed by passing an owned `taskId`. When omitted, behavior is
    // unchanged (callers that already verify ownership upstream keep
    // working); new callers SHOULD pass `taskId` for defense-in-depth.
    async remove(id: string, taskId?: string): Promise<void> {
        await this.repo.delete(taskId ? { id, taskId } : id);
    }
    async removeForTask(taskId: string, id: string): Promise<boolean> {
        const result = await this.repo.delete({ id, taskId });
        return (result.affected ?? 0) > 0;
    }
}

@Injectable()
export class TaskReviewerRepository {
    constructor(@InjectRepository(TaskReviewer) private readonly repo: Repository<TaskReviewer>) {}

    async findByTaskId(taskId: string): Promise<TaskReviewer[]> {
        return this.repo.find({ where: { taskId } });
    }
    async add(
        taskId: string,
        reviewerType: 'user' | 'agent',
        reviewerId: string,
    ): Promise<TaskReviewer> {
        const entity = this.repo.create({ taskId, reviewerType, reviewerId });
        return this.repo.save(entity);
    }
    async setState(
        id: string,
        reviewState: 'pending' | 'requested-changes' | 'approved',
        taskId?: string,
    ): Promise<void> {
        // Security (IDOR): optional `taskId` scopes the update so a
        // reviewer row from another task can't be mutated by PK alone.
        await this.repo.update(taskId ? { id, taskId } : id, {
            reviewState,
            reviewedAt: new Date(),
        });
    }
    // Security (IDOR): optional `taskId` scopes the delete (see
    // TaskAssigneeRepository.remove). Behavior unchanged when omitted.
    async remove(id: string, taskId?: string): Promise<void> {
        await this.repo.delete(taskId ? { id, taskId } : id);
    }
    async removeForTask(taskId: string, id: string): Promise<boolean> {
        const result = await this.repo.delete({ id, taskId });
        return (result.affected ?? 0) > 0;
    }
}

@Injectable()
export class TaskApproverRepository {
    constructor(@InjectRepository(TaskApprover) private readonly repo: Repository<TaskApprover>) {}

    async findByTaskId(taskId: string): Promise<TaskApprover[]> {
        return this.repo.find({ where: { taskId } });
    }
    /** Tasks upgrades — batch lookup for the sub-tasks projection
     *  (approval badge per row). Owner-scoping is the caller's job. */
    async findByTaskIds(taskIds: string[]): Promise<TaskApprover[]> {
        if (taskIds.length === 0) return [];
        return this.repo.find({ where: { taskId: In(taskIds) } });
    }
    async add(
        taskId: string,
        approverType: 'user' | 'agent',
        approverId: string,
    ): Promise<TaskApprover> {
        const entity = this.repo.create({ taskId, approverType, approverId });
        return this.repo.save(entity);
    }
    /**
     * Write an approver row's decision.
     *
     * `provenance` (reviewer agent stage, slice AD, EW-811) is APPENDED
     * LAST and optional so every existing positional call keeps its
     * meaning. When omitted the three provenance columns are left exactly
     * as they were. An AGENT verdict does not come through here: it is
     * written by `TaskAgentReviewRepository.recordVerdict`, in the same
     * transaction as the review ledger transition it depends on (Greptile
     * P1-B on PR #2419). A future human-decision route should supply
     * `decidedVia: 'user'`.
     *
     * These columns are provenance, never authorization: `task_approvers`
     * gates `in_review → done` and nothing else, and the merge gate reads
     * a different table entirely (see the entity doc).
     */
    async setState(
        id: string,
        approvalState: 'pending' | 'approved' | 'rejected',
        taskId?: string,
        provenance?: {
            decidedVia?: string | null;
            decidedByRunId?: string | null;
            decidedHeadSha?: string | null;
        },
    ): Promise<void> {
        const patch: Partial<TaskApprover> = {
            approvalState,
            approvedAt: new Date(),
        };
        if (provenance) {
            patch.decidedVia = provenance.decidedVia ?? null;
            patch.decidedByRunId = provenance.decidedByRunId ?? null;
            patch.decidedHeadSha = provenance.decidedHeadSha ?? null;
        }
        // Security (IDOR): optional `taskId` scopes the update so an
        // approver row from another task can't be mutated by PK alone.
        await this.repo.update(taskId ? { id, taskId } : id, patch);
    }
    // Security (IDOR): optional `taskId` scopes the delete (see
    // TaskAssigneeRepository.remove). Behavior unchanged when omitted.
    async remove(id: string, taskId?: string): Promise<void> {
        await this.repo.delete(taskId ? { id, taskId } : id);
    }
    async removeForTask(taskId: string, id: string): Promise<boolean> {
        const result = await this.repo.delete({ id, taskId });
        return (result.affected ?? 0) > 0;
    }
    /**
     * THE `in_review → done` approver gate.
     *
     * `currentHead` (reviewer agent stage, Greptile P1-A on PR #2419) is
     * APPENDED LAST: the Task's current pull request head. A commit-bound
     * decision — every AGENT approver row, and anything stamped
     * `agent-review` — counts only when it was rendered against exactly that
     * head. Before this, the gate read `approvalState` alone, so an agent
     * approval for head A satisfied it after the pull request had moved to
     * head B that nobody reviewed.
     *
     * It may be a value or a RESOLVER. The resolver is called at most once,
     * and only when the answer depends on it — every row is `approved` and at
     * least one of them is commit-bound — so a Task gated by people alone, or
     * one that is refused anyway, never costs the provider read
     * `TaskTransitionService` makes to answer it.
     *
     * Omitted, `null`, unparseable, or a resolver that throws = the head is
     * unknown = NO commit-bound decision counts. Fail closed: a caller that
     * cannot say which commit is current cannot have an agent approval
     * checked against it.
     *
     * USER approver rows are deliberately unchanged — `approved` counts —
     * because nothing binds a human's approver decision to a commit and
     * silently reinterpreting one would change what a person's approval
     * means. See `approverDecisionCountsTowardDone`.
     */
    async allApproved(taskId: string, currentHead?: CompletionGateHead): Promise<boolean> {
        const rows = await this.repo.find({ where: { taskId } });
        // Review-fix I2: spec FR-11 phrases the gate as "if any
        // approvers are configured" — a Task with NO approvers should
        // pass the gate (rows.length === 0 → return true). The
        // previous behavior locked any approver-less Task out of
        // `done` permanently unless force=true was used.
        if (rows.length === 0) return true;
        if (rows.some((row) => row.approvalState !== 'approved')) return false;
        const head = rows.some((row) => isCommitBoundApproverDecision(row))
            ? await resolveGateHead(currentHead)
            : null;
        return rows.every((r) => approverDecisionCountsTowardDone(r, head));
    }

    /**
     * Put ONE stale agent decision back to `pending` so it is reviewed
     * again (reviewer agent stage, Greptile P1-A on PR #2419).
     *
     * Compare-and-set on EXACTLY the decision the caller read — state,
     * provenance and head — so a verdict that lands between that read and
     * this write (a fresh decision about the live head) is never clobbered:
     * it no longer matches, and this affects zero rows. Only an AGENT row is
     * ever touched. The provenance columns go back to NULL, which is what a
     * `pending` row carries (see the entity).
     *
     * Returns whether the row was reset.
     */
    async resetAgentDecisionToPending(observed: {
        id: string;
        taskId: string;
        approvalState: 'approved' | 'rejected';
        decidedVia?: string | null;
        decidedHeadSha?: string | null;
    }): Promise<boolean> {
        const result = await serializeOnSingleConnection(this.repo.manager, () =>
            this.repo.update(
                {
                    id: observed.id,
                    taskId: observed.taskId,
                    approverType: 'agent',
                    approvalState: observed.approvalState,
                    decidedVia: observed.decidedVia ?? IsNull(),
                    decidedHeadSha: observed.decidedHeadSha ?? IsNull(),
                },
                {
                    approvalState: 'pending',
                    approvedAt: null,
                    decidedVia: null,
                    decidedByRunId: null,
                    decidedHeadSha: null,
                },
            ),
        );
        return (result.affected ?? 0) > 0;
    }

    /**
     * Put a verdict the review LEDGER already holds for exactly this head
     * back onto a `pending` agent approver row (reviewer agent stage, review
     * of Greptile P1-A on PR #2419).
     *
     * Head-bound decisions plus one review per (reviewer, head) meant a
     * verdict could be lost for good: approve A, push B (the approval is
     * reset to pending and B is reviewed), force-push back to A — the
     * `(reviewer, A)` claim already exists, so nothing could ever buy A a
     * review again, and the approver stayed `pending` at a commit its
     * reviewer had approved. `TaskAgentReviewService.planReviews` calls this
     * when the LIVE head's claim already exists and that ledger row is a
     * terminal verdict for this very approver row.
     *
     * Compare-and-set from `pending` only, on an AGENT row naming this
     * reviewer: a decision that landed since the caller looked (a fresh
     * verdict, or a human's) is never overwritten. Returns whether the row
     * took the decision.
     */
    async restoreAgentDecisionFromReview(input: {
        id: string;
        taskId: string;
        reviewerAgentId: string;
        approvalState: 'approved' | 'rejected';
        decidedByRunId: string | null;
        decidedHeadSha: string;
    }): Promise<boolean> {
        const result = await serializeOnSingleConnection(this.repo.manager, () =>
            this.repo.update(
                {
                    id: input.id,
                    taskId: input.taskId,
                    approverType: 'agent',
                    approverId: input.reviewerAgentId,
                    approvalState: 'pending',
                },
                {
                    approvalState: input.approvalState,
                    approvedAt: new Date(),
                    decidedVia: 'agent-review',
                    decidedByRunId: input.decidedByRunId,
                    decidedHeadSha: input.decidedHeadSha,
                },
            ),
        );
        return (result.affected ?? 0) > 0;
    }
}

/**
 * What `TaskApproverRepository.allApproved` is told about the current pull
 * request head: the head itself, or a resolver it calls only when a
 * commit-bound decision needs checking.
 */
export type CompletionGateHead = string | null | (() => Promise<string | null>);

async function resolveGateHead(head: CompletionGateHead | undefined): Promise<string | null> {
    if (typeof head !== 'function') return head ?? null;
    try {
        return (await head()) ?? null;
    } catch {
        // A head nobody could read is an unknown head. Fail closed.
        return null;
    }
}

@Injectable()
export class TaskBlockRepository {
    constructor(@InjectRepository(TaskBlock) private readonly repo: Repository<TaskBlock>) {}

    async findByTaskId(taskId: string): Promise<TaskBlock[]> {
        return this.repo.find({ where: { taskId } });
    }
    async findBlockingTasks(blockedByTaskId: string): Promise<TaskBlock[]> {
        return this.repo.find({ where: { blockedByTaskId } });
    }

    /**
     * Review-fix I1 helper. Returns the IDs of every Task that's
     * blocked BY `blockerTaskId` — used by
     * `TaskTransitionService.autoUnblockResolvedTasks` to find
     * candidates whose `blocked` status should be restored when a
     * blocker resolves.
     */
    async findTasksBlockedBy(blockerTaskId: string): Promise<string[]> {
        const rows = await this.repo.find({ where: { blockedByTaskId: blockerTaskId } });
        return rows.map((r) => r.taskId);
    }
    async add(taskId: string, blockedByTaskId: string): Promise<TaskBlock> {
        const entity = this.repo.create({ taskId, blockedByTaskId });
        return this.repo.save(entity);
    }
    // Security (IDOR): optional `taskId` scopes the delete (see
    // TaskAssigneeRepository.remove). Behavior unchanged when omitted.
    async remove(id: string, taskId?: string): Promise<void> {
        await this.repo.delete(taskId ? { id, taskId } : id);
    }
    async removeForTask(taskId: string, id: string): Promise<boolean> {
        const result = await this.repo.delete({ id, taskId });
        return (result.affected ?? 0) > 0;
    }
}

@Injectable()
export class TaskRelationRepository {
    constructor(@InjectRepository(TaskRelation) private readonly repo: Repository<TaskRelation>) {}

    async findByTaskId(taskId: string): Promise<TaskRelation[]> {
        return this.repo.find({ where: { taskId } });
    }
    async add(
        taskId: string,
        relatedTaskId: string,
        kind: 'related' | 'duplicates' | 'follow-up',
    ): Promise<TaskRelation> {
        const entity = this.repo.create({ taskId, relatedTaskId, kind });
        return this.repo.save(entity);
    }
    // Security (IDOR): optional `taskId` scopes the delete (see
    // TaskAssigneeRepository.remove). Behavior unchanged when omitted.
    async remove(id: string, taskId?: string): Promise<void> {
        await this.repo.delete(taskId ? { id, taskId } : id);
    }
    async removeForTask(taskId: string, id: string): Promise<boolean> {
        const result = await this.repo.delete({ id, taskId });
        return (result.affected ?? 0) > 0;
    }
}

@Injectable()
export class TaskChatMessageRepository {
    constructor(
        @InjectRepository(TaskChatMessage) private readonly repo: Repository<TaskChatMessage>,
    ) {}

    async findByTaskId(taskId: string, limit = 50, offset = 0): Promise<TaskChatMessage[]> {
        return this.repo.find({
            where: { taskId },
            order: { createdAt: 'ASC' },
            take: limit,
            skip: offset,
        });
    }
    async findById(id: string): Promise<TaskChatMessage | null> {
        return this.repo.findOne({ where: { id } });
    }
    async create(data: Partial<TaskChatMessage>): Promise<TaskChatMessage> {
        const entity = this.repo.create(data);
        return this.repo.save(entity);
    }
    async updateBody(id: string, body: string): Promise<void> {
        await this.repo.update(id, { body, editedAt: new Date() });
    }
    /**
     * Review-fix I3: persist re-parsed mentions on chat edit so the
     * materialized `mentions` JSON column stays honest when the user
     * removes (or changes) a mention during the 5-min edit window.
     */
    async updateBodyAndMentions(
        id: string,
        body: string,
        mentions: Array<{ type: 'user' | 'agent' | 'kb'; id?: string; slug?: string }> | null,
    ): Promise<void> {
        await this.repo.update(id, {
            body,
            mentions: mentions && mentions.length > 0 ? mentions : null,
            editedAt: new Date(),
        });
    }
}

@Injectable()
export class TaskAttachmentRepository {
    constructor(
        @InjectRepository(TaskAttachment) private readonly repo: Repository<TaskAttachment>,
    ) {}

    async findByTaskId(taskId: string): Promise<TaskAttachment[]> {
        return this.repo.find({ where: { taskId } });
    }
    /**
     * Memory Files provenance — every Task edge referencing any of the
     * given `work_knowledge_uploads` ids, in ONE query (no N+1). Used to
     * batch-map "which Task attached this original" onto the unified
     * /memory Files rows.
     */
    async findByUploadIds(uploadIds: string[]): Promise<TaskAttachment[]> {
        if (uploadIds.length === 0) return [];
        return this.repo
            .createQueryBuilder('attachment')
            .where('attachment.uploadId IN (:...uploadIds)', { uploadIds })
            .getMany();
    }
    async add(
        taskId: string,
        uploadId: string,
        role: 'initial' | 'result' = 'initial',
    ): Promise<TaskAttachment> {
        const entity = this.repo.create({ taskId, uploadId, role });
        return this.repo.save(entity);
    }
    // Security (IDOR): optional `taskId` scopes the delete (see
    // TaskAssigneeRepository.remove). Behavior unchanged when omitted.
    async remove(id: string, taskId?: string): Promise<void> {
        await this.repo.delete(taskId ? { id, taskId } : id);
    }
    async removeForTask(taskId: string, id: string): Promise<boolean> {
        const result = await this.repo.delete({ id, taskId });
        return (result.affected ?? 0) > 0;
    }
}

@Injectable()
export class TaskWatcherRepository {
    constructor(@InjectRepository(TaskWatcher) private readonly repo: Repository<TaskWatcher>) {}

    async findByTaskId(taskId: string): Promise<TaskWatcher[]> {
        return this.repo.find({ where: { taskId } });
    }
    async findByUserId(userId: string): Promise<TaskWatcher[]> {
        return this.repo.find({ where: { userId } });
    }
    async add(taskId: string, userId: string): Promise<TaskWatcher> {
        const entity = this.repo.create({ taskId, userId });
        return this.repo.save(entity);
    }
    // Security (IDOR): optional `taskId` scopes the delete (see
    // TaskAssigneeRepository.remove). Behavior unchanged when omitted.
    async remove(id: string, taskId?: string): Promise<void> {
        await this.repo.delete(taskId ? { id, taskId } : id);
    }
}

@Injectable()
export class TaskKbMentionRepository {
    constructor(
        @InjectRepository(TaskKbMention) private readonly repo: Repository<TaskKbMention>,
    ) {}

    async findByTaskId(taskId: string): Promise<TaskKbMention[]> {
        return this.repo.find({ where: { taskId } });
    }
    async findByKbDocumentId(kbDocumentId: string): Promise<TaskKbMention[]> {
        return this.repo.find({ where: { kbDocumentId } });
    }
    async add(taskId: string, kbDocumentId: string): Promise<TaskKbMention> {
        const entity = this.repo.create({ taskId, kbDocumentId });
        return this.repo.save(entity);
    }
    // Security (IDOR): optional `taskId` scopes the delete (see
    // TaskAssigneeRepository.remove). Behavior unchanged when omitted.
    async remove(id: string, taskId?: string): Promise<void> {
        await this.repo.delete(taskId ? { id, taskId } : id);
    }
}

/**
 * Atomic per-user slug sequence. `nextSlug` runs an INSERT … ON
 * CONFLICT DO UPDATE pattern so two parallel inserts can never
 * collide on the same lastSlugNumber. SQLite's UPSERT and
 * Postgres's INSERT … ON CONFLICT … RETURNING both honor this.
 */
@Injectable()
export class UserTaskCounterRepository {
    constructor(
        @InjectRepository(UserTaskCounter) private readonly repo: Repository<UserTaskCounter>,
    ) {}

    async findByUserId(userId: string): Promise<UserTaskCounter | null> {
        return this.repo.findOne({ where: { userId } });
    }

    /**
     * Bumps the per-user counter and returns the new value. Caller
     * formats the slug (`T-<n>`). Two-step fallback path: try increment;
     * if row doesn't exist, INSERT { userId, lastSlugNumber: 1 }
     * and return 1. Re-tries the increment if the INSERT raced a
     * concurrent one.
     */
    async nextSlug(userId: string): Promise<number> {
        // Review-fix C10: single-round-trip INSERT … ON CONFLICT
        // DO UPDATE … RETURNING avoids the original two-statement
        // race (where two concurrent callers could read the same
        // post-increment value and produce duplicate `T-N` slugs,
        // compounding C1's per-user uniqueness constraint).
        //
        // Postgres-specific syntax; for SQLite (dev/test) the
        // equivalent ON CONFLICT DO UPDATE clause is honored
        // identically by both drivers in TypeORM's raw query path.
        const driverType = this.repo.manager.connection.options.type;
        // NOTE (second-pass fix): the `user_task_counter` entity +
        // migration declare only userId / lastSlugNumber / updatedAt —
        // no `createdAt` column. Earlier draft referenced it and would
        // have failed at runtime. SQL below now matches the schema.
        if (driverType === 'postgres' || driverType === 'cockroachdb') {
            const rows = await this.repo.query(
                `INSERT INTO user_task_counter ("userId", "lastSlugNumber", "updatedAt")
				 VALUES ($1, 1, now())
				 ON CONFLICT ("userId") DO UPDATE
					 SET "lastSlugNumber" = user_task_counter."lastSlugNumber" + 1,
						 "updatedAt" = now()
				 RETURNING "lastSlugNumber"`,
                [userId],
            );
            return Number(rows[0]?.lastSlugNumber ?? 1);
        }
        // SQLite path — same shape, lowercase column names.
        const rows = await this.repo.query(
            `INSERT INTO user_task_counter (userId, lastSlugNumber, updatedAt)
			 VALUES (?, 1, datetime('now'))
			 ON CONFLICT(userId) DO UPDATE
				 SET lastSlugNumber = user_task_counter.lastSlugNumber + 1,
					 updatedAt = datetime('now')
			 RETURNING lastSlugNumber`,
            [userId],
        );
        return Number(rows[0]?.lastSlugNumber ?? rows[0]?.lastslugnumber ?? 1);
    }

    /** Test/debug helper — list rows older than a cutoff. */
    async findStale(olderThan: Date): Promise<UserTaskCounter[]> {
        return this.repo.find({ where: { updatedAt: LessThan(olderThan) } });
    }
}
