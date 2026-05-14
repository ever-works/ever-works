// The transitive dependencies of `WorkModule` pull in heavy runtime trees
// (TypeORM entities, BullMQ, plugin services that import ESM-only `p-map`).
// We replace each module with an empty class shell at module-scope so the
// `Reflect.getMetadata` calls return the real `WorkModule`'s metadata
// without forcing those trees to load under Jest's CJS transformer.
jest.mock('@src/database/database.module', () => ({
    DatabaseModule: class DatabaseModule {},
}));
jest.mock('../generators/data-generator/data-generator.module', () => ({
    DataGeneratorModule: class DataGeneratorModule {},
}));
jest.mock('../items-generator/items-generator.module', () => ({
    ItemsGeneratorModule: class ItemsGeneratorModule {},
}));
jest.mock('../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));
jest.mock('../generators/markdown-generator/markdown-generator.module', () => ({
    MarkdownGeneratorModule: class MarkdownGeneratorModule {},
}));
jest.mock('../generators/website-generator/website-generator.module', () => ({
    WebsiteGeneratorModule: class WebsiteGeneratorModule {},
}));
jest.mock('../import/import.module', () => ({
    ImportModule: class ImportModule {},
}));
jest.mock('../community-pr/community-pr.module', () => ({
    CommunityPrModule: class CommunityPrModule {},
}));
jest.mock('../comparison-generator/comparison-generator.module', () => ({
    ComparisonGeneratorModule: class ComparisonGeneratorModule {},
}));
jest.mock('../template-catalog/template-catalog.module', () => ({
    TemplateCatalogModule: class TemplateCatalogModule {},
}));
jest.mock('@src/subscriptions', () => ({
    SubscriptionsModule: class SubscriptionsModule {},
}));
jest.mock('@src/notifications', () => ({
    NotificationsModule: class NotificationsModule {},
}));

// Provider classes — replace with empty shells so the metadata still records
// the right class identities without dragging in the full implementations.
jest.mock('./work-detail.service', () => ({ WorkDetailService: class {} }));
jest.mock('./work-ownership.service', () => ({ WorkOwnershipService: class {} }));
jest.mock('./work-query.service', () => ({ WorkQueryService: class {} }));
jest.mock('./work-lifecycle.service', () => ({ WorkLifecycleService: class {} }));
jest.mock('./work-generation.service', () => ({ WorkGenerationService: class {} }));
jest.mock('./work-schedule.service', () => ({ WorkScheduleService: class {} }));
jest.mock('./work-schedule-dispatcher.service', () => ({
    WorkScheduleDispatcherService: class {},
}));
jest.mock('./work-member.service', () => ({ WorkMemberService: class {} }));
jest.mock('./work-invitation.service', () => ({ WorkInvitationService: class {} }));
jest.mock('./work-import.service', () => ({ WorkImportService: class {} }));
jest.mock('./work-advanced-prompts.service', () => ({
    WorkAdvancedPromptsService: class {},
}));
jest.mock('./work-taxonomy.service', () => ({ WorkTaxonomyService: class {} }));
jest.mock('./generator-form-schema.service', () => ({
    GeneratorFormSchemaService: class {},
}));
jest.mock('./work-website-repository-state.service', () => ({
    WorkWebsiteRepositoryStateService: class {},
}));
jest.mock('./item-health.service', () => ({ ItemHealthService: class {} }));
jest.mock('./item-source-validation-scheduler.service', () => ({
    ItemSourceValidationSchedulerService: class {},
}));
jest.mock('./repository-management.service', () => ({
    RepositoryManagementService: class {},
}));
jest.mock('@src/works-config/services/works-config-import-applier.service', () => ({
    WorksConfigImportApplierService: class {},
}));
jest.mock('@src/works-config/services/works-config-import-planner.service', () => ({
    WorksConfigImportPlannerService: class {},
}));
jest.mock('@src/works-config/services/works-config-projection.service', () => ({
    WorksConfigProjectionService: class {},
}));
jest.mock('@src/works-config/services/works-config-repository-sync.service', () => ({
    WorksConfigRepositorySyncService: class {},
}));
jest.mock('@src/works-config/services/works-config-restore.service', () => ({
    WorksConfigRestoreService: class {},
}));
jest.mock('@src/works-config/services/works-config.service', () => ({
    WorksConfigService: class {},
}));
jest.mock('@src/works-config/services/works-config-sync.listener', () => ({
    WorksConfigSyncListener: class {},
}));
jest.mock('@src/works-config/services/works-config-writer.service', () => ({
    WorksConfigWriterService: class {},
}));
jest.mock('../plugins/services/plugin-operations.service', () => ({
    PluginOperationsService: class {},
}));
jest.mock('../plugins/services/settings-schema-validator.service', () => ({
    SettingsSchemaValidatorService: class {},
}));
jest.mock('@src/ever-works-providers', () => ({
    EVER_WORKS_DEPLOY_QUOTA_COUNTER: Symbol('EVER_WORKS_DEPLOY_QUOTA_COUNTER'),
    EverWorksDeployQuotaService: class EverWorksDeployQuotaService {},
    EverWorksGitProvider: class EverWorksGitProvider {},
}));
jest.mock('@src/database/repositories/work.repository', () => ({
    WorkRepository: class WorkRepository {},
}));

import { WorkModule } from './work.module';
import {
    EVER_WORKS_DEPLOY_QUOTA_COUNTER,
    EverWorksDeployQuotaService,
    EverWorksGitProvider,
} from '@src/ever-works-providers';
import { WorkDetailService } from './work-detail.service';
import { WorkOwnershipService } from './work-ownership.service';
import { WorkQueryService } from './work-query.service';
import { WorkLifecycleService } from './work-lifecycle.service';
import { WorkGenerationService } from './work-generation.service';
import { WorkScheduleService } from './work-schedule.service';
import { WorkScheduleDispatcherService } from './work-schedule-dispatcher.service';
import { WorkMemberService } from './work-member.service';
import { WorkInvitationService } from './work-invitation.service';
import { WorkImportService } from './work-import.service';
import { WorkAdvancedPromptsService } from './work-advanced-prompts.service';
import { WorkTaxonomyService } from './work-taxonomy.service';
import { GeneratorFormSchemaService } from './generator-form-schema.service';
import { WorkWebsiteRepositoryStateService } from './work-website-repository-state.service';
import { ItemHealthService } from './item-health.service';
import { ItemSourceValidationSchedulerService } from './item-source-validation-scheduler.service';
import { RepositoryManagementService } from './repository-management.service';
import { WorksConfigImportApplierService } from '@src/works-config/services/works-config-import-applier.service';
import { WorksConfigImportPlannerService } from '@src/works-config/services/works-config-import-planner.service';
import { WorksConfigProjectionService } from '@src/works-config/services/works-config-projection.service';
import { WorksConfigRepositorySyncService } from '@src/works-config/services/works-config-repository-sync.service';
import { WorksConfigRestoreService } from '@src/works-config/services/works-config-restore.service';
import { WorksConfigService } from '@src/works-config/services/works-config.service';
import { WorksConfigSyncListener } from '@src/works-config/services/works-config-sync.listener';
import { WorksConfigWriterService } from '@src/works-config/services/works-config-writer.service';
import { PluginOperationsService } from '../plugins/services/plugin-operations.service';
import { SettingsSchemaValidatorService } from '../plugins/services/settings-schema-validator.service';
import { PlatformSyncSecretService } from './platform-sync-secret.service';
import { ZeroFrictionFunnelService } from './zero-friction-funnel.service';
import { CommunityPrModule } from '../community-pr/community-pr.module';
import { ComparisonGeneratorModule } from '../comparison-generator/comparison-generator.module';
import { TemplateCatalogModule } from '../template-catalog/template-catalog.module';

const meta = (key: string): unknown[] => Reflect.getMetadata(key, WorkModule) ?? [];

describe('WorkModule', () => {
    describe('imports', () => {
        it('imports the documented 12-module set (DatabaseModule + 6 generator/feature modules + Subscriptions/Notifications/CommunityPr/ComparisonGenerator/TemplateCatalog)', () => {
            const imports = meta('imports') as Array<{ name?: string }>;
            const names = imports.map((m) => m?.name).filter(Boolean) as string[];

            expect(names).toEqual(
                expect.arrayContaining([
                    'DatabaseModule',
                    'DataGeneratorModule',
                    'ItemsGeneratorModule',
                    'FacadesModule',
                    'MarkdownGeneratorModule',
                    'WebsiteGeneratorModule',
                    'ImportModule',
                    'SubscriptionsModule',
                    'NotificationsModule',
                    'CommunityPrModule',
                    'ComparisonGeneratorModule',
                    'TemplateCatalogModule',
                ]),
            );
            // Pin the count too — silent additions break this regression guard.
            expect(imports).toHaveLength(12);
        });

        it('does NOT import PluginsModule directly (it is registered globally via forRoot at the app root, per JSDoc)', () => {
            // Pinned: the JSDoc explicitly documents that `PluginsModule` is
            // global. A future `imports: [..., PluginsModule]` addition would
            // double-register and is wrong.
            const imports = meta('imports') as Array<{ name?: string }>;
            expect(imports.map((m) => m?.name)).not.toContain('PluginsModule');
        });
    });

    describe('providers', () => {
        const expectedProviders = [
            WorkOwnershipService,
            WorkWebsiteRepositoryStateService,
            WorkQueryService,
            WorkLifecycleService,
            WorkGenerationService,
            WorkDetailService,
            WorkScheduleService,
            WorkScheduleDispatcherService,
            WorkMemberService,
            WorkInvitationService,
            WorkImportService,
            WorkAdvancedPromptsService,
            WorkTaxonomyService,
            ItemHealthService,
            ItemSourceValidationSchedulerService,
            RepositoryManagementService,
            GeneratorFormSchemaService,
            WorksConfigImportPlannerService,
            WorksConfigImportApplierService,
            WorksConfigRestoreService,
            WorksConfigService,
            WorksConfigWriterService,
            WorksConfigProjectionService,
            WorksConfigRepositorySyncService,
            WorksConfigSyncListener,
            PluginOperationsService,
            SettingsSchemaValidatorService,
            EverWorksDeployQuotaService,
            PlatformSyncSecretService,
            EverWorksGitProvider,
            ZeroFrictionFunnelService,
        ];

        it.each(expectedProviders)('declares %p as a provider', (provider) => {
            expect(meta('providers')).toContain(provider);
        });

        it('keeps the providers list at the documented shape (class providers + the EverWorks quota counter factory)', () => {
            // 30 class providers + 1 factory provider object for the
            // EVER_WORKS_DEPLOY_QUOTA_COUNTER token = 31 entries total.
            // (EW-120 added PlatformSyncSecretService; EW-614 added EverWorksGitProvider.)
            expect(meta('providers')).toHaveLength(expectedProviders.length + 1);
        });

        it('declares the EVER_WORKS_DEPLOY_QUOTA_COUNTER factory provider so the quota service has a live counter', () => {
            const providers = meta('providers') as Array<{ provide?: symbol }>;
            const factory = providers.find(
                (p) =>
                    typeof p === 'object' &&
                    p !== null &&
                    'provide' in p &&
                    (p as { provide: unknown }).provide === EVER_WORKS_DEPLOY_QUOTA_COUNTER,
            );
            expect(factory).toBeDefined();
        });

        it('declares WorksConfigSyncListener as a provider (the @OnEvent listener pattern requires registration here so Nest scans its decorators)', () => {
            // Pin: even though the listener has no public service consumers,
            // it MUST appear in `providers` for the @OnEvent dispatcher to
            // discover it. A future "remove unused listener" cleanup would
            // break the works-config sync feature silently — flag it here.
            expect(meta('providers')).toContain(WorksConfigSyncListener);
        });
    });

    describe('exports', () => {
        it('exports every service that is also a provider EXCEPT the listener and the schema-validator (intentional internal-only)', () => {
            const exports = meta('exports');
            const providers = meta('providers');

            // Pinned: WorksConfigSyncListener is NOT exported (Nest doesn't
            // export listeners, they're internal) and SettingsSchemaValidatorService
            // is NOT exported (consumers go through PluginOperationsService).
            // PluginOperationsService IS a provider but NOT exported either —
            // current behaviour pinned (downstream services that need it would
            // import the plugins module directly).
            for (const provider of providers) {
                // Skip non-class providers (the EVER_WORKS_DEPLOY_QUOTA_COUNTER
                // factory is an object, not a class).
                if (typeof provider !== 'function') {
                    continue;
                }
                if (
                    provider === WorksConfigSyncListener ||
                    provider === SettingsSchemaValidatorService ||
                    provider === PluginOperationsService ||
                    provider === EverWorksDeployQuotaService ||
                    provider === EverWorksGitProvider
                ) {
                    // EW-614: EverWorksGitProvider is consumed inside the
                    // module (by WorkLifecycleService.createWork); not exported.
                    expect(exports).not.toContain(provider);
                } else {
                    expect(exports).toContain(provider);
                }
            }
        });

        it('re-exports CommunityPrModule, ComparisonGeneratorModule, TemplateCatalogModule (downstream feature consumers rely on transitive availability)', () => {
            const exports = meta('exports');
            expect(exports).toContain(CommunityPrModule);
            expect(exports).toContain(ComparisonGeneratorModule);
            expect(exports).toContain(TemplateCatalogModule);
        });

        it('keeps the exports list at the documented 29-entry shape (26 services + 3 re-exported modules)', () => {
            // Bumped to 28 with the PlatformSyncSecretService resurrection for
            // EW-120 dual-mode (pull/push/disabled) Activity Feed sync.
            // Bumped to 29 with the EW-617 G8 ZeroFrictionFunnelService.
            expect(meta('exports')).toHaveLength(29);
        });

        it('does NOT re-export DatabaseModule (callers must import it explicitly when they need entities/repositories)', () => {
            // Pin the boundary: DatabaseModule re-export would silently
            // give every WorkModule consumer access to the entire entity
            // tree. The current intent is that consumers explicitly import
            // it when needed.
            const exports = meta('exports') as Array<{ name?: string }>;
            expect(exports.map((m) => m?.name)).not.toContain('DatabaseModule');
        });
    });

    describe('class identity', () => {
        it('WorkModule is a class function (Nest discovers @Module via the class itself)', () => {
            expect(typeof WorkModule).toBe('function');
            expect(WorkModule.name).toBe('WorkModule');
        });
    });
});
