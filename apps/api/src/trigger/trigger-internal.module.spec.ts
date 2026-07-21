jest.mock('@ever-works/agent/work-operations', () => ({
    WorkOperationsModule: class WorkOperationsModule {},
}));
jest.mock('@ever-works/agent/services', () => ({
    WorkModule: class WorkModule {},
    KnowledgeBaseModule: class KnowledgeBaseModule {},
}));
jest.mock('@ever-works/agent/notifications', () => ({
    NotificationsModule: class NotificationsModule {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    FacadesModule: class FacadesModule {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class ActivityLogService {},
    ActivityLogModule: class ActivityLogModule {},
}));
jest.mock('@ever-works/agent/generators', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
    MarkdownGeneratorModule: class MarkdownGeneratorModule {},
}));
jest.mock('@ever-works/agent/database', () => ({
    DatabaseModule: class DatabaseModule {},
    WorkRepository: class WorkRepository {},
    WorkKnowledgeDocumentRepository: class WorkKnowledgeDocumentRepository {},
}));
jest.mock('@ever-works/monitoring', () => ({
    AnalyticsService: class AnalyticsService {},
}));
jest.mock('../work-proposals/work-proposals.module', () => ({
    WorkProposalsModule: class WorkProposalsModule {},
}));
jest.mock('../data-sync/data-sync.module', () => ({
    DataSyncModule: class DataSyncModule {},
}));
jest.mock('@ever-works/agent/missions', () => ({
    MissionsModule: class MissionsModule {},
}));
// PR-8 — trigger-internal.module imports GoalsModule, and the controller it
// declares imports GoalEvaluationService, from the goals barrel. That barrel
// reaches facades/metrics.facade -> usage/plugin-usage.service, which imports
// `@src/database/repositories/plugin-usage.repository`. `@src/*` is an alias in
// BOTH packages; apps/api's jest maps it to apps/api/src, where that module
// does not exist, so the suite failed to run outright. Stub the barrel — both
// symbols, since this spec loads the module and the module loads the controller.
jest.mock('@ever-works/agent/goals', () => ({
    GoalsModule: class GoalsModule {},
    GoalEvaluationService: class GoalEvaluationService {},
}));
// Same class of breakage, different chain: work-agent.module -> database.module
// -> database.config, which imports `@src/config`. The controller spec already
// stubs this barrel (for IdeaBuildExecutorService); the module spec needs
// WorkAgentModule from it.
jest.mock('@ever-works/agent/work-agent', () => ({
    WorkAgentModule: class WorkAgentModule {},
}));
// FU-2 post-CI fix: trigger-internal.module imports AgentsModule +
// TasksDomainModule (added by PR #1019). Stub them to avoid pulling
// the entity transitive imports under jest.
jest.mock('@ever-works/agent/agents', () => ({
    AgentsModule: class AgentsModule {},
}));
jest.mock('@ever-works/agent/tasks-domain', () => ({
    TasksDomainModule: class TasksDomainModule {},
}));
// EW-742 P3.2 T22 — trigger-internal.module imports TenantJobRuntimeModule
// + OrganizationsModule (added by bbc24309 / 5e4e2483 / 41906b71). Loading
// those modules pulls in real `@ever-works/agent/entities` + `@ever-works/agent/tasks`
// barrels which transitively type-check the agent `utils/metrics.util.ts`
// under the api tsconfig and report TS2365 errors there. Stub the modules
// here so the trigger-internal-module wiring contract can be asserted in
// isolation without the deep agent type-check chain.
jest.mock('../account/tenant-job-runtime/tenant-job-runtime.module', () => ({
    TenantJobRuntimeModule: class TenantJobRuntimeModule {},
}));
jest.mock('../organizations/organizations.module', () => ({
    OrganizationsModule: class OrganizationsModule {},
}));
jest.mock('./trigger-internal.controller', () => ({
    TriggerInternalController: class TriggerInternalController {},
}));

import { FacadesModule } from '@ever-works/agent/facades';
import { NotificationsModule } from '@ever-works/agent/notifications';
import { KnowledgeBaseModule, WorkModule } from '@ever-works/agent/services';
import { WorkOperationsModule } from '@ever-works/agent/work-operations';
import { MissionsModule } from '@ever-works/agent/missions';
import { WorkProposalsModule } from '../work-proposals/work-proposals.module';
import { TriggerInternalController } from './trigger-internal.controller';
import { TriggerInternalModule } from './trigger-internal.module';

describe('TriggerInternalModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, TriggerInternalModule) ?? [];

    it('imports the modules required by remote targets exposed by TriggerInternalController', () => {
        expect(meta('imports')).toEqual(
            expect.arrayContaining([
                WorkOperationsModule,
                WorkModule,
                NotificationsModule,
                FacadesModule,
                WorkProposalsModule,
                KnowledgeBaseModule,
                MissionsModule,
            ]),
        );
    });

    it('declares the internal trigger controller', () => {
        expect(meta('controllers')).toContain(TriggerInternalController);
    });
});
