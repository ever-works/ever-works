import {
    INBOX_DECISION_DORMANT_AFTER_DAYS,
    type InboxDecisionContext,
    type InboxDecisionDto,
    type InboxItemDto,
} from '@ever-works/contracts';
import type { InboxItem } from '../entities/inbox-item.entity';
import type { InboxDecisionRow } from '../database/repositories/inbox-item.repository';

/** Entity → wire projection. Dates as ISO strings, nulls normalized. */
export function toInboxItemDto(row: InboxItem): InboxItemDto {
    return {
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        options: Array.isArray(row.options) && row.options.length > 0 ? row.options : null,
        sourceType: row.sourceType,
        sourceMeta: row.sourceMeta ?? null,
        agentId: row.agentId ?? null,
        agentRunId: row.agentRunId ?? null,
        taskId: row.taskId ?? null,
        workId: row.workId ?? null,
        escalationId: row.escalationId ?? null,
        proposalId: row.proposalId ?? null,
        status: row.status,
        unread: row.unread === true,
        answeredAt: row.answeredAt?.toISOString() ?? null,
        answerText: row.answerText ?? null,
        answerOptionId: row.answerOptionId ?? null,
        firstViewedAt: toIsoOrNull(row.firstViewedAt),
        createdAt: row.createdAt?.toISOString() ?? new Date(0).toISOString(),
        updatedAt: row.updatedAt?.toISOString() ?? new Date(0).toISOString(),
    };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * My Decisions — one decision-view row → wire. The context is read from
 * the linked records at list time; this only normalises it (untrusted
 * JSON columns are filtered to the shapes the web renders as plain text).
 */
export function toInboxDecisionDto(
    row: InboxDecisionRow,
    now: Date = new Date(),
): InboxDecisionDto {
    const item = toInboxItemDto(row.item);
    const blockingReason: InboxDecisionContext['blockingReason'] = row.runParked
        ? 'run-parked'
        : row.taskStatus === 'blocked'
          ? 'task-blocked'
          : null;
    const runLive = row.runStatus === 'queued' || row.runStatus === 'running';
    const createdAt = row.item.createdAt?.getTime() ?? now.getTime();
    const dormant =
        row.item.status === 'open' &&
        !blockingReason &&
        !runLive &&
        now.getTime() - createdAt > INBOX_DECISION_DORMANT_AFTER_DAYS * DAY_MS;

    return {
        ...item,
        decision: {
            blocking: blockingReason !== null,
            blockingReason,
            confidence:
                typeof row.confidence === 'number'
                    ? Math.min(1, Math.max(0, row.confidence))
                    : null,
            // A source with no score describes nothing (same rule as the escalation DTO).
            confidenceSource:
                typeof row.confidence === 'number' &&
                (row.confidenceSource === 'ai-judge' || row.confidenceSource === 'heuristic')
                    ? row.confidenceSource
                    : null,
            reasonCode: row.reasonCode,
            attempted: normaliseAttempts(row.attempted),
            actionType: row.actionType,
            riskFlags: Array.isArray(row.riskFlags)
                ? row.riskFlags.filter((flag): flag is string => typeof flag === 'string')
                : [],
            agentName: row.agentName,
            // Only the owner-scoped join: it already resolves the item's own
            // link or the linked run's, and reads a deleted or another
            // owner's Task as absent. The raw `item.taskId` would bring
            // that stale id back as a Task link.
            taskId: row.taskId,
            taskTitle: row.taskTitle,
            taskStatus: row.taskStatus,
            missionId: row.missionId,
            runStatus: row.runStatus,
            dormant,
        },
    };
}

function normaliseAttempts(value: unknown): InboxDecisionContext['attempted'] {
    if (!Array.isArray(value)) return [];
    const out: InboxDecisionContext['attempted'] = [];
    for (const entry of value) {
        if (typeof entry !== 'object' || entry === null) continue;
        const { label, outcome, detail } = entry as Record<string, unknown>;
        if (typeof label !== 'string' || typeof outcome !== 'string') continue;
        const attempt: { label: string; outcome: string; detail?: string } = { label, outcome };
        if (typeof detail === 'string' && detail.length > 0) {
            attempt.detail = detail;
        }
        out.push(attempt);
    }
    return out;
}

/** `PortableDateColumn` reads back a Date on Postgres and may read a string on SQLite. */
function toIsoOrNull(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * How a reply was routed downstream — reported back to the caller so
 * the UI can say what actually happened ("the agent picked it up
 * live" vs "a resumed run is answering").
 */
export type InboxReplyRouted =
    | 'steered'
    | 'resumed'
    | 'approved'
    | 'rejected'
    | 'escalation-resolved'
    | 'already-decided'
    | 'none';

/**
 * My Decisions — what happened to the WORK after the answer, independent
 * of what happened to the record (`routed`):
 *
 *   injected — the answer went into the run that is still going;
 *   resumed  — a new run continuing the parked one's conversation started;
 *   queued   — that new run was admitted but is waiting for a free slot;
 *   failed   — the record is decided, but restarting the run failed (the
 *              answer is NOT rolled back; the owner can restart by hand);
 *   none     — there was no parked or live run to hand the answer to.
 */
export type InboxReplyRestart = 'injected' | 'resumed' | 'queued' | 'failed' | 'none';

export interface InboxReplyOutcome {
    item: InboxItemDto;
    routed: InboxReplyRouted;
    /** The run now carrying the answer (`steered` = the same run, `resumed` = the new one). */
    runId?: string;
    /** What happened to the work behind the answer. Absent on the already-decided path. */
    restart?: InboxReplyRestart;
}
