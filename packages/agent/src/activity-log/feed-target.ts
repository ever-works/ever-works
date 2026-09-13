import type { FeedActorDto, FeedTargetDto } from '@ever-works/contracts';
import { ActivityActionType } from '../entities/activity-log.types';
import { isUuid } from './feed-actor';

/**
 * Live Feed — the most specific thing a record is about.
 *
 * Returned as a typed pointer (`{ type, id }`), never a URL: the web maps it
 * through its own route constants, so the API holds no copy of the web's
 * routes. Every id is checked to be a uuid before it is handed out.
 *
 * Precedence (spec FR-19): a decision opens where it is answered; otherwise a
 * run opens its receipt; otherwise the owning task, mission or idea; then the
 * acting agent (only while it still exists); then the Work; then the skill.
 * `null` when there is nothing to open — the entry renders as plain text
 * rather than a dead link.
 */

/** The record fields destination resolution reads. */
export interface TargetResolvableActivity {
    actionType: string;
    workId?: string | null;
    details?: Record<string, unknown> | null;
}

const INBOX_ACTION_TYPES: ReadonlySet<string> = new Set<string>([
    ActivityActionType.INBOX_ITEM_CREATED,
    ActivityActionType.INBOX_ITEM_ANSWERED,
]);

function ownId(details: Record<string, unknown> | null | undefined, key: string): string | null {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
    if (!Object.prototype.hasOwnProperty.call(details, key)) return null;
    const value = details[key];
    return isUuid(value) ? value : null;
}

export function resolveFeedTarget(
    row: TargetResolvableActivity,
    actor: FeedActorDto,
    agentStillExists: boolean,
): FeedTargetDto | null {
    const details = row.details;

    if (INBOX_ACTION_TYPES.has(row.actionType)) {
        const inboxItemId = ownId(details, 'inboxItemId');
        if (inboxItemId) return { type: 'inbox', id: inboxItemId };
    }

    // A run whose agent has since been deleted is not offered as a
    // destination: plain text beats risking a dead end (spec S19).
    const agentGone = actor.kind === 'agent' && !agentStillExists;
    const runId = ownId(details, 'runId') ?? ownId(details, 'agentRunId');
    if (runId && !agentGone) return { type: 'run', id: runId };

    const resourceType = details && !Array.isArray(details) ? details.resourceType : undefined;
    const resourceId = ownId(details, 'resourceId');

    const taskId = ownId(details, 'taskId') ?? (resourceType === 'task' ? resourceId : null);
    if (taskId) return { type: 'task', id: taskId };

    const missionId = ownId(details, 'missionId');
    if (missionId) return { type: 'mission', id: missionId };

    const ideaId = ownId(details, 'ideaId') ?? ownId(details, 'proposalId');
    if (ideaId) return { type: 'idea', id: ideaId };

    if (actor.kind === 'agent' && actor.agentId && agentStillExists) {
        return { type: 'agent', id: actor.agentId };
    }

    if (isUuid(row.workId)) return { type: 'work', id: row.workId };

    if (resourceType === 'skill' && resourceId) return { type: 'skill', id: resourceId };

    return null;
}
