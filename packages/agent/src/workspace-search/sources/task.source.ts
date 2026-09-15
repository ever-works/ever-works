import { Task } from '../../entities/task.entity';
import type { WorkspaceSearchSourceDefinition } from '../workspace-search.types';

/**
 * Tasks — matched on slug (`T-418`), title, description and labels. A Task is
 * always a Task row; the Mission it may belong to is never its group.
 */
export const taskSource: WorkspaceSearchSourceDefinition<Task> = {
    kind: 'task',
    entity: Task,
    alias: 'task',
    titleColumn: 'title',
    identifierColumn: 'slug',
    secondaryColumns: ['description', 'labels'],
    toCandidate: (row) => ({
        kind: 'task',
        sourceId: row.id,
        title: row.title,
        identifier: row.slug ?? null,
        secondary: [row.description ?? '', ...(row.labels ?? [])],
        subtitle: row.slug ?? null,
        statusLabel: row.status ?? null,
        destination: `/tasks/${row.id}`,
        updatedAt: row.updatedAt ?? null,
    }),
};
