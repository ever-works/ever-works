// The auth runtime is ESM-only and irrelevant to what this file proves: that
// the catalogue module's OWN graph resolves. The guard is a no-op stand-in,
// and AuthModule an empty module, exactly as `computer.module.spec.ts` does.
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));
// The services barrel drags ESM-only generator code through Jest's CJS
// transformer; the module needs exactly these two REAL agent modules from it.
jest.mock('@ever-works/agent/services', () => ({
    ...jest.requireActual('../../../../packages/agent/src/services/playbook-readiness.service'),
    ...jest.requireActual('../../../../packages/agent/src/services/playbook-adoption-plan'),
}));
jest.mock('../auth/auth.module', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Module } = require('@nestjs/common');
    class AuthModule {}
    Module({})(AuthModule);
    return { AuthModule };
});

import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentRepository, ENTITIES, WorkCustomDomainRepository } from '@ever-works/agent/database';
import {
    PluginRegistryService,
    PluginSettingsService,
    WorkPluginRepository,
} from '@ever-works/agent/plugins';
import { PluginUsageService } from '@ever-works/agent/usage';
import { BudgetGuardService } from '@ever-works/agent/budgets';
import { EverWorksK8sDeployProvider } from '@ever-works/agent/ever-works-providers';
import { PlaybookCatalogFacadeService } from '@ever-works/agent/facades';
import { PlaybookReadinessService } from '@ever-works/agent/services';
import { CatalogModule } from './catalog.module';
import { CatalogController } from './catalog.controller';
import { PlaybookCatalogService } from './playbook-catalog.service';

/**
 * `CatalogModule` against a REAL Nest container.
 *
 * The controller spec constructs everything positionally, so it cannot see a
 * module that forgets an import — the API would then refuse to boot while
 * every unit spec stays green. Here the graph has to resolve: the facade from
 * `FacadesModule`, the Agent repository readiness uses for name collisions
 * from the agent-side `AgentsModule`, and the catalogue service wired to both.
 *
 * The `@Global()` stub stands in for the providers the running API supplies
 * from its ROOT module (the plugin registry among them), which the facades'
 * graph reaches transitively.
 */
const APP_ROOT_PROVIDERS = [
    PluginRegistryService,
    PluginSettingsService,
    WorkPluginRepository,
    PluginUsageService,
    BudgetGuardService,
    WorkCustomDomainRepository,
    EverWorksK8sDeployProvider,
];

@Global()
@Module({
    providers: APP_ROOT_PROVIDERS.map((token) => ({ provide: token, useValue: {} })),
    exports: APP_ROOT_PROVIDERS,
})
class AppRootStubModule {}

describe('CatalogModule — dependency injection', () => {
    it('resolves the controller, the catalogue service, the facade and readiness', async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                AppRootStubModule,
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                }),
                CatalogModule,
            ],
        }).compile();

        expect(moduleRef.get(CatalogController)).toBeInstanceOf(CatalogController);
        expect(moduleRef.get(PlaybookCatalogService)).toBeInstanceOf(PlaybookCatalogService);
        expect(moduleRef.get(PlaybookReadinessService)).toBeInstanceOf(PlaybookReadinessService);
        expect(moduleRef.get(PlaybookCatalogFacadeService, { strict: false })).toBeInstanceOf(
            PlaybookCatalogFacadeService,
        );
        // Readiness can only suggest a free Agent name when the repository is bound.
        const readiness = moduleRef.get(PlaybookReadinessService) as unknown as {
            agents?: unknown;
        };
        expect(readiness.agents).toBeInstanceOf(AgentRepository);

        await moduleRef.close();
    });
});
