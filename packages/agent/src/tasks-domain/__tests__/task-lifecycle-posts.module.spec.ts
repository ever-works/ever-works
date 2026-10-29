import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ENTITIES } from '@src/database/database.config';
import { PluginRegistryService } from '@src/plugins/services/plugin-registry.service';
import { PluginSettingsService } from '@src/plugins/services/plugin-settings.service';
import { PluginUsageService } from '@src/usage/plugin-usage.service';
import { BudgetGuardService } from '@src/budgets/budget-guard.service';
import { WorkPluginRepository } from '@src/plugins/repositories/work-plugin.repository';
import { WorkCustomDomainRepository } from '@src/database/repositories/work-custom-domain.repository';
import { EverWorksK8sDeployProvider } from '@src/ever-works-providers/ever-works-k8s-deploy.provider';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { AgentRunRepository } from '@src/database/repositories/agent-run.repository';
import { TasksDomainModule } from '../tasks.module';
import { TaskChatService } from '../task-chat.service';
import { TaskRunDenormService } from '../task-run-denorm.service';
import { TaskPrStatusService } from '../task-pr-status.service';
import { TaskWorkspaceService } from '../task-workspace.service';
import { TaskLifecyclePostsService } from '../task-lifecycle-posts.service';
import { TASK_LIFECYCLE_POSTER } from '../task-lifecycle-poster.port';

/**
 * APW-08 lane L7 (FR-43) — the REAL `TasksDomainModule`, compiled in a REAL Nest container, hands
 * the run-side poster to all three hooks. Every one of them injects it `@Optional()`, so a graph
 * that stopped binding `TASK_LIFECYCLE_POSTER` would compile cleanly and post nothing, with every
 * unit spec still green (they construct the services positionally). So this asserts each
 * injection RESOLVED, to the one instance the module provides — not merely that it compiled.
 * (`apps/api/src/agents/agents.module.spec.ts` mocks `@ever-works/agent/tasks-domain` away and
 * cannot see this.) Same app-root stubs as `task-agent-review.module.spec.ts`.
 */
const APP_ROOT_PROVIDERS = [
    PluginRegistryService,
    PluginSettingsService,
    PluginUsageService,
    BudgetGuardService,
    WorkPluginRepository,
    WorkCustomDomainRepository,
    EverWorksK8sDeployProvider,
];

@Global()
@Module({
    providers: APP_ROOT_PROVIDERS.map((token) => ({ provide: token, useValue: {} })),
    exports: APP_ROOT_PROVIDERS,
})
class AppRootStubModule {}

describe('TasksDomainModule — the FR-43 run-side poster is wired', () => {
    async function compile() {
        return Test.createTestingModule({
            imports: [
                AppRootStubModule,
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                }),
                TasksDomainModule,
            ],
        }).compile();
    }

    it('binds TASK_LIFECYCLE_POSTER to the poster, which reaches the chat service and its repositories', async () => {
        const moduleRef = await compile();
        const poster = moduleRef.get(TASK_LIFECYCLE_POSTER);
        expect(poster).toBeInstanceOf(TaskLifecyclePostsService);
        expect(poster).toBe(moduleRef.get(TaskLifecyclePostsService));
        const internals = poster as unknown as Record<string, unknown>;
        expect(internals.chat).toBe(moduleRef.get(TaskChatService));
        expect({ works: internals.works instanceof WorkRepository }).toEqual({ works: true });
        expect({ runs: internals.runs instanceof AgentRunRepository }).toEqual({ runs: true });
        await moduleRef.close();
    });

    it('hands that one poster to the run start, the pull request open and the checks read', async () => {
        const moduleRef = await compile();
        const poster = moduleRef.get(TASK_LIFECYCLE_POSTER);
        const hooks: Array<[string, unknown]> = [
            ['TaskRunDenormService', moduleRef.get(TaskRunDenormService)],
            ['TaskWorkspaceService', moduleRef.get(TaskWorkspaceService)],
            ['TaskPrStatusService', moduleRef.get(TaskPrStatusService)],
        ];
        for (const [name, service] of hooks) {
            const lifecycle = (service as Record<string, unknown>).lifecycle;
            expect({ name, wired: lifecycle === poster }).toEqual({ name, wired: true });
        }
        await moduleRef.close();
    });
});
