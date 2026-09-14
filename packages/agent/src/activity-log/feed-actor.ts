import type { FeedActorDto } from '@ever-works/contracts';
import {
    ActivityActionType,
    type ActivityActorKind,
    type CreateActivityLogDto,
} from '../entities/activity-log.types';
import { sanitizeNarrationParam } from './feed-narration';

/**
 * Live Feed — who did a thing.
 *
 * Two halves, one rule set:
 *
 *  - WRITE time ({@link withDerivedActor}): `ActivityLogService.log()` stamps
 *    `actorKind` / `actorAgentId` from the agent reference a writer already
 *    put in `details`, when the writer did not pass an actor itself. This is
 *    what makes the per-agent filter and roster indexable for every new row
 *    without touching the ~35 existing call sites.
 *  - READ time ({@link resolveFeedActor}): rows written before the actor
 *    columns existed are resolved by a ladder — the acting agent, else the
 *    signed-in user, else the external source, else the platform.
 *
 * An agent reference in `details` names the ACTING agent only for action
 * types a person does not perform. For the ones a person does (exporting or
 * importing an agent, editing its instruction files, giving it a skill,
 * answering its decision, dispatching it onto a task, ...) the referenced
 * agent is what the action was ABOUT —
 * its subject — and the actor is the signed-in user.
 */

/**
 * Longest actor name the `activity_log.actorLabel` column holds. A longer
 * name is cut rather than letting the insert fail on Postgres.
 */
export const ACTIVITY_ACTOR_LABEL_MAX_LENGTH = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID.test(value);
}

function own(bag: Record<string, unknown> | null | undefined, key: string): unknown {
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return undefined;
    return Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : undefined;
}

/**
 * The agent a record is about, as its writer recorded it: the
 * `resourceType: 'agent'` + `resourceId` pair the agent writers stamp, or the
 * `agentId` the task / goal / merge writers carry. `null` when neither is a
 * uuid.
 */
export function referencedAgentId(
    details: Record<string, unknown> | null | undefined,
): string | null {
    const resourceType = own(details, 'resourceType');
    const resourceId = own(details, 'resourceId');
    if (resourceType === 'agent' && isUuid(resourceId)) return resourceId;
    const agentId = own(details, 'agentId');
    return isUuid(agentId) ? agentId : null;
}

/**
 * Fill in the actor for a record about to be written. A caller-supplied
 * actor always wins; with none, an agent reference in `details` makes the
 * agent the actor — unless the action type is one a person performs, in
 * which case the referenced agent is the subject and the user is stamped as
 * the actor. Returns the input object unchanged when there is nothing to
 * add, so callers comparing payloads see exactly what they passed.
 */
export function withDerivedActor(entry: CreateActivityLogDto): CreateActivityLogDto {
    if (entry.actorKind) return entry;
    if (isUuid(entry.actorAgentId)) {
        return { ...entry, actorKind: 'agent' };
    }
    const agentId = referencedAgentId(entry.details);
    if (!agentId) return entry;
    if (FEED_USER_ACTION_TYPES.has(entry.actionType)) {
        return { ...entry, actorKind: 'user' };
    }
    return { ...entry, actorKind: 'agent', actorAgentId: agentId };
}

/**
 * An actor name as it may be stored: trimmed, and cut to
 * {@link ACTIVITY_ACTOR_LABEL_MAX_LENGTH} characters (code points, which is
 * how the varchar column counts). `null` when nothing usable is left.
 */
export function storableActorLabel(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const chars = Array.from(trimmed);
    if (chars.length <= ACTIVITY_ACTOR_LABEL_MAX_LENGTH) return trimmed;
    return chars.slice(0, ACTIVITY_ACTOR_LABEL_MAX_LENGTH).join('').trimEnd();
}

/** Action types a signed-in person performs from the product. */
export const FEED_USER_ACTION_TYPES: ReadonlySet<string> = new Set<string>([
    ActivityActionType.WORK_CREATED,
    ActivityActionType.WORK_UPDATED,
    ActivityActionType.WORK_DELETED,
    ActivityActionType.ITEM_ADDED,
    ActivityActionType.ITEM_UPDATED,
    ActivityActionType.ITEM_REMOVED,
    ActivityActionType.PLUGIN_ENABLED,
    ActivityActionType.PLUGIN_DISABLED,
    ActivityActionType.PLUGIN_CONFIGURED,
    ActivityActionType.PLUGIN_INSTALLED,
    ActivityActionType.PLUGIN_UNINSTALLED,
    ActivityActionType.TEMPLATE_ADDED,
    ActivityActionType.TEMPLATE_UPDATED,
    ActivityActionType.TEMPLATE_ARCHIVED,
    ActivityActionType.TEMPLATE_FORKED,
    ActivityActionType.TEMPLATE_DEFAULT_SET,
    ActivityActionType.MEMBER_INVITED,
    ActivityActionType.MEMBER_ROLE_CHANGED,
    ActivityActionType.MEMBER_REMOVED,
    ActivityActionType.SCHEDULE_CREATED,
    ActivityActionType.SCHEDULE_UPDATED,
    ActivityActionType.SCHEDULE_DELETED,
    ActivityActionType.SCHEDULE_PAUSED,
    ActivityActionType.SCHEDULE_RESUMED,
    ActivityActionType.IMPORT,
    ActivityActionType.EXPORT,
    ActivityActionType.SETTINGS_UPDATED,
    ActivityActionType.WEBSITE_SETTINGS_UPDATED,
    ActivityActionType.PROMPTS_UPDATED,
    ActivityActionType.USER_LOGIN,
    ActivityActionType.USER_SIGNUP,
    ActivityActionType.PROVIDER_CONNECTED,
    ActivityActionType.PASSWORD_CHANGED,
    ActivityActionType.CHAT_CONVERSATION,
    ActivityActionType.KB_UPLOAD_CREATED,
    ActivityActionType.KB_DOCUMENT_LOCKED,
    ActivityActionType.KB_DOCUMENT_UNLOCKED,
    ActivityActionType.KB_DOCUMENT_RESTORED,
    ActivityActionType.MEMORY_FOLDER_CREATED,
    ActivityActionType.MEMORY_FOLDER_DELETED,
    ActivityActionType.MEMORY_FOLDER_SYNCED,
    ActivityActionType.MISSION_CREATED,
    ActivityActionType.MISSION_PAUSED,
    ActivityActionType.MISSION_RESUMED,
    ActivityActionType.MISSION_COMPLETED,
    ActivityActionType.MISSION_DELETED,
    ActivityActionType.GOAL_LOOP_STARTED,
    ActivityActionType.GOAL_LOOP_PAUSED,
    ActivityActionType.GOAL_LOOP_RESUMED,
    ActivityActionType.GOAL_LOOP_CANCELLED,
    ActivityActionType.GOAL_DOD_UPDATED,
    ActivityActionType.GOAL_ARCHIVED,
    ActivityActionType.GOAL_UNARCHIVED,
    ActivityActionType.IDEA_DISMISSED,
    ActivityActionType.IDEA_QUEUED,
    ActivityActionType.IDEA_ACCEPTED,
    ActivityActionType.IDEA_DELETED,
    ActivityActionType.IDEA_REBUILD_STARTED,
    ActivityActionType.AGENT_EXPORTED,
    ActivityActionType.AGENT_IMPORTED,
    // Saving an agent's instruction files (and a save refused because the
    // file changed elsewhere) is a person's action by default. The agent's
    // own edit tool stamps the agent as the actor explicitly when it writes.
    ActivityActionType.AGENT_FILE_EDITED,
    ActivityActionType.AGENT_FILE_REVERTED,
    ActivityActionType.ENVIRONMENT_CREATED,
    ActivityActionType.ENVIRONMENT_UPDATED,
    ActivityActionType.ENVIRONMENT_PUBLISHED,
    ActivityActionType.ENVIRONMENT_DELETED,
    ActivityActionType.SKILL_INSTALLED,
    ActivityActionType.SKILL_ATTACHED_TO_AGENT,
    ActivityActionType.SKILL_FILE_EDITED,
    ActivityActionType.REPO_CONNECTION_CREATED,
    ActivityActionType.REPO_CONNECTION_UPDATED,
    ActivityActionType.REPO_CONNECTION_DELETED,
    ActivityActionType.REPO_CONNECTION_IMPORTED,
    ActivityActionType.REPO_ATTACHED_TO_AGENT,
    ActivityActionType.REPO_DETACHED_FROM_AGENT,
    ActivityActionType.TASK_CREATED,
    ActivityActionType.TASK_UPDATED,
    ActivityActionType.TASK_DELETED,
    ActivityActionType.TASK_ASSIGNED,
    ActivityActionType.TASK_ASSIGNEE_ADDED,
    ActivityActionType.TASK_ASSIGNEE_REMOVED,
    ActivityActionType.TASK_BLOCKER_ADDED,
    ActivityActionType.TASK_BLOCKER_REMOVED,
    ActivityActionType.TASK_TRANSITIONED,
    ActivityActionType.TASK_COMMENTED,
    ActivityActionType.MCP_CONNECTION_CREATED,
    ActivityActionType.MCP_CONNECTION_UPDATED,
    ActivityActionType.MCP_CONNECTION_DELETED,
    ActivityActionType.MCP_CONNECTION_TESTED,
    ActivityActionType.MCP_BINDING_UPDATED,
    ActivityActionType.INBOX_ITEM_ANSWERED,
]);

/** Action types produced by something outside the platform. */
export const FEED_EXTERNAL_ACTION_TYPES: ReadonlySet<string> = new Set<string>([
    ActivityActionType.EXTERNAL_EVENT_INGESTED,
    ActivityActionType.GIT_PUSHED,
    ActivityActionType.GIT_COMMITTED,
    ActivityActionType.GIT_MERGED,
    ActivityActionType.COMMUNITY_PR_MERGED,
    ActivityActionType.WEBSITE_USER_REGISTERED,
    ActivityActionType.WEBSITE_ITEM_SUBMITTED,
    ActivityActionType.WEBSITE_REPORT_FILED,
    ActivityActionType.WEBSITE_REPORT_RESOLVED,
]);

/** What the resolver needs to know about an agent referenced by a record. */
export interface FeedAgentRef {
    id: string;
    name: string;
    avatarMode?: string | null;
}

/** The record fields actor resolution reads. */
export interface ActorResolvableActivity {
    actionType: string;
    actorKind?: ActivityActorKind | null;
    actorAgentId?: string | null;
    actorLabel?: string | null;
    details?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
    work?: { name?: string | null } | null;
}

/** The agent a record should be attributed to, before looking it up. */
export function actorAgentIdOf(row: ActorResolvableActivity): string | null {
    if (row.actorKind && row.actorKind !== 'agent') return null;
    if (isUuid(row.actorAgentId)) return row.actorAgentId;
    // An older row of an action a person performs: the agent it references
    // is its subject, so the ladder falls through to the user.
    if (!row.actorKind && FEED_USER_ACTION_TYPES.has(row.actionType)) return null;
    return referencedAgentId(row.details);
}

/**
 * The agent a record is about when that agent is NOT its actor — for
 * example the agent a person exported. `null` when the record references no
 * agent, or only the one that acted.
 */
export function subjectAgentIdOf(row: ActorResolvableActivity): string | null {
    const referenced = referencedAgentId(row.details);
    if (!referenced) return null;
    return referenced === actorAgentIdOf(row) ? null : referenced;
}

function label(value: unknown): string | null {
    const text = sanitizeNarrationParam(value);
    return text || null;
}

/**
 * Resolve the actor of one record. `agents` holds the referenced agents that
 * still exist for this user; a missing entry means the agent was deleted, in
 * which case the name captured at write time (if any) is kept.
 */
export function resolveFeedActor(
    row: ActorResolvableActivity,
    agents: ReadonlyMap<string, FeedAgentRef>,
): FeedActorDto {
    const agentId = actorAgentIdOf(row);
    if (agentId) {
        const agent = agents.get(agentId);
        return {
            kind: 'agent',
            agentId,
            // The name at the time it happened wins over today's name.
            label: label(row.actorLabel) ?? label(agent?.name),
            avatarMode: agent?.avatarMode ?? null,
        };
    }

    if (row.actorKind === 'user' || row.actorKind === 'external' || row.actorKind === 'system') {
        return { kind: row.actorKind, label: label(row.actorLabel) };
    }

    if (FEED_USER_ACTION_TYPES.has(row.actionType)) {
        return { kind: 'user', label: null };
    }

    if (FEED_EXTERNAL_ACTION_TYPES.has(row.actionType)) {
        // The source id (a connector, a repository host) is DATA here, never
        // a branch: it is shown as-is and no code path depends on its value.
        return {
            kind: 'external',
            label: label(own(row.metadata, 'source')) ?? label(row.work?.name),
        };
    }

    return { kind: 'system', label: null };
}
