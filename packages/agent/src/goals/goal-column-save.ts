import type { Repository } from 'typeorm';
import { withoutAggregateVersion } from '../domain-events/domain-event-context';
import type { Goal } from '../entities/goal.entity';

/**
 * Save only the columns a write decided (EW-P2-2 follow-up).
 *
 * The Goal handed in is a copy read earlier (a due scan, an orchestrator tick, a
 * `findOrThrow` before a slow dispatch). A whole-entity `save()` writes back every column
 * of that copy, so a concurrent write made meanwhile — an integration's PATCH, a pushed
 * external sample (`currentValue`, `resolvedScore`), a Definition-of-Done edit, a loop
 * control — would be silently undone. Here every column outside `written` (and the primary
 * key) is cleared for the save: TypeORM skips an `undefined` property on update, so only
 * the decided columns are written, and `version` is never rolled back
 * ({@link withoutAggregateVersion}). The cleared values (the copy's `version` included) are
 * put back on the object after the save, except a column the save itself set (e.g.
 * `updatedAt`), which keeps its new value.
 *
 * Without entity metadata (a unit-test double) it is the plain save.
 */
export async function saveGoalColumns(
    repository: Repository<Goal>,
    goal: Goal,
    written: ReadonlyArray<keyof Goal>,
): Promise<Goal> {
    const columns = (repository.metadata?.columns ?? [])
        .filter((column) => !column.embeddedMetadata)
        .map((column) => column.propertyName as keyof Goal);
    const keep = new Set<keyof Goal>(['id', ...written]);
    const target = goal as unknown as Record<string, unknown>;
    const held = new Map<string, unknown>();
    for (const column of columns) {
        if (keep.has(column)) continue;
        held.set(column, target[column]);
        target[column] = undefined;
    }
    try {
        return await repository.save(withoutAggregateVersion(goal));
    } finally {
        for (const [column, value] of held) {
            if (target[column] === undefined) target[column] = value;
        }
    }
}
