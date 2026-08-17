import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { AgentEscalationDto, AgentEscalationStatus } from '@ever-works/contracts';
import { config } from '../config';
import {
    AgentEscalationRepository,
    type ListEscalationsForUserOptions,
    type RecordEscalationInput,
} from '../database/repositories/agent-escalation.repository';
import type { AgentEscalation } from '../entities/agent-escalation.entity';
// Leaf token file — no runtime graph (see inbox-producer.port.ts).
import { INBOX_PRODUCER, type InboxProducer } from '../inbox/inbox-producer.port';
import { EscalationConfidenceService } from './escalation-confidence';

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

    constructor(
        private readonly repository: AgentEscalationRepository,
        // Judgment layer G3 (confidence column). @Optional() and
        // appended LAST per the positional-spec arity rule: unit tests
        // and worker RPC proxies construct this service with one
        // argument, and an absent scorer simply leaves `confidence` NULL
        // — which reads as "never scored", never as "not confident".
        @Optional() private readonly confidenceScorer?: EscalationConfidenceService,
        // Inbox (operator message center). @Optional() and appended LAST
        // per the positional-spec arity rule; bound by the api-side
        // @Global() InboxModule. Absent = pre-inbox behaviour, unchanged.
        @Optional() @Inject(INBOX_PRODUCER) private readonly inbox?: InboxProducer,
    ) {}

    /**
     * File one escalation. Idempotent per `dedupKey` (defaulting to
     * `${reasonCode}:${runId}`), so a retried Trigger.dev task or a
     * redelivered webhook produces one card, not five.
     *
     * Scores `confidence` before writing (judgment layer G3) unless the
     * caller supplied one — the escalation queue is ranked by it, so a
     * row without a score falls to the bottom of every human's list.
     *
     * Returns the row when written (or the existing one on a dedup hit),
     * `null` when logging is disabled or the write failed.
     */
    async record(input: RecordEscalationInput): Promise<AgentEscalation | null> {
        if (!config.agents.isEscalationLoggingEnabled()) return null;
        try {
            const row = await this.repository.record(await this.withConfidence(input));
            if (row) {
                this.logger.log(
                    `Escalation ${input.reasonCode} recorded for run=${input.runId ?? 'none'} ` +
                        `task=${input.taskId ?? 'none'}.`,
                );
                // Inbox mirror — additive alongside the escalation row,
                // idempotent per escalationId inside the producer, and
                // best-effort like everything else on this path.
                await this.mirrorToInbox(row);
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

    /**
     * The escalation QUEUE feed — every escalation of one user,
     * optionally narrowed to a status, highest confidence first.
     *
     * This is what the escalation UI reads. `listOpenForUser` above is
     * NOT a substitute: it is the digest's open-only, since-windowed
     * view, and the queue needs the resolved ones too (a human closing
     * a card must still see it, and "what did I already decide?" is half
     * of what makes the queue trustworthy).
     */
    async listForUser(
        userId: string,
        options: ListEscalationsForUserOptions = {},
    ): Promise<AgentEscalationDto[]> {
        const rows = await this.repository.listForUser(userId, options);
        return rows.map(toAgentEscalationDto);
    }

    /** One escalation, owner-scoped. `null` for foreign AND missing ids. */
    async getForUser(id: string, userId: string): Promise<AgentEscalationDto | null> {
        const row = await this.repository.findOwned(id, userId);
        return row ? toAgentEscalationDto(row) : null;
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

    /** Mirror one recorded escalation into the owner's inbox. Best-effort. */
    private async mirrorToInbox(row: AgentEscalation): Promise<void> {
        if (!this.inbox) return;
        try {
            await this.inbox.escalationRaised({
                userId: row.userId,
                escalationId: row.id,
                summary: row.summary,
                decisionNeeded: row.decisionNeeded,
                agentId: row.agentId ?? null,
                runId: row.runId ?? null,
                taskId: row.taskId ?? null,
                workId: row.workId ?? null,
                organizationId: row.organizationId ?? null,
            });
        } catch (error) {
            this.logger.warn(
                `Escalation ${row.id} inbox mirror failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Attach a confidence score to an about-to-be-written escalation.
     *
     * Best-effort like everything else on this path: a scorer that
     * throws leaves the input untouched and the row lands unscored,
     * because a missing number is a far smaller loss than a lost
     * escalation. An explicit caller-supplied `confidence` always wins —
     * a producer that already knows is not second-guessed.
     */
    private async withConfidence(input: RecordEscalationInput): Promise<RecordEscalationInput> {
        if (!this.confidenceScorer || input.confidence !== undefined) return input;
        try {
            const verdict = await this.confidenceScorer.score({
                reasonCode: input.reasonCode,
                summary: input.summary,
                decisionNeeded: input.decisionNeeded,
                attempted: input.attempted ?? null,
                userId: input.userId,
                workId: input.workId ?? null,
                agentId: input.agentId ?? null,
                taskId: input.taskId ?? null,
                runId: input.runId ?? null,
            });
            return { ...input, confidence: verdict.confidence, confidenceSource: verdict.source };
        } catch (error) {
            this.logger.warn(
                `Escalation confidence scoring failed for ${input.reasonCode}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return input;
        }
    }
}

/** Narrow an untrusted query value to a status, or `undefined`. */
export function parseEscalationStatus(value: unknown): AgentEscalationStatus | undefined {
    return value === 'open' || value === 'resolved' ? value : undefined;
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
        confidence: typeof row.confidence === 'number' ? row.confidence : null,
        // Only ever reported alongside a real number — a source with no
        // score describes nothing, and rendering one would imply a
        // judgement that was never made.
        confidenceSource:
            typeof row.confidence === 'number' ? (row.confidenceSource ?? null) : null,
        resolvedByUserId: row.resolvedByUserId ?? null,
        resolutionNote: row.resolutionNote ?? null,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        createdAt: row.createdAt?.toISOString() ?? new Date(0).toISOString(),
    };
}
