import type { Agent } from '../agent.entity';
import type { Goal } from '../goal.entity';
import type { Mission } from '../mission.entity';
import { toAgentDto } from '../../agents/types';
import { toGoalDto } from '../../goals/types';
import { toMissionDto } from '../../missions/types';
import type {
    MissionWorkWithMission,
    MissionWorkWithWork,
} from '../../database/repositories/mission-work.repository';

describe('organization ownership response contracts', () => {
    const ownership = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };

    it.each([
        ['MissionDto', () => toMissionDto({ ...ownership } as Mission)],
        ['GoalDto', () => toGoalDto({ ...ownership } as Goal)],
        ['AgentDto', () => toAgentDto({ ...ownership } as Agent)],
    ])('%s exposes the persisted tenant and Organization ids', (_name, project) => {
        expect(project()).toMatchObject(ownership);
    });

    it.each([
        [
            'MissionWorkWithWork',
            {
                id: 'relation-1',
                ...ownership,
                missionId: 'mission-1',
                workId: 'work-1',
                relation: 'created',
                createdAt: new Date(0),
                workName: 'Work',
                workSlug: 'work',
            } satisfies MissionWorkWithWork,
        ],
        [
            'MissionWorkWithMission',
            {
                id: 'relation-1',
                ...ownership,
                missionId: 'mission-1',
                workId: 'work-1',
                relation: 'created',
                createdAt: new Date(0),
                missionTitle: 'Mission',
                missionStatus: 'active',
            } satisfies MissionWorkWithMission,
        ],
        // A TYPE contract, not a runtime one (#2213 `ownership-observability-tautology`): the
        // `satisfies` above stops compiling if either projection type drops `tenantId` /
        // `organizationId`, but these literals never touch the repository, so a broken SELECT
        // would stay green here. The runtime projection is pinned by the select strings in
        // `database/repositories/mission-work.repository.organization-scope.spec.ts`.
    ])('%s type carries the ownership columns (compile-time contract)', (_name, projection) => {
        expect(projection).toMatchObject(ownership);
    });
});
