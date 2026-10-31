import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { getRepositoryToken } from '@nestjs/typeorm';

// The sibling modules pull the whole agent graph (better-auth's ESM through subscriptions); this
// spec reads only MissionsModule's own metadata, so they stand in as empty classes.
jest.mock('../../work-agent/work-agent.module', () => ({
    WorkAgentModule: class WorkAgentModule {},
}));
jest.mock('../../user-research/user-research.module', () => ({
    UserResearchModule: class UserResearchModule {},
}));
jest.mock('../../facades/facades.module', () => ({ FacadesModule: class FacadesModule {} }));

import { Task } from '../../entities/task.entity';
import { MissionTaskPlannerService } from '../mission-task-planner.service';
import { MissionsModule } from '../missions.module';

/**
 * APW-08 T35 — the Mission tick's Task branch injects the Task repository and the planner
 * `@Optional()`. Unless `MissionsModule` registers `Task` in its own `forFeature` and provides the
 * planner, both silently resolve to undefined and a `tasks` Mission files nothing (the same trap
 * the review of #3058 found in `GoalsModule`). This pins the wiring.
 */
describe('MissionsModule — the Task branch is wired (APW-08 T35)', () => {
    it('registers the Task repository through its TypeORM forFeature', () => {
        const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, MissionsModule) ??
            []) as Array<{
            providers?: Array<{ provide?: unknown }>;
        }>;
        const tokens = imports.flatMap((entry) =>
            Array.isArray(entry?.providers) ? entry.providers.map((p) => p?.provide) : [],
        );
        expect(tokens).toContain(getRepositoryToken(Task));
    });

    it('provides the planner', () => {
        const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, MissionsModule) ??
            []) as unknown[];
        expect(providers).toContain(MissionTaskPlannerService);
    });
});
