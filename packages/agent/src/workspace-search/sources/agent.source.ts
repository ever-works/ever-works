import { Agent } from '../../entities/agent.entity';
import type { WorkspaceSearchSourceDefinition } from '../workspace-search.types';

/** Agents — matched on name, slug and title (the role line). */
export const agentSource: WorkspaceSearchSourceDefinition<Agent> = {
    kind: 'agent',
    entity: Agent,
    alias: 'agent',
    titleColumn: 'name',
    identifierColumn: 'slug',
    secondaryColumns: ['title'],
    toCandidate: (row) => ({
        kind: 'agent',
        sourceId: row.id,
        title: row.name,
        identifier: row.slug ?? null,
        secondary: [row.title ?? ''],
        subtitle: row.title ?? null,
        statusLabel: row.status ?? null,
        destination: `/agents/${row.id}`,
        updatedAt: row.updatedAt ?? null,
    }),
};
