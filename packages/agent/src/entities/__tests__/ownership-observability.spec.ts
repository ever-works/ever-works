import type { Agent } from '../agent.entity';
import type { Goal } from '../goal.entity';
import type { Mission } from '../mission.entity';
import { toAgentDto } from '../../agents/types';
import { toGoalDto } from '../../goals/types';
import { toMissionDto } from '../../missions/types';

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
});
