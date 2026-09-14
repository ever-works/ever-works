import { Mission } from '../../entities/mission.entity';
import type { WorkspaceSearchSourceDefinition } from '../workspace-search.types';

/** Missions — matched on title and description; badge is the Mission status. */
export const missionSource: WorkspaceSearchSourceDefinition<Mission> = {
    kind: 'mission',
    entity: Mission,
    alias: 'mission',
    titleColumn: 'title',
    secondaryColumns: ['description'],
    toCandidate: (row) => ({
        kind: 'mission',
        sourceId: row.id,
        title: row.title,
        identifier: null,
        secondary: [row.description],
        subtitle: null,
        statusLabel: row.status ?? null,
        destination: `/missions/${row.id}`,
        updatedAt: row.updatedAt ?? null,
    }),
};
