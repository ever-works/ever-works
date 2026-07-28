import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    AGENT_ESCALATION_MAX_ATTEMPT_ENTRIES,
    AGENT_ESCALATION_MAX_DECISION_CHARS,
    AGENT_ESCALATION_MAX_SUMMARY_CHARS,
    clampEscalationConfidence,
    type AgentEscalationAttempt,
    type AgentEscalationConfidenceSource,
    type AgentEscalationReasonCode,
    type AgentEscalationStatus,
} from '@ever-works/contracts';
import { AgentEscalation } from '../../entities/agent-escalation.entity';

export interface RecordEscalationInput {
    userId: string;
    reasonCode: AgentEscalationReasonCode;
    summary: string;
    decisionNeeded: string;
    runId?: string | null;
    taskId?: string | null;
    workId?: string | null;
    agentId?: string | null;
    attempted?: AgentEscalationAttempt[] | null;
    organizationId?: string | null;
    /**
     * Stable idempotency key. Omitted = derived from
     * `${reasonCode}:${runId ?? taskId ?? 'global'}`, which is the right
     * grain for every writer today: one give-up per reason per run.
     */
    dedupKey?: string | null;
    /**
     * How sure the platform is that this needs a HUMAN, `0..1`. Normally
     * supplied by `AgentEscalationService` from the confidence scorer;
     * a caller may pass its own when it knows better. Clamped here, so
     * no producer can store a value outside the unit interval.
     */
    confidence?: number | null;
    /** Which scorer produced {@link confidence}. Ignored when it is null. */
    confidenceSource?: AgentEscalationConfidenceSource | null;
}

/** Filter for {@link AgentEscalationRepository.listForUser}. */
export interface ListEscalationsForUserOptions {
    /** `undefined` = every status (the queue's "all" tab). */
    status?: AgentEscalationStatus;
    since?: Date;
    limit?: number;
    offset?: number;
}

/** Per-attempt caps applied before persisting (prompt-log guard). */
const MAX_ATTEMPT_LABEL_CHARS = 64;
const MAX_ATTEMPT_OUTCOME_CHARS = 300;
const MAX_ATTEMPT_DETAIL_CHARS = 1000;

/**
 * Judgment layer G3 — the escalation store.
 *
 * Every write is idempotent by `dedupKey`. That is not a nicety: the
 * writers are a Trigger.dev task that can retry, a sweeper tick that
 * re-scans the same rows, and a webhook that can be redelivered. Without
 * it, one give-up would render as five identical cards on the Task.
 */
@Injectable()
export class AgentEscalationRepository {
    private readonly logger = new Logger(AgentEscalationRepository.name);

    constructor(
        @InjectRepository(AgentEscalation)
        private readonly repository: Repository<AgentEscalation>,
    ) {}

    /**
     * Record one escalation, or return the existing row when this
     * `dedupKey` was already written.
     *
     * Race handling mirrors `NotificationService.create`: the pre-check
     * catches the common case, and the UNIQUE index catches the
     * concurrent one — a caught insert failure re-reads the winner's row
     * instead of throwing at a caller for whom escalation logging is
     * always a side effect, never the point.
     */
    async record(input: RecordEscalationInput): Promise<AgentEscalation | null> {
        const dedupKey =
            input.dedupKey ?? `${input.reasonCode}:${input.runId ?? input.taskId ?? 'global'}`;

        const existing = await this.repository.findOne({ where: { dedupKey } });
        if (existing) return existing;

        const row = this.repository.create({
            userId: input.userId,
            reasonCode: input.reasonCode,
            status: 'open' as AgentEscalationStatus,
            summary: (input.summary ?? '').slice(0, AGENT_ESCALATION_MAX_SUMMARY_CHARS),
            decisionNeeded: (input.decisionNeeded ?? '').slice(
                0,
                AGENT_ESCALATION_MAX_DECISION_CHARS,
            ),
            runId: input.runId ?? null,
            taskId: input.taskId ?? null,
            workId: input.workId ?? null,
            agentId: input.agentId ?? null,
            attempted: normalizeAttempts(input.attempted),
            dedupKey,
            ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
            ...buildConfidencePatch(input.confidence, input.confidenceSource),
        });

        try {
            return await this.repository.save(row);
        } catch (error) {
            // Concurrent writer won the UNIQUE index. Re-read theirs.
            const winner = await this.repository.findOne({ where: { dedupKey } });
            if (winner) return winner;
            this.logger.warn(
                `Escalation write failed for ${dedupKey}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    /** Open escalations for a Task, newest first (Task detail). */
    async listForTask(taskId: string, limit = 20): Promise<AgentEscalation[]> {
        return this.repository.find({
            where: { taskId },
            order: { createdAt: 'DESC' },
            take: Math.max(1, Math.min(100, limit)),
        });
    }

    /**
     * Open escalations for a user since a cutoff — the digest feed.
     * Owner-scoped at the repository layer for the same reason
     * `listSessionsForUser` is: this is the shape an HTTP handler reaches
     * for, so cross-user rows must be unreachable by construction.
     */
    async listOpenForUser(userId: string, since?: Date, limit = 20): Promise<AgentEscalation[]> {
        const qb = this.repository
            .createQueryBuilder('esc')
            .where('esc.userId = :userId', { userId })
            .andWhere('esc.status = :status', { status: 'open' });
        if (since) {
            qb.andWhere('esc.createdAt >= :since', { since });
        }
        return qb
            .orderBy('esc.createdAt', 'DESC')
            .take(Math.max(1, Math.min(100, limit)))
            .getMany();
    }

    /**
     * The escalation QUEUE read — everything of one user, optionally
     * narrowed to a status, ordered by CONFIDENCE first and recency
     * second.
     *
     * Confidence-first is the whole point of the column: a queue sorted
     * only by time makes a human read a self-healing parked run before a
     * merge that a policy refused.
     *
     * `COALESCE(confidence, -1)` rather than a `NULLS LAST` clause
     * because the two supported drivers disagree about where NULL sorts
     * under `DESC` (SQLite last, Postgres first) and the e2e stack runs
     * sqlite while production runs Postgres — a sort order that flips
     * between them is a bug that only ever reproduces in prod. The
     * sentinel puts unscored rows (every pre-column row) below scored
     * ones on both, without pretending they are low-confidence.
     *
     * Owner-scoped inside the repository for the same reason
     * `listOpenForUser` is: this is the shape an HTTP handler reaches
     * for, so cross-user rows must be unreachable by construction.
     */
    async listForUser(
        userId: string,
        options: ListEscalationsForUserOptions = {},
    ): Promise<AgentEscalation[]> {
        const qb = this.repository
            .createQueryBuilder('esc')
            .where('esc.userId = :userId', { userId });
        if (options.status) {
            qb.andWhere('esc.status = :status', { status: options.status });
        }
        if (options.since) {
            qb.andWhere('esc.createdAt >= :since', { since: options.since });
        }
        return qb
            .orderBy('COALESCE(esc.confidence, -1)', 'DESC')
            .addOrderBy('esc.createdAt', 'DESC')
            .skip(Math.max(0, options.offset ?? 0))
            .take(Math.max(1, Math.min(100, options.limit ?? 50)))
            .getMany();
    }

    /**
     * One escalation, owner-scoped. Returns `null` for a foreign id
     * exactly as it does for a missing one — no existence oracle.
     */
    async findOwned(id: string, userId: string): Promise<AgentEscalation | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    /** Count of open escalations for a Work (per-Work cockpit chip). */
    async countOpenForWork(workId: string): Promise<number> {
        return this.repository.count({ where: { workId, status: 'open' } });
    }

    /**
     * Close one escalation. Owner-scoped CAS on `status='open'` so a
     * double-click resolves once and a foreign row is untouched (and
     * indistinguishable from a missing one — no existence oracle).
     */
    async resolve(id: string, userId: string, resolutionNote?: string | null): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(AgentEscalation)
            .set({
                status: 'resolved' as AgentEscalationStatus,
                resolvedByUserId: userId,
                resolutionNote: resolutionNote
                    ? resolutionNote.slice(0, AGENT_ESCALATION_MAX_DECISION_CHARS)
                    : null,
                resolvedAt: new Date(),
            })
            .where('id = :id', { id })
            .andWhere('userId = :userId', { userId })
            .andWhere('status = :open', { open: 'open' })
            .execute();
        return (result.affected ?? 0) > 0;
    }
}

/**
 * Build the confidence half of an insert.
 *
 * Returns `{}` when there is nothing to store, so the column stays NULL
 * rather than becoming a fabricated `0` — "never scored" and "scored
 * zero" are opposite claims and only one of them may be inferred from an
 * absent value. `confidenceSource` is only ever written alongside a real
 * number: a source with no score describes nothing.
 */
export function buildConfidencePatch(
    confidence: number | null | undefined,
    source: AgentEscalationConfidenceSource | null | undefined,
): { confidence?: number; confidenceSource?: AgentEscalationConfidenceSource | null } {
    const clamped =
        confidence === null || confidence === undefined
            ? null
            : clampEscalationConfidence(confidence);
    if (clamped === null) return {};
    return { confidence: clamped, confidenceSource: source ?? null };
}

/**
 * Cap the attempt trail on every axis an untrusted producer controls:
 * entry count, label, outcome and detail length. Exported for the spec —
 * this is the only defence between a build log and a `simple-json`
 * column.
 */
export function normalizeAttempts(
    attempts: AgentEscalationAttempt[] | null | undefined,
): AgentEscalationAttempt[] | null {
    if (!Array.isArray(attempts) || attempts.length === 0) return null;
    return attempts.slice(0, AGENT_ESCALATION_MAX_ATTEMPT_ENTRIES).map((attempt) => {
        const normalized: AgentEscalationAttempt = {
            label: String(attempt?.label ?? '').slice(0, MAX_ATTEMPT_LABEL_CHARS),
            outcome: String(attempt?.outcome ?? '').slice(0, MAX_ATTEMPT_OUTCOME_CHARS),
        };
        if (attempt?.detail) {
            normalized.detail = String(attempt.detail).slice(0, MAX_ATTEMPT_DETAIL_CHARS);
        }
        return normalized;
    });
}
