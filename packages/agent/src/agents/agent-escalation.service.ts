import { Injectable, Logger } from '@nestjs/common';
import type { AgentEscalationDto } from '@ever-works/contracts';
import { config } from '../config';
import {
    AgentEscalationRepository,
    type RecordEscalationInput,
} from '../database/repositories/agent-escalation.repository';
import type { AgentEscalation } from '../entities/agent-escalation.entity';

/**
 * Judgment layer G3 — the ONE place an agent's give-up becomes a record.
 *
 * Four producers call this today, one per way an agent can stop without
 * finishing: the gate exhausted its attempts, a guardrail refused, a
 * budget/credit ceiling stopped the work, or the merge policy refused the
 * merge. They previously ended as a chat message and a log line, which is
 * why "what is waiting on me?" had no answer and why the calibration data
 * the judgment layer needs (what was attempted → what a human decided)
 * was never captured.
 *
 * **Every method is best-effort by contract.** An escalation describes a
 * failure; it must never cause one. `record()` swallows and logs, because
 * every one of its call sites is already on an error path where throwing
 * would replace a specific, useful failure with a generic one.
 */
@Injectable()
export class AgentEscalationService {
    private readonly logger = new Logger(AgentEscalationService.name);

    constructor(private readonly repository: AgentEscalationRepository) {}

    /**
     * File one escalation. Idempotent per `dedupKey` (defaulting to
     * `${reasonCode}:${runId}`), so a retried Trigger.dev task or a
     * redelivered webhook produces one card, not five.
     *
     * Returns the row when written (or the existing one on a dedup hit),
     * `null` when logging is disabled or the write failed.
     */
    async record(input: RecordEscalationInput): Promise<AgentEscalation | null> {
        if (!config.agents.isEscalationLoggingEnabled()) return null;
        try {
            const row = await this.repository.record(input);
            if (row) {
                this.logger.log(
                    `Escalation ${input.reasonCode} recorded for run=${input.runId ?? 'none'} ` +
                        `task=${input.taskId ?? 'none'}.`,
                );
            }
            return row;
        } catch (error) {
            this.logger.warn(
                `Escalation ${input.reasonCode} failed to record: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    /** Task-detail feed: every escalation on a Task, newest first. */
    async listForTask(taskId: string, limit = 20): Promise<AgentEscalationDto[]> {
        const rows = await this.repository.listForTask(taskId, limit);
        return rows.map(toAgentEscalationDto);
    }

    /**
     * Digest feed: open escalations for a user in a window. Owner-scoped
     * inside the repository, so a caller that forgets its own guard still
     * cannot read across users.
     */
    async listOpenForUser(userId: string, since?: Date, limit = 20): Promise<AgentEscalationDto[]> {
        const rows = await this.repository.listOpenForUser(userId, since, limit);
        return rows.map(toAgentEscalationDto);
    }

    /** Per-Work open count (cockpit chip). */
    async countOpenForWork(workId: string): Promise<number> {
        return this.repository.countOpenForWork(workId);
    }

    /**
     * A human answered. Owner-scoped CAS on `open` inside the repository,
     * so a double-click resolves once and a foreign id is indistinguishable
     * from a missing one.
     */
    async resolve(id: string, userId: string, note?: string | null): Promise<boolean> {
        return this.repository.resolve(id, userId, note ?? null);
    }
}

/** Entity → wire projection. Dates as ISO strings, nulls normalized. */
export function toAgentEscalationDto(row: AgentEscalation): AgentEscalationDto {
    return {
        id: row.id,
        reasonCode: row.reasonCode,
        status: row.status,
        runId: row.runId ?? null,
        taskId: row.taskId ?? null,
        workId: row.workId ?? null,
        agentId: row.agentId ?? null,
        summary: row.summary,
        decisionNeeded: row.decisionNeeded,
        attempted: Array.isArray(row.attempted) ? row.attempted : [],
        resolvedByUserId: row.resolvedByUserId ?? null,
        resolutionNote: row.resolutionNote ?? null,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        createdAt: row.createdAt?.toISOString() ?? new Date(0).toISOString(),
    };
}
