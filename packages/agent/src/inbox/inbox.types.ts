import type { InboxItemDto } from '@ever-works/contracts';
import type { InboxItem } from '../entities/inbox-item.entity';

/** Entity → wire projection. Dates as ISO strings, nulls normalized. */
export function toInboxItemDto(row: InboxItem): InboxItemDto {
    return {
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        options: Array.isArray(row.options) && row.options.length > 0 ? row.options : null,
        sourceType: row.sourceType,
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
        createdAt: row.createdAt?.toISOString() ?? new Date(0).toISOString(),
        updatedAt: row.updatedAt?.toISOString() ?? new Date(0).toISOString(),
    };
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

export interface InboxReplyOutcome {
    item: InboxItemDto;
    routed: InboxReplyRouted;
    /** The run now carrying the answer (`steered` = the same run, `resumed` = the new one). */
    runId?: string;
}
