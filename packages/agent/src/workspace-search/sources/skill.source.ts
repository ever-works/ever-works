import { Skill } from '../../entities/skill.entity';
import type { WorkspaceSearchSourceDefinition } from '../workspace-search.types';

/** Skills — matched on title, slug and description. */
export const skillSource: WorkspaceSearchSourceDefinition<Skill> = {
    kind: 'skill',
    entity: Skill,
    alias: 'skill',
    titleColumn: 'title',
    identifierColumn: 'slug',
    secondaryColumns: ['description'],
    toCandidate: (row) => ({
        kind: 'skill',
        sourceId: row.id,
        title: row.title,
        identifier: row.slug ?? null,
        secondary: [row.description ?? ''],
        subtitle: row.slug ?? null,
        statusLabel: null,
        destination: `/skills/${row.id}`,
        updatedAt: row.updatedAt ?? null,
    }),
};
