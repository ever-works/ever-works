import { EventSubscriber, type EntitySubscriberInterface, type InsertEvent } from 'typeorm';
import {
    applyInsertVisibilityDefault,
    hasVisibilityColumns,
    type VisibilityRow,
} from '../entities/_record-visibility';

/**
 * Applies {@link applyInsertVisibilityDefault} to every insert of an entity that carries
 * the visibility columns (tasks, goals, missions, work_proposals, agents) — record
 * visibility, EW-P1-3. Registered in the DataSource `subscribers` (`database.config.ts`),
 * so it runs in every process that writes — the API, the worker and the CLIs — for rows
 * whose scope the caller set explicitly. A subscriber rather than an entity
 * `@BeforeInsert` method: a method on the entity class would drop out of `{ ...task }`
 * spreads and break the structural row types built from them (`TaskWithRun`,
 * `TaskSubtaskRow`).
 *
 * Lives here, not in the entity barrel: every class `../entities` exports is treated as
 * an entity (the EW-638 inventory drift check).
 */
// `@EventSubscriber()` is required: TypeORM only instantiates the classes listed in the
// DataSource `subscribers` option that carry it.
@EventSubscriber()
export class RecordVisibilitySubscriber implements EntitySubscriberInterface {
    beforeInsert(event: InsertEvent<unknown>): void {
        const entity = event.entity as (VisibilityRow & { teamId?: string | null }) | undefined;
        if (!entity || !event.metadata) return;
        if (!hasVisibilityColumns(event.metadata.columns.map((column) => column.propertyName))) {
            return;
        }
        applyInsertVisibilityDefault(entity, Boolean(entity.teamId));
    }
}
