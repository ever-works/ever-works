import type { FeedKind } from '@ever-works/contracts';
import {
    ActivityActionType,
    ActivityStatus,
    type ActivityFeedKind,
    type ActivityFeedKindSets,
} from '../entities/activity-log.types';

/**
 * Live Feed — the one place that answers "which of the five feed kinds does
 * this activity record belong to?".
 *
 * A kind is DERIVED from the action type and the record's status, never
 * stored. The same table drives in-memory classification (each rendered
 * entry) and SQL filtering (the kind chips), through
 * {@link buildFeedKindSets}, so the two cannot drift.
 */

/**
 * How an action type classifies before the status is considered.
 *
 * `deliveryWhenCompleted` is for long-running operations whose record moves
 * through `in_progress` to a terminal state: while running they are `work`,
 * once completed they are `delivery`.
 */
export type FeedKindRule =
    | 'work'
    | 'decision'
    | 'delivery'
    | 'deliveryWhenCompleted'
    | 'system'
    | 'problem';

/** Any record with one of these statuses is a problem, whatever its type (spec FR-18). */
export const FEED_PROBLEM_STATUSES: readonly string[] = [
    ActivityStatus.FAILED,
    ActivityStatus.CANCELLED,
];

/**
 * Suffixes that mark an action type as a failure, refusal or tripped limit.
 * Applied to action types that are NOT in {@link FEED_KIND_RULES} (a writer
 * shipped a new member without a mapping decision), so an unmapped
 * `*_failed` still reads as a problem.
 */
const PROBLEM_SUFFIXES = ['_failed', '_refused', '_tripped', '_exceeded', '_capped', '_violation'];

/**
 * The explicit decision for every `ActivityActionType` member. A new member
 * without an entry falls back to the suffix rule and then to `work`, and the
 * table-driven spec fails until someone decides where it belongs.
 */
export const FEED_KIND_RULES: Readonly<Record<string, FeedKindRule>> = {
    // Generation / deployment — work while running, delivery once done.
    [ActivityActionType.GENERATION]: 'deliveryWhenCompleted',
    [ActivityActionType.COMPARISON_GENERATION]: 'deliveryWhenCompleted',
    [ActivityActionType.DEPLOYMENT]: 'deliveryWhenCompleted',

    // Work lifecycle + items
    [ActivityActionType.WORK_CREATED]: 'work',
    [ActivityActionType.WORK_UPDATED]: 'work',
    [ActivityActionType.WORK_DELETED]: 'work',
    [ActivityActionType.ITEM_ADDED]: 'work',
    [ActivityActionType.ITEM_UPDATED]: 'work',
    [ActivityActionType.ITEM_REMOVED]: 'work',
    // APW-11 (App Launcher, APW11-G05) — the Work-level **Show in App
    // Launcher** setting changed. `work` is the deliberate bucket: this is
    // Work metadata changing, exactly like the `WORK_UPDATED` row beside it.
    // It is not `delivery` (nothing was generated or deployed) and not
    // `decision` (nothing is held waiting on a person). Revisiting the
    // decision means a *different* value in this same table, never an
    // omission — `feed-kind.spec.ts:14-18` fails on any member without an
    // entry.
    [ActivityActionType.APP_LAUNCHER]: 'work',

    // APW-03 (App spec) — Resolution R-2's first family (R-34: every new
    // `ActivityActionType` member gets an explicit bucket here, or
    // `feed-kind.spec.ts:14-19` fails). `deliveryWhenCompleted` is the
    // deliberate bucket: applying the App spec is what makes a Work's declared
    // build and runtime real (`app.spec.applied`, plan §2.3), so it reads as
    // `work` while an evaluation is in flight and `delivery` once it has
    // landed — the same shape as the generation and deployment families above.
    // `app.spec.invalid` is written with `ActivityStatus.FAILED`, and
    // `resolveFeedKind` classifies any failed status as a `problem` before it
    // consults this table, so a spec error surfaces as a problem with no second
    // rule. The dotted `action` values of the family
    // (`app.spec.validated` / `app.spec.invalid` / `app.spec.applied`) are
    // Resolution R-2's names and never appear here — the bucket is per
    // `actionType`.
    [ActivityActionType.APP_SPEC]: 'deliveryWhenCompleted',

    // Plugins
    [ActivityActionType.PLUGIN_ENABLED]: 'system',
    [ActivityActionType.PLUGIN_DISABLED]: 'system',
    [ActivityActionType.PLUGIN_CONFIGURED]: 'system',
    [ActivityActionType.PLUGIN_INSTALLED]: 'system',
    [ActivityActionType.PLUGIN_INSTALL_FAILED]: 'problem',
    [ActivityActionType.PLUGIN_UNINSTALLED]: 'system',

    // Templates
    [ActivityActionType.TEMPLATE_ADDED]: 'system',
    [ActivityActionType.TEMPLATE_UPDATED]: 'system',
    [ActivityActionType.TEMPLATE_ARCHIVED]: 'system',
    [ActivityActionType.TEMPLATE_FORKED]: 'system',
    [ActivityActionType.TEMPLATE_DEFAULT_SET]: 'system',

    // Members
    [ActivityActionType.MEMBER_INVITED]: 'system',
    [ActivityActionType.MEMBER_ROLE_CHANGED]: 'system',
    [ActivityActionType.MEMBER_REMOVED]: 'system',

    // Schedules
    [ActivityActionType.SCHEDULE_CREATED]: 'system',
    [ActivityActionType.SCHEDULE_UPDATED]: 'system',
    [ActivityActionType.SCHEDULE_DELETED]: 'system',
    [ActivityActionType.SCHEDULE_EXECUTED]: 'work',
    // Schedules workspace pause / resume — an owner changing a cadence's
    // control state, the same configuration shape as create/update/delete.
    [ActivityActionType.SCHEDULE_PAUSED]: 'system',
    [ActivityActionType.SCHEDULE_RESUMED]: 'system',

    // Import / export
    [ActivityActionType.IMPORT]: 'work',
    [ActivityActionType.EXPORT]: 'delivery',

    // Settings
    [ActivityActionType.SETTINGS_UPDATED]: 'system',
    [ActivityActionType.WEBSITE_SETTINGS_UPDATED]: 'system',
    [ActivityActionType.PROMPTS_UPDATED]: 'system',
    [ActivityActionType.WORKS_CONFIG_SYNC]: 'system',

    // Auth / account
    [ActivityActionType.USER_LOGIN]: 'system',
    [ActivityActionType.USER_SIGNUP]: 'system',
    [ActivityActionType.PROVIDER_CONNECTED]: 'system',
    [ActivityActionType.PASSWORD_CHANGED]: 'system',

    // Chat / community
    [ActivityActionType.CHAT_CONVERSATION]: 'work',
    [ActivityActionType.COMMUNITY_PR_MERGED]: 'delivery',

    // Deployed-site events
    [ActivityActionType.WEBSITE_USER_REGISTERED]: 'work',
    [ActivityActionType.WEBSITE_ITEM_SUBMITTED]: 'work',
    [ActivityActionType.WEBSITE_REPORT_FILED]: 'work',
    [ActivityActionType.WEBSITE_REPORT_RESOLVED]: 'work',

    // Data-repo sync
    [ActivityActionType.DATA_SYNC_SUCCESS]: 'system',
    [ActivityActionType.DATA_SYNC_SKIPPED]: 'system',
    [ActivityActionType.DATA_SYNC_FAILED]: 'problem',

    // Knowledge base
    [ActivityActionType.KB_UPLOAD_CREATED]: 'work',
    [ActivityActionType.KB_UPLOAD_DEDUPED]: 'system',
    [ActivityActionType.KB_UPLOAD_EXTRACTED]: 'system',
    [ActivityActionType.KB_UPLOAD_EXTRACTION_FAILED]: 'problem',
    [ActivityActionType.KB_UPLOAD_EXTRACTION_SKIPPED]: 'system',
    [ActivityActionType.KB_DOCUMENT_CREATED]: 'delivery',
    [ActivityActionType.KB_DOCUMENT_UPDATED]: 'delivery',
    [ActivityActionType.KB_DOCUMENT_DELETED]: 'work',
    [ActivityActionType.KB_DOCUMENT_LOCKED]: 'system',
    [ActivityActionType.KB_DOCUMENT_UNLOCKED]: 'system',
    [ActivityActionType.KB_DOCUMENT_RESTORED]: 'delivery',
    [ActivityActionType.KB_DOCUMENT_LOCK_VIOLATION]: 'problem',
    [ActivityActionType.KB_RECONCILE_COMPLETED]: 'system',
    [ActivityActionType.KB_UPLOAD_TOMBSTONED]: 'system',
    [ActivityActionType.KB_UPLOAD_REVIVED]: 'system',
    [ActivityActionType.KB_CONTEXT_TRUNCATED]: 'system',
    [ActivityActionType.KB_UPLOAD_TRANSCRIBED]: 'system',
    [ActivityActionType.KB_UPLOAD_TRANSCRIPTION_FAILED]: 'problem',
    [ActivityActionType.MEMORY_FOLDER_CREATED]: 'work',
    [ActivityActionType.MEMORY_FOLDER_DELETED]: 'work',
    [ActivityActionType.MEMORY_FOLDER_SYNCED]: 'delivery',
    [ActivityActionType.KB_WIKILINK_REWRITTEN]: 'system',
    [ActivityActionType.KB_REEMBED_STARTED]: 'system',
    [ActivityActionType.KB_REEMBED_COMPLETED]: 'delivery',
    [ActivityActionType.KB_REEMBED_FAILED]: 'problem',

    // Memory facts + context files (AW-07) — fact edits and context-file
    // saves are work, a load-mode change is configuration, and a segment
    // over its budget is a tripped limit.
    [ActivityActionType.MEMORY_FACT_CREATED]: 'work',
    [ActivityActionType.MEMORY_FACT_UPDATED]: 'work',
    [ActivityActionType.MEMORY_FACT_FORGOTTEN]: 'work',
    [ActivityActionType.MEMORY_FACT_RESTORED]: 'work',
    [ActivityActionType.MEMORY_FACT_ACCEPTED]: 'work',
    [ActivityActionType.MEMORY_FACT_DISCARDED]: 'work',
    [ActivityActionType.MEMORY_FACTS_CLEARED]: 'work',
    [ActivityActionType.CONTEXT_FILE_UPDATED]: 'work',
    [ActivityActionType.CONTEXT_FILE_RESTORED]: 'work',
    [ActivityActionType.CONTEXT_FILE_MODE_CHANGED]: 'system',
    [ActivityActionType.CONTEXT_BUDGET_EXCEEDED]: 'problem',

    // Missions
    [ActivityActionType.MISSION_CREATED]: 'work',
    [ActivityActionType.MISSION_PAUSED]: 'work',
    [ActivityActionType.MISSION_RESUMED]: 'work',
    [ActivityActionType.MISSION_COMPLETED]: 'work',
    [ActivityActionType.MISSION_FAILED]: 'problem',
    [ActivityActionType.MISSION_DELETED]: 'work',
    [ActivityActionType.MISSION_TICK_CAPPED]: 'problem',
    [ActivityActionType.MISSION_TICK]: 'work',

    // Goals
    [ActivityActionType.GOAL_LOOP_STARTED]: 'work',
    [ActivityActionType.GOAL_LOOP_PAUSED]: 'work',
    [ActivityActionType.GOAL_LOOP_RESUMED]: 'work',
    [ActivityActionType.GOAL_LOOP_CANCELLED]: 'work',
    [ActivityActionType.GOAL_LOOP_COMPLETED]: 'work',
    [ActivityActionType.GOAL_ITERATION_DISPATCHED]: 'work',
    [ActivityActionType.GOAL_ITERATION_NUDGED]: 'work',
    [ActivityActionType.GOAL_LIMIT_TRIPPED]: 'problem',
    [ActivityActionType.GOAL_DOD_UPDATED]: 'work',
    [ActivityActionType.GOAL_ARCHIVED]: 'work',
    [ActivityActionType.GOAL_UNARCHIVED]: 'work',

    // Ideas
    [ActivityActionType.IDEA_GENERATED]: 'work',
    [ActivityActionType.IDEA_DISMISSED]: 'work',
    [ActivityActionType.IDEA_QUEUED]: 'work',
    [ActivityActionType.IDEA_ACCEPTED]: 'work',
    [ActivityActionType.IDEA_FAILED]: 'problem',
    [ActivityActionType.IDEA_REBUILD_STARTED]: 'work',
    [ActivityActionType.IDEA_DELETED]: 'work',

    // Agents
    [ActivityActionType.AGENT_CREATED]: 'work',
    [ActivityActionType.AGENT_PAUSED]: 'work',
    [ActivityActionType.AGENT_RESUMED]: 'work',
    [ActivityActionType.AGENT_ARCHIVED]: 'work',
    [ActivityActionType.AGENT_UNARCHIVED]: 'work',
    [ActivityActionType.AGENT_DELETED]: 'work',
    [ActivityActionType.AGENT_HEARTBEAT_STARTED]: 'work',
    [ActivityActionType.AGENT_HEARTBEAT_COMPLETED]: 'work',
    [ActivityActionType.AGENT_HEARTBEAT_FAILED]: 'problem',
    [ActivityActionType.AGENT_RUN_CANCELLED]: 'work',
    [ActivityActionType.AGENT_RUN_TRIGGERED]: 'work',
    [ActivityActionType.AGENT_TASK_ASSIGNED]: 'work',
    [ActivityActionType.AGENT_FILE_EDITED]: 'work',
    [ActivityActionType.AGENT_FILE_REVERTED]: 'work',
    [ActivityActionType.AGENT_FILE_EDIT_FAILED]: 'problem',
    [ActivityActionType.AGENT_BUDGET_EXCEEDED]: 'problem',
    [ActivityActionType.AGENT_EXPORTED]: 'work',
    [ActivityActionType.AGENT_IMPORTED]: 'work',
    // AW-23 — a dead credential is a PROBLEM: it is the one halt the
    // owner has to go and fix, and it stopped the agent after a single
    // failure rather than three. A held run and a released batch are
    // ordinary `work`: nothing failed, the brake did exactly its job.
    [ActivityActionType.AGENT_BLOCKED_ON_CREDENTIAL]: 'problem',
    [ActivityActionType.AGENT_RUN_HELD]: 'work',
    [ActivityActionType.AGENT_RUNS_RELEASED]: 'work',
    [ActivityActionType.AGENT_COLLABORATOR_ENABLED]: 'system',
    [ActivityActionType.AGENT_COLLABORATOR_DISABLED]: 'system',
    [ActivityActionType.AGENT_COLLABORATOR_REMOVED]: 'system',
    [ActivityActionType.AGENT_RUN_STARTED]: 'work',
    [ActivityActionType.AGENT_RUN_COMPLETED]: 'work',
    [ActivityActionType.AGENT_RUN_FAILED]: 'problem',
    // Agent computers — a person took control of the Agent's computer for a while.
    [ActivityActionType.AGENT_COMPUTER_CONTROLLED]: 'work',

    // Environments
    [ActivityActionType.ENVIRONMENT_CREATED]: 'system',
    [ActivityActionType.ENVIRONMENT_UPDATED]: 'system',
    [ActivityActionType.ENVIRONMENT_PUBLISHED]: 'system',
    [ActivityActionType.ENVIRONMENT_DELETED]: 'system',

    // Skills
    [ActivityActionType.SKILL_INSTALLED]: 'work',
    [ActivityActionType.SKILL_ATTACHED_TO_AGENT]: 'work',
    [ActivityActionType.SKILL_INVOKED]: 'work',
    [ActivityActionType.SKILL_FILE_EDITED]: 'work',

    // Repository registry
    [ActivityActionType.REPO_CONNECTION_CREATED]: 'system',
    [ActivityActionType.REPO_CONNECTION_UPDATED]: 'system',
    [ActivityActionType.REPO_CONNECTION_DELETED]: 'system',
    [ActivityActionType.REPO_CONNECTION_IMPORTED]: 'system',
    [ActivityActionType.REPO_ATTACHED_TO_AGENT]: 'system',
    [ActivityActionType.REPO_DETACHED_FROM_AGENT]: 'system',

    // Tasks
    [ActivityActionType.TASK_CREATED]: 'work',
    [ActivityActionType.TASK_UPDATED]: 'work',
    [ActivityActionType.TASK_DELETED]: 'work',
    [ActivityActionType.TASK_ASSIGNED]: 'work',
    [ActivityActionType.TASK_ASSIGNEE_ADDED]: 'work',
    [ActivityActionType.TASK_ASSIGNEE_REMOVED]: 'work',
    [ActivityActionType.TASK_BLOCKER_ADDED]: 'work',
    [ActivityActionType.TASK_BLOCKER_REMOVED]: 'work',
    [ActivityActionType.TASK_TRANSITIONED]: 'work',
    [ActivityActionType.TASK_COMMENTED]: 'work',
    [ActivityActionType.TASK_COMPLETED]: 'work',
    [ActivityActionType.TASK_RECURRENCE_FIRED]: 'work',
    [ActivityActionType.TASK_MERGED]: 'delivery',
    [ActivityActionType.TASK_MERGE_REFUSED]: 'problem',

    // External events + git
    [ActivityActionType.EXTERNAL_EVENT_INGESTED]: 'work',
    [ActivityActionType.GIT_PUSHED]: 'work',
    [ActivityActionType.GIT_COMMITTED]: 'work',
    [ActivityActionType.GIT_MERGED]: 'delivery',

    // MCP connections
    [ActivityActionType.MCP_CONNECTION_CREATED]: 'system',
    [ActivityActionType.MCP_CONNECTION_UPDATED]: 'system',
    [ActivityActionType.MCP_CONNECTION_DELETED]: 'system',
    [ActivityActionType.MCP_CONNECTION_TESTED]: 'system',
    [ActivityActionType.MCP_BINDING_UPDATED]: 'system',

    // Inbox — the decisions only a person can make
    [ActivityActionType.INBOX_ITEM_CREATED]: 'decision',
    [ActivityActionType.INBOX_ITEM_ANSWERED]: 'decision',

    // Model Accounts and model policies — workspace configuration.
    [ActivityActionType.MODEL_ACCOUNT_ADDED]: 'system',
    [ActivityActionType.MODEL_ACCOUNT_UPDATED]: 'system',
    [ActivityActionType.MODEL_ACCOUNT_REMOVED]: 'system',
    [ActivityActionType.MODEL_ACCOUNT_PAUSED]: 'system',
    [ActivityActionType.MODEL_ACCOUNT_RESUMED]: 'system',
    [ActivityActionType.MODEL_ACCOUNT_RECONNECTED]: 'system',
    [ActivityActionType.MODEL_ACCOUNT_REORDERED]: 'system',
    [ActivityActionType.MODEL_POLICY_UPDATED]: 'system',

    // Skills shelf — a person switching a Skill on or off.
    [ActivityActionType.SKILL_ENABLED]: 'system',
    [ActivityActionType.SKILL_DISABLED]: 'system',

    // Shared view (AW-18) — the owner's own sharing configuration changes.
    [ActivityActionType.SHARED_VIEW_ENABLED]: 'system',
    [ActivityActionType.SHARED_VIEW_DISABLED]: 'system',
    [ActivityActionType.SHARED_VIEW_REGENERATED]: 'system',
    [ActivityActionType.SHARED_VIEW_SECTIONS_CHANGED]: 'system',
    [ActivityActionType.SHARED_VIEW_INDEXING_CHANGED]: 'system',

    // Knowledge library — shelf curation (filing, archive, export) and shared-folder rename.
    [ActivityActionType.KB_DOCUMENT_ARCHIVED]: 'work',
    [ActivityActionType.KB_DOCUMENT_UNARCHIVED]: 'work',
    [ActivityActionType.KB_DOCUMENT_FILED]: 'work',
    [ActivityActionType.KB_DOCUMENT_EXPORTED]: 'work',
    [ActivityActionType.MEMORY_FOLDER_RENAMED]: 'work',

    // Workspace backup (AW-22). Starting one is work the owner set going;
    // downloading one is the moment a copy of the whole workspace leaves the
    // platform, which is exactly what `EXPORT` is classified as beside it;
    // removing the bytes early is a settings-shaped act on the workspace.
    [ActivityActionType.WORKSPACE_BACKUP_CREATED]: 'work',
    [ActivityActionType.WORKSPACE_BACKUP_DOWNLOADED]: 'delivery',
    [ActivityActionType.WORKSPACE_BACKUP_DELETED]: 'system',

    // App Works (APW-02) — fork readiness, Actions hygiene and upstream sync.
    // Three families, three deliberate decisions; the dotted `action` decides
    // which event of the family a row is, so each of these is a family-level
    // call and the row's `status` (CONTRACTS §0 R-34) finishes the job.
    //
    // `app_fork` is the epic's long-running operation: the job polls a fork
    // from `preparing` to `ready`, so while it runs its row reads as `work`
    // and the terminal success — "your fork is ready" — reads as `delivery`,
    // the same shape as `GENERATION` / `DEPLOYMENT` above and APW-09's
    // `app_upstream_pr`. `app.fork.timeout` and `app.fork.missing` are
    // recorded `FAILED`, which `FEED_PROBLEM_STATUSES` turns into `problem`
    // before this rule is ever consulted.
    //
    // `app_actions` records repository hygiene on the App Work — the
    // workflows the platform switched off in the member's fork. It is not
    // `delivery` (nothing was generated or deployed), not `decision` (nothing
    // is held waiting on a person) and not `system` (that bucket is the
    // member's own configuration and platform object lifecycle —
    // `SETTINGS_UPDATED`, `ENVIRONMENT_*`, `MODEL_ACCOUNT_*`,
    // `REPO_CONNECTION_*`). The platform's own writes into a repository are
    // `work` beside it (`GIT_PUSHED`, `GIT_COMMITTED`), which is the closest
    // sibling this family has.
    //
    // `app_upstream` is deliberately `work` and NOT `deliveryWhenCompleted`.
    // The family holds a completed sync, a divergence reading and two failure
    // states, and this table is keyed by family, so it cannot see the dotted
    // `action`: `deliveryWhenCompleted` would report `app.upstream.behind` —
    // a completed comparison in which nothing landed — as a **delivery**,
    // which is a false claim in a user-visible bucket. `work` is coarser for
    // `app.upstream.synced` but never false, and `app.upstream.unavailable`
    // plus any refused or failed sync read as `problem` through their status.
    // Revisiting any of the three means a *different* value here, never an
    // omission — `feed-kind.spec.ts:14-19` fails on a member with no entry.
    [ActivityActionType.APP_FORK]: 'deliveryWhenCompleted',
    [ActivityActionType.APP_ACTIONS]: 'work',
    [ActivityActionType.APP_UPSTREAM]: 'work',

    // APW-05 (Builds) — Resolution R-2's `app_build` family (`APW05-G05`).
    // `deliveryWhenCompleted` is the deliberate bucket, and it is the same call
    // APW-03's `APP_SPEC` and APW-02's `APP_FORK` make: a Build is the epic's
    // long-running operation, so its row reads as `work` while it is queued or
    // running and as `delivery` once it succeeded — which is exactly what the
    // `builds` tab and the Work feed should say. A `failed` or `cancelled` Build
    // is written with those statuses and `resolveFeedKind` classifies any failed
    // status as a `problem` before it consults this table, so a broken Build
    // surfaces as a problem with no second rule. `blocked` writes no Activity row
    // at all (`plan.md:1560`), which is why there is no fifth bucket to decide:
    // the dotted `action` values of the family (`app.build.queued`,
    // `app.build.started`, `app.build.succeeded`, `app.build.failed`,
    // `app.build.cancelled`) never appear here — the bucket is per `actionType`.
    // Revisiting it means a *different* value here, never an omission —
    // `feed-kind.spec.ts:14-19` fails on a member with no entry.
    [ActivityActionType.APP_BUILD]: 'deliveryWhenCompleted',
};

/** The rule for an action type: the explicit decision, else the suffix rule, else `work`. */
export function feedKindRuleFor(actionType: string): FeedKindRule {
    const explicit = FEED_KIND_RULES[actionType];
    if (explicit) return explicit;
    return PROBLEM_SUFFIXES.some((suffix) => actionType.endsWith(suffix)) ? 'problem' : 'work';
}

/**
 * Classify one activity record. The `problem` rule is evaluated FIRST: a
 * failed or cancelled record is a problem whichever cluster its action type
 * belongs to (spec FR-18).
 */
export function resolveFeedKind(actionType: string, status: string | null | undefined): FeedKind {
    if (status && FEED_PROBLEM_STATUSES.includes(status)) return 'problem';
    const rule = feedKindRuleFor(actionType);
    if (rule === 'deliveryWhenCompleted') {
        return status === ActivityStatus.COMPLETED ? 'delivery' : 'work';
    }
    return rule;
}

/**
 * The action-type sets the repository needs to translate a kind filter into
 * SQL. Every known member is listed explicitly; the `work` bucket is the
 * complement, which is how an unmapped action type still reaches it.
 */
export function buildFeedKindSets(): ActivityFeedKindSets {
    const sets: ActivityFeedKindSets = {
        problemStatuses: [...FEED_PROBLEM_STATUSES],
        problemActionTypes: [],
        decisionActionTypes: [],
        systemActionTypes: [],
        deliveryActionTypes: [],
        deliveryWhenCompletedActionTypes: [],
    };
    for (const [actionType, rule] of Object.entries(FEED_KIND_RULES)) {
        switch (rule) {
            case 'problem':
                sets.problemActionTypes.push(actionType);
                break;
            case 'decision':
                sets.decisionActionTypes.push(actionType);
                break;
            case 'system':
                sets.systemActionTypes.push(actionType);
                break;
            case 'delivery':
                sets.deliveryActionTypes.push(actionType);
                break;
            case 'deliveryWhenCompleted':
                sets.deliveryWhenCompletedActionTypes.push(actionType);
                break;
            default:
                break;
        }
    }
    return sets;
}

/**
 * Normalise a kind filter. "Only what failed" is the `problem` kind (spec
 * FR-40) and overrides the kind chips; an empty or absent selection means
 * every kind, which needs no predicate at all.
 */
export function normalizeFeedKinds(
    kinds: readonly string[] | undefined,
    failedOnly: boolean,
): ActivityFeedKind[] | undefined {
    if (failedOnly) return ['problem'];
    if (!kinds || kinds.length === 0) return undefined;
    const known: ActivityFeedKind[] = ['work', 'decision', 'delivery', 'problem', 'system'];
    const selected = known.filter((kind) => kinds.includes(kind));
    return selected.length === 0 || selected.length === known.length ? undefined : selected;
}
