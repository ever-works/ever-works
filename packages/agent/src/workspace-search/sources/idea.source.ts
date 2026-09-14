import { WorkProposal } from '../../entities/work-proposal.entity';
import type { WorkspaceSearchSourceDefinition } from '../workspace-search.types';

/** Ideas — matched on title and description. */
export const ideaSource: WorkspaceSearchSourceDefinition<WorkProposal> = {
    kind: 'idea',
    entity: WorkProposal,
    alias: 'idea',
    titleColumn: 'title',
    secondaryColumns: ['description'],
    toCandidate: (row) => ({
        kind: 'idea',
        sourceId: row.id,
        title: row.title,
        identifier: null,
        secondary: [row.description ?? ''],
        subtitle: null,
        statusLabel: row.status ?? null,
        destination: `/ideas/${row.id}`,
        updatedAt: row.updatedAt ?? null,
    }),
};
