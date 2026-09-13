import { FEED_NARRATION_PARAM_MAX_CHARS, type FeedNarrationDto } from '@ever-works/contracts';
import { ActivityActionType } from '../entities/activity-log.types';
import { sanitizeName } from '../utils/sanitize.util';
import { redactSecrets } from '../utils/secret-scan';

/**
 * Live Feed — turns one activity record into `{ key, params }`.
 *
 * The API returns structure, never English: the web renders
 * `dashboard.feed.narration.<key>` with these params, which keeps every word
 * in the translation files and lets any other client render the same payload.
 *
 * Secret hygiene is by construction. Each entry declares exactly which
 * record fields it may read; a `details` / `metadata` key that is not
 * declared for that action type is unreachable, so a writer that later puts
 * a credential-shaped value into `details` cannot leak it onto the screen.
 * Every text value is additionally stripped of `<` / `>`, collapsed to one
 * line, run through the secret redactor and truncated.
 */

/** Where a declared narration param reads its value from. */
type NarrationSource =
    | { from: 'details'; key: string }
    | { from: 'metadata'; key: string }
    | { from: 'workName' }
    | { from: 'status' };

/**
 * How a param is emitted:
 *  - `text`   a sanitized string, plus a `has<Name>` = `yes` | `no` flag so a
 *             message can phrase the line with or without it;
 *  - `count`  a non-negative integer (for plural rules), plus the flag;
 *  - `choice` a lowercase token for a message `select`, `unknown` when the
 *             value is missing or not token-shaped. Never free text.
 */
type NarrationParamKind = 'text' | 'count' | 'choice';

interface NarrationParamSpec {
    source: NarrationSource;
    kind: NarrationParamKind;
}

interface NarratorEntry {
    key: string;
    params?: Readonly<Record<string, NarrationParamSpec>>;
}

const detailsText = (key: string): NarrationParamSpec => ({
    source: { from: 'details', key },
    kind: 'text',
});
const detailsCount = (key: string): NarrationParamSpec => ({
    source: { from: 'details', key },
    kind: 'count',
});
const detailsChoice = (key: string): NarrationParamSpec => ({
    source: { from: 'details', key },
    kind: 'choice',
});
const metadataText = (key: string): NarrationParamSpec => ({
    source: { from: 'metadata', key },
    kind: 'text',
});
const WORK_NAME: NarrationParamSpec = { source: { from: 'workName' }, kind: 'text' };
const STATUS: NarrationParamSpec = { source: { from: 'status' }, kind: 'choice' };

/**
 * The bespoke narrations. Order follows the clusters of the `dashboard.feed.narration`
 * message block (agent, mission, task, goal, idea, skill, inbox, knowledge,
 * git, delivery) so the two stay diffable. Several action types may share a
 * key when they read the same to a person.
 */
export const FEED_NARRATORS: Readonly<Record<string, NarratorEntry>> = {
    // Agent + run
    [ActivityActionType.AGENT_RUN_STARTED]: { key: 'agentRunStarted' },
    [ActivityActionType.AGENT_RUN_COMPLETED]: { key: 'agentRunCompleted' },
    [ActivityActionType.AGENT_RUN_FAILED]: { key: 'agentRunFailed' },
    [ActivityActionType.AGENT_RUN_CANCELLED]: { key: 'agentRunCancelled' },
    [ActivityActionType.AGENT_RUN_TRIGGERED]: { key: 'agentRunTriggered' },
    [ActivityActionType.AGENT_HEARTBEAT_STARTED]: { key: 'agentHeartbeatStarted' },
    [ActivityActionType.AGENT_HEARTBEAT_COMPLETED]: { key: 'agentHeartbeatCompleted' },
    [ActivityActionType.AGENT_HEARTBEAT_FAILED]: { key: 'agentHeartbeatFailed' },
    [ActivityActionType.AGENT_CREATED]: { key: 'agentCreated' },
    [ActivityActionType.AGENT_PAUSED]: { key: 'agentPaused' },
    [ActivityActionType.AGENT_RESUMED]: { key: 'agentResumed' },
    [ActivityActionType.AGENT_BUDGET_EXCEEDED]: { key: 'agentBudgetExceeded' },
    [ActivityActionType.AGENT_FILE_EDITED]: {
        key: 'agentFileEdited',
        params: { subject: detailsText('name') },
    },
    [ActivityActionType.AGENT_TASK_ASSIGNED]: { key: 'agentTaskAssigned' },

    // Missions
    [ActivityActionType.MISSION_CREATED]: {
        key: 'missionCreated',
        params: { subject: detailsText('title') },
    },
    [ActivityActionType.MISSION_COMPLETED]: {
        key: 'missionCompleted',
        params: { subject: detailsText('title') },
    },
    [ActivityActionType.MISSION_FAILED]: { key: 'missionFailed' },
    [ActivityActionType.MISSION_PAUSED]: {
        key: 'missionPaused',
        params: { subject: detailsText('title') },
    },
    [ActivityActionType.MISSION_RESUMED]: {
        key: 'missionResumed',
        params: { subject: detailsText('title') },
    },
    [ActivityActionType.MISSION_TICK]: {
        key: 'missionTick',
        params: { count: detailsCount('ideasCreated') },
    },
    [ActivityActionType.MISSION_TICK_CAPPED]: { key: 'missionTickCapped' },

    // Tasks
    [ActivityActionType.TASK_CREATED]: {
        key: 'taskCreated',
        params: { subject: detailsText('title') },
    },
    [ActivityActionType.TASK_ASSIGNED]: { key: 'taskAssigned' },
    [ActivityActionType.TASK_ASSIGNEE_ADDED]: { key: 'taskAssigned' },
    [ActivityActionType.TASK_TRANSITIONED]: {
        key: 'taskTransitioned',
        params: { to: detailsChoice('to') },
    },
    [ActivityActionType.TASK_COMMENTED]: { key: 'taskCommented' },
    [ActivityActionType.TASK_COMPLETED]: { key: 'taskCompleted' },
    [ActivityActionType.TASK_MERGED]: {
        key: 'taskMerged',
        params: { prNumber: detailsText('prNumber') },
    },
    [ActivityActionType.TASK_MERGE_REFUSED]: {
        key: 'taskMergeRefused',
        params: { prNumber: detailsText('prNumber') },
    },
    [ActivityActionType.TASK_RECURRENCE_FIRED]: { key: 'taskRecurrenceFired' },

    // Goals
    [ActivityActionType.GOAL_LOOP_STARTED]: { key: 'goalLoopStarted' },
    [ActivityActionType.GOAL_LOOP_COMPLETED]: { key: 'goalLoopCompleted' },
    [ActivityActionType.GOAL_ITERATION_DISPATCHED]: {
        key: 'goalIterationDispatched',
        params: { iteration: detailsText('iteration') },
    },
    [ActivityActionType.GOAL_LIMIT_TRIPPED]: { key: 'goalLimitTripped' },

    // Ideas
    [ActivityActionType.IDEA_GENERATED]: {
        key: 'ideaGenerated',
        params: { count: detailsCount('count') },
    },
    [ActivityActionType.IDEA_ACCEPTED]: { key: 'ideaAccepted' },
    [ActivityActionType.IDEA_FAILED]: { key: 'ideaFailed' },

    // Skills
    [ActivityActionType.SKILL_INVOKED]: {
        key: 'skillInvoked',
        params: { subject: detailsText('skillSlug') },
    },
    [ActivityActionType.SKILL_INSTALLED]: { key: 'skillInstalled' },
    [ActivityActionType.SKILL_ATTACHED_TO_AGENT]: { key: 'skillAttachedToAgent' },

    // Inbox
    [ActivityActionType.INBOX_ITEM_CREATED]: { key: 'inboxItemCreated' },
    [ActivityActionType.INBOX_ITEM_ANSWERED]: { key: 'inboxItemAnswered' },

    // Knowledge
    [ActivityActionType.KB_DOCUMENT_CREATED]: {
        key: 'kbDocumentCreated',
        params: { subject: detailsText('path') },
    },
    [ActivityActionType.KB_DOCUMENT_UPDATED]: {
        key: 'kbDocumentUpdated',
        params: { subject: detailsText('path') },
    },
    [ActivityActionType.KB_REEMBED_COMPLETED]: { key: 'kbReembedCompleted' },

    // Git
    [ActivityActionType.GIT_PUSHED]: {
        key: 'gitPushed',
        params: { subject: detailsText('repoFullName') },
    },
    [ActivityActionType.GIT_COMMITTED]: {
        key: 'gitCommitted',
        params: { subject: detailsText('repoFullName') },
    },
    [ActivityActionType.GIT_MERGED]: {
        key: 'gitMerged',
        params: { subject: detailsText('repoFullName') },
    },

    // External events, schedules and delivery
    [ActivityActionType.EXTERNAL_EVENT_INGESTED]: {
        key: 'externalEventIngested',
        params: { subject: metadataText('kind') },
    },
    [ActivityActionType.SCHEDULE_EXECUTED]: {
        key: 'scheduleExecuted',
        params: { work: WORK_NAME },
    },
    [ActivityActionType.DEPLOYMENT]: {
        key: 'deploymentCompleted',
        params: { work: WORK_NAME, status: STATUS },
    },
    [ActivityActionType.GENERATION]: {
        key: 'generationCompleted',
        params: { work: WORK_NAME, status: STATUS },
    },
    [ActivityActionType.MEMORY_FOLDER_SYNCED]: {
        key: 'memoryFolderSynced',
        params: { subject: detailsText('path') },
    },
};

/** The fallback message key for an action type with no bespoke narration. */
export const FEED_NARRATION_FALLBACK_KEY = 'fallback';

/** The minimal record shape narration reads. */
export interface NarratableActivity {
    actionType: string;
    status: string;
    details?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
    work?: { name?: string | null } | null;
}

const CHOICE_TOKEN = /^[a-z][a-z_]{0,31}$/;

/**
 * Make a value safe to interpolate into a feed line: one line, no angle
 * brackets, no control characters, credential-shaped spans redacted, and at
 * most {@link FEED_NARRATION_PARAM_MAX_CHARS} characters with a trailing
 * ellipsis. Returns `''` for anything that is not a usable string or number.
 */
export function sanitizeNarrationParam(value: unknown): string {
    let text: string;
    if (typeof value === 'string') {
        text = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
        text = String(value);
    } else {
        return '';
    }
    const redacted = redactSecrets(text).cleaned ?? '';
    const oneLine = sanitizeName(redacted.replace(/[<>]/g, ''), Number.MAX_SAFE_INTEGER);
    const chars = Array.from(oneLine);
    if (chars.length <= FEED_NARRATION_PARAM_MAX_CHARS) return oneLine;
    return `${chars.slice(0, FEED_NARRATION_PARAM_MAX_CHARS).join('').trimEnd()}…`;
}

/** `task_blocker_added` → `Task blocker added`. Never an underscored token. */
export function humanizeActionType(actionType: string): string {
    const words = sanitizeNarrationParam(actionType)
        .replace(/[._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    if (!words) return '';
    return words.charAt(0).toUpperCase() + words.slice(1);
}

function readSource(activity: NarratableActivity, source: NarrationSource): unknown {
    switch (source.from) {
        case 'details':
            return readOwn(activity.details, source.key);
        case 'metadata':
            return readOwn(activity.metadata, source.key);
        case 'workName':
            return activity.work?.name ?? null;
        case 'status':
            return activity.status;
        default:
            return null;
    }
}

/** Own enumerable top-level key only — never a prototype or nested path. */
function readOwn(bag: Record<string, unknown> | null | undefined, key: string): unknown {
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return null;
    return Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : null;
}

function flagName(param: string): string {
    return `has${param.charAt(0).toUpperCase()}${param.slice(1)}`;
}

/**
 * Narrate one record. `actorLabel` is the resolved actor name (or `null`
 * when the renderer should use its own label for the actor kind).
 */
export function narrate(activity: NarratableActivity, actorLabel: string | null): FeedNarrationDto {
    const actor = sanitizeNarrationParam(actorLabel ?? '');
    const entry = FEED_NARRATORS[activity.actionType];
    if (!entry) {
        return {
            key: FEED_NARRATION_FALLBACK_KEY,
            params: { actor, action: humanizeActionType(activity.actionType) },
        };
    }

    const params: Record<string, string | number> = { actor };
    for (const [name, spec] of Object.entries(entry.params ?? {})) {
        const raw = readSource(activity, spec.source);
        if (spec.kind === 'choice') {
            const token = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
            params[name] = CHOICE_TOKEN.test(token) ? token : 'unknown';
            continue;
        }
        if (spec.kind === 'count') {
            const count = typeof raw === 'number' ? raw : Number.NaN;
            const valid = Number.isInteger(count) && count >= 0;
            if (valid) params[name] = count;
            params[flagName(name)] = valid ? 'yes' : 'no';
            continue;
        }
        const text = sanitizeNarrationParam(raw);
        if (text) params[name] = text;
        params[flagName(name)] = text ? 'yes' : 'no';
    }
    return { key: entry.key, params };
}
