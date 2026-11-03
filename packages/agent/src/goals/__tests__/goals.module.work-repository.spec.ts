import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Work } from '../../entities/work.entity';
import { GoalsModule } from '../goals.module';

/**
 * APW-08 T31/T32 (review of #3058) — `GoalsService` and `GoalOrchestratorService` inject the Work
 * repository `@Optional()`. Unless `GoalsModule` registers `Work` in its own `forFeature`, that
 * token is not visible in the module (the agent `DatabaseModule` is not global) and resolves to
 * `undefined` WITHOUT an error: every Goal `workId` would be refused and the loop would never
 * check its Work. This pins the registration.
 */
describe('GoalsModule — the Work repository is registered (APW-08 T31/T32)', () => {
    it('provides the Work repository token through its TypeORM forFeature', () => {
        const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, GoalsModule) ?? []) as Array<{
            providers?: Array<{ provide?: unknown }>;
        }>;
        const tokens = imports.flatMap((entry) =>
            Array.isArray(entry?.providers) ? entry.providers.map((p) => p?.provide) : [],
        );
        expect(tokens).toContain(getRepositoryToken(Work));
    });
});
