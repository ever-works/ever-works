import type { EntityManager } from 'typeorm';
import type { Task } from '../entities/task.entity';
import { teamResourceIds } from './domain-event-snapshots';

/**
 * Task entity column → integration DTO field (integration contract v1, B.6).
 * Columns not listed are not part of the DTO (runtime, schedule and
 * plumbing columns): a change to them still bumps the version but names no
 * changed field.
 */
const TASK_COLUMN_TO_DTO_FIELD: Readonly<Partial<Record<keyof Task, string>>> = {
    title: 'title',
    description: 'description',
    status: 'status',
    priority: 'priority',
    labels: 'labels',
    workId: 'workId',
    missionId: 'missionId',
    ideaId: 'ideaId',
    goalId: 'goalId',
    agentId: 'agentId',
    teamId: 'teamIds',
    parentTaskId: 'parentTaskId',
    startedAt: 'startedAt',
    completedAt: 'completedAt',
    hiddenFromBoard: 'hiddenFromBoard',
    isRecurring: 'isRecurringTemplate',
    // EW-P2-3 — planning dates + estimate (contract v1 B.6, P2 fields).
    dueAt: 'dueAt',
    startAt: 'startAt',
    estimateMinutes: 'estimateMinutes',
};

const toEventValue = (value: unknown): unknown =>
    value instanceof Date ? value.toISOString() : (value ?? null);

/**
 * `changedFields` and `previous` of a `task.updated` event for a patch about to
 * be written to `before`. `teamId` is reported as `teamIds`; its previous value
 * here is the old `teamId` alone — {@link describeTaskPatchIn} completes it with
 * the task's `team_resources` links, which is what the DTO's `teamIds` holds.
 */
export function describeTaskPatch(
    patch: Partial<Task>,
    before?: Partial<Task> | null,
): { changedFields: string[]; previous: Record<string, unknown> } {
    const changedFields: string[] = [];
    const previous: Record<string, unknown> = {};
    for (const key of Object.keys(patch) as Array<keyof Task>) {
        const field = TASK_COLUMN_TO_DTO_FIELD[key];
        if (!field || changedFields.includes(field)) continue;
        if (
            before &&
            JSON.stringify(toEventValue(before[key])) === JSON.stringify(toEventValue(patch[key]))
        ) {
            continue;
        }
        changedFields.push(field);
        if (before) {
            previous[field] =
                key === 'teamId'
                    ? before.teamId
                        ? [before.teamId]
                        : []
                    : toEventValue(before[key]);
        }
    }
    return { changedFields, previous };
}

/**
 * {@link describeTaskPatch}, with `previous.teamIds` as the DTO had it: the old
 * `teamId` plus the task's `team_resources` links (which a `teamId` patch does
 * not change), in the snapshot's order.
 */
export async function describeTaskPatchIn(
    manager: EntityManager,
    taskId: string,
    patch: Partial<Task>,
    before?: Partial<Task> | null,
): Promise<{ changedFields: string[]; previous: Record<string, unknown> }> {
    const described = describeTaskPatch(patch, before);
    if (before && described.changedFields.includes('teamIds')) {
        const links = await teamResourceIds(manager, 'task', taskId);
        described.previous.teamIds = [
            ...new Set([...(before.teamId ? [before.teamId] : []), ...links]),
        ];
    }
    return described;
}
