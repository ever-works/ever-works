import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ENTITIES } from '@src/database/database.config';
import { ActivityLogService } from '@src/activity-log/activity-log.service';
import { NotificationService } from '@src/notifications/notification.service';
import { PluginRegistryService } from '@src/plugins/services/plugin-registry.service';
import { PluginSettingsService } from '@src/plugins/services/plugin-settings.service';
import { PluginUsageService } from '@src/usage/plugin-usage.service';
import { BudgetGuardService } from '@src/budgets/budget-guard.service';
import { WorkPluginRepository } from '@src/plugins/repositories/work-plugin.repository';
import { WorkCustomDomainRepository } from '@src/database/repositories/work-custom-domain.repository';
import { EverWorksK8sDeployProvider } from '@src/ever-works-providers/ever-works-k8s-deploy.provider';
import { SharedViewsModule } from '../shared-views.module';
import { SharedViewProjectionService } from '../shared-view-projection.service';
import { SharedViewRepository } from '../shared-view.repository';
import { SharedViewService } from '../shared-view.service';

/**
 * The Shared view module against a REAL Nest container and a real in-memory
 * sqlite connection, so a missing import, an unregistered entity or an
 * optional collaborator that silently resolves to nothing fails here instead
 * of at API boot. The service specs construct their subjects positionally and
 * cannot see any of that.
 *
 * `TasksDomainModule` (which the projection reads the board through) reaches
 * a handful of providers the API supplies from its root; those — and only
 * those — are stubbed through a `@Global()` module, the same shape the real
 * application uses.
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

describe('SharedViewsModule — dependency injection', () => {
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
                SharedViewsModule,
            ],
        }).compile();
    }

    it('resolves the service, the projection and the repository from the real module', async () => {
        const moduleRef = await compile();

        expect(moduleRef.get(SharedViewService)).toBeInstanceOf(SharedViewService);
        expect(moduleRef.get(SharedViewProjectionService)).toBeInstanceOf(
            SharedViewProjectionService,
        );
        expect(moduleRef.get(SharedViewRepository)).toBeInstanceOf(SharedViewRepository);

        await moduleRef.close();
    });

    it('wires the optional activity log and notifications for real', async () => {
        // Both are @Optional() on the service: without their modules in
        // `imports` the service would compile and then silently write no
        // activity row and ring no first-view notice.
        const moduleRef = await compile();
        const service = moduleRef.get(SharedViewService) as unknown as {
            activityLog?: unknown;
            notifications?: unknown;
        };
        expect(service.activityLog).toBe(moduleRef.get(ActivityLogService, { strict: false }));
        expect(service.notifications).toBe(moduleRef.get(NotificationService, { strict: false }));

        await moduleRef.close();
    });

    it('registers the entity with the DataSource, so the first query does not throw', async () => {
        const moduleRef = await compile();

        const views = moduleRef.get(SharedViewRepository);
        await expect(
            views.findByOrganization('00000000-0000-4000-8000-000000000001'),
        ).resolves.toBeNull();
        await expect(views.findByTokenHash('a'.repeat(64))).resolves.toBeNull();

        await moduleRef.close();
    });
});
