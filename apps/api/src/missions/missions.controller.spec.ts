// The services arrive as doubles through the constructor; the real DTO classes are not needed
// (the bodies below are what the global pipe would have let through).
// The auth decorator and the scope barrel pull `better-auth` (ESM); nothing here drives a router.
jest.mock('../auth/decorators/user.decorator', () => ({ CurrentUser: () => () => undefined }));
jest.mock('../scope', () => ({ ScopeContextService: class ScopeContextService {} }));
// The missions / work-agent / budgets barrels pull the whole agent graph (better-auth's ESM through
// subscriptions); the controller needs only these names at module evaluation. Same pattern as
// `dto/mission.dto.spec.ts`.
jest.mock('@ever-works/agent/missions', () => ({
    MissionsService: class MissionsService {},
    MissionCloneService: class MissionCloneService {},
    MissionStatus: { ACTIVE: 'active', PAUSED: 'paused', COMPLETED: 'completed', FAILED: 'failed' },
    MissionType: { ONE_SHOT: 'one-shot', SCHEDULED: 'scheduled' },
}));
jest.mock('@ever-works/agent/work-agent', () => ({
    SUPPORTED_AUTO_GENERATE_CADENCE_PATTERN: /^\*\/\d+\s+\*\s+\*\s+\*\s+\*$/,
    WorkBuildRequestSource: {},
    WorkBuildRequestStatus: {},
    WorkAgentRunLogLevel: {},
    WorkAgentRunStatus: {},
}));
jest.mock('@ever-works/agent/budgets', () => ({ BudgetService: class BudgetService {} }));

import { MissionsController } from './missions.controller';

/**
 * APW-08 T34 (FR-51, plan §5) — `POST` / `PATCH /api/me/missions` carry `outputMode` and
 * `taskOutput` to the service, which validates and normalizes them, and the service's
 * `warnings: ['noAppWorkRelation']` reaches the client unchanged (a Mission that files Tasks with
 * no App Work attached as Improves or Operates is accepted, and told so).
 */
const MISSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const session = { userId: 'u1', authMethod: 'session' } as never;

function build() {
    const service = {
        create: jest.fn(async () => ({
            id: MISSION,
            outputMode: 'tasks',
            warnings: ['noAppWorkRelation'],
        })),
        update: jest.fn(async () => ({ id: MISSION, outputMode: 'both' })),
    };
    const controller = new (MissionsController as unknown as new (
        ...args: unknown[]
    ) => MissionsController)(service, {}, {}, {});
    return { controller, service };
}

describe('MissionsController — output mode (APW-08 T34)', () => {
    it('create: passes outputMode and taskOutput, and returns the noAppWorkRelation warning', async () => {
        const { controller, service } = build();
        const answer = await controller.create(session, {
            description: 'Grow Bookings',
            type: 'one_shot',
            outputMode: 'tasks',
            taskOutput: { tasksPerTick: 2 },
        } as never);
        expect(service.create).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ outputMode: 'tasks', taskOutput: { tasksPerTick: 2 } }),
            undefined,
        );
        expect(answer).toMatchObject({ warnings: ['noAppWorkRelation'] });
    });

    it('update: passes both fields through, and leaves them out when omitted', async () => {
        const { controller, service } = build();
        await controller.update(session, MISSION, {
            outputMode: 'both',
            taskOutput: null,
        } as never);
        await controller.update(session, MISSION, { title: 'Renamed' } as never);
        expect(service.update.mock.calls[0][2]).toMatchObject({
            outputMode: 'both',
            taskOutput: null,
        });
        expect(service.update.mock.calls[1][2].outputMode).toBeUndefined();
        expect(service.update.mock.calls[1][2].taskOutput).toBeUndefined();
    });
});
