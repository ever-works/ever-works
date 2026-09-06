import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    TASK_AUTO_RESUME_CLAIM_KEY_MAX_CHARS,
    TaskCiAutoResumeAttempt,
    type TaskAutoResumeTrigger,
} from '../../entities/task-ci-auto-resume-attempt.entity';

export interface ClaimAutoResumeAttemptInput {
    taskId: string;
    trigger: TaskAutoResumeTrigger;
    /** Idempotency coordinate — UNIQUE per Task. See the entity doc. */
    claimKey: string;
    headSha?: string | null;
    failureKey?: string | null;
    sourceRunId?: string | null;
    detail?: string | null;
    workId?: string | null;
    tenantId?: string | null;
    organizationId?: string | null;
}

/**
 * CI feedback and the autonomous fix loop (slice AC, EW-806) — the
 * attempt ledger's four operations, and no more.
 *
 * Every method here is on the money path: `countForTask` IS the retry
 * budget, `claim` IS the idempotency guard, and both are allowed to
 * throw. That is deliberate and the caller depends on it — a budget that
 * cannot be read must STOP the loop, and a claim that cannot be written
 * must not be treated as won. Nothing in this file swallows an error into
 * a permissive default.
 */
@Injectable()
export class TaskCiAutoResumeAttemptRepository {
    constructor(
        @InjectRepository(TaskCiAutoResumeAttempt)
        private readonly repository: Repository<TaskCiAutoResumeAttempt>,
    ) {}

    /**
     * How many auto-resume attempts this Task has already spent.
     *
     * Rows, not events: one row is one dispatched (or attempted)
     * resume. THROWS on a read failure — see the class doc.
     */
    async countForTask(taskId: string): Promise<number> {
        return this.repository.count({ where: { taskId } });
    }

    /**
     * Has this Task already been retried against this exact failure
     * fingerprint, on any head?
     *
     * The no-progress guard: a failure that comes back byte-identical
     * after a fix attempt is evidence the retry did not work, and
     * spending another model run on it is the doom loop this slice
     * exists to avoid. THROWS on a read failure.
     */
    async hasFailureKey(taskId: string, failureKey: string): Promise<boolean> {
        if (!failureKey) return false;
        const count = await this.repository.count({ where: { taskId, failureKey } });
        return count > 0;
    }

    /**
     * Claim ONE attempt, or lose the race.
     *
     * Returns the row this caller inserted, or `null` when the
     * `(taskId, claimKey)` unique index says an attempt for this
     * coordinate already exists — which is the outcome for every GitHub
     * redelivery, every extra failing job on the same push, and the
     * loser of two API replicas handling one delivery.
     *
     * Check-then-insert is not atomic, so the constraint violation is
     * the real guard and the pre-read is only there to save an INSERT in
     * the common case (same convention as
     * `IngestedEventRepository.createIfNew`).
     */
    async claim(input: ClaimAutoResumeAttemptInput): Promise<TaskCiAutoResumeAttempt | null> {
        const claimKey = input.claimKey.slice(0, TASK_AUTO_RESUME_CLAIM_KEY_MAX_CHARS);
        const existing = await this.repository.findOne({
            where: { taskId: input.taskId, claimKey },
        });
        if (existing) return null;
        try {
            return await this.repository.save(
                this.repository.create({
                    taskId: input.taskId,
                    trigger: input.trigger,
                    claimKey,
                    headSha: input.headSha ?? null,
                    failureKey: input.failureKey ?? null,
                    sourceRunId: input.sourceRunId ?? null,
                    detail: input.detail ?? null,
                    workId: input.workId ?? null,
                    tenantId: input.tenantId ?? null,
                    organizationId: input.organizationId ?? null,
                }),
            );
        } catch (error) {
            if (this.isUniqueViolation(error)) return null;
            throw error;
        }
    }

    /**
     * Record which run the claimed attempt actually produced.
     *
     * Best-effort by contract: the attempt is already spent by the time
     * this runs, and losing the pointer costs reporting, not safety.
     */
    async stampResumedRun(id: string, resumedRunId: string): Promise<void> {
        await this.repository.update({ id }, { resumedRunId });
    }

    /**
     * Attempts for one Task, oldest first. Reporting and tests.
     *
     * `id` is a tie-break because `createdAt` has SECOND resolution on
     * sqlite, so two attempts claimed in the same second would otherwise
     * come back in an undefined order. Nothing on the decision path ranks
     * by this list — the budget is decided by {@link countForTask}, which
     * needs no ordering at all.
     */
    async listForTask(taskId: string): Promise<TaskCiAutoResumeAttempt[]> {
        return this.repository.find({
            where: { taskId },
            order: { createdAt: 'ASC', id: 'ASC' },
        });
    }

    private isUniqueViolation(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false;
        const driverCode = (error as { driverError?: { code?: string } }).driverError?.code;
        const topCode = (error as { code?: string }).code;
        // Postgres 23505 / MySQL ER_DUP_ENTRY / SQLite SQLITE_CONSTRAINT*.
        //
        // The sqlite arm is a PREFIX match, not the exact `SQLITE_CONSTRAINT`
        // that several older repositories in this package compare against:
        // better-sqlite3 — the driver CI, the e2e stack and every spec in
        // this repo run on — reports the EXTENDED result code, so a real
        // unique-index hit arrives as `SQLITE_CONSTRAINT_UNIQUE` and an
        // exact comparison misses it. `claim()` then THROWS instead of
        // returning null, and the check-then-insert race this ledger exists
        // to lose gracefully becomes an `error` outcome. Same reasoning (and
        // same `startsWith`) as `isWorkCustomDomainUniqueConstraintError`.
        const codes = ['23505', 'ER_DUP_ENTRY'];
        for (const code of [driverCode, topCode]) {
            if (typeof code !== 'string') continue;
            if (codes.includes(code) || code.startsWith('SQLITE_CONSTRAINT')) return true;
        }
        return false;
    }
}
