import { PUBLISHABLE_ACTIVITY_ACTIONS } from '@ever-works/contracts/api';
import { ActivityActionType } from '../entities/activity-log.types';

export { PUBLISHABLE_ACTIVITY_ACTIONS };

const PUBLISHABLE = new Set<string>(PUBLISHABLE_ACTIVITY_ACTIONS);

/**
 * Shared view — the activity kinds that never reach the published strip.
 *
 * Derived, not hand-listed: every `ActivityActionType` member that is not on
 * the publishable allowlist. That makes the classification total by
 * construction and keeps the default CLOSED — a kind added tomorrow by any
 * feature is unpublished until somebody adds it to
 * `PUBLISHABLE_ACTIVITY_ACTIONS` on purpose, without every other feature
 * that adds an activity kind having to edit this file too.
 *
 * Why the rest stay off, by cluster: generation, deployment, Works, items,
 * templates, schedules, imports and settings name Works or configuration;
 * plugins, connections, MCP, environments and repositories name
 * integrations; members name people; budgets and credits are money; failed
 * runs, heartbeats, gates, reviews and merges carry error text or pull
 * requests; missions, ideas and goals are what a Task is filed against;
 * knowledge, memory and files carry paths; inbox items are decisions;
 * comments are comments; git events carry repository names; Shared view
 * changes are the owner's own configuration.
 */
export const NEVER_PUBLISH_ACTIVITY_ACTIONS: readonly string[] = Object.freeze(
    (Object.values(ActivityActionType) as string[]).filter(
        (actionType) => !PUBLISHABLE.has(actionType),
    ),
);

/** Fail closed: anything not deliberately published is dropped. */
export function isActivityPublishable(actionType: string): boolean {
    return PUBLISHABLE.has(actionType);
}
