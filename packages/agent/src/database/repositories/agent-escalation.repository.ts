import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    AGENT_ESCALATION_MAX_ATTEMPT_ENTRIES,
    AGENT_ESCALATION_MAX_DECISION_CHARS,
    AGENT_ESCALATION_MAX_SUMMARY_CHARS,
    type AgentEscalationAttempt,
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
