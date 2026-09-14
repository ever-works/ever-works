// `MissionsModule` reaches the markdown generator, whose ESM-only slug
// library Jest's CJS transformer cannot parse. Nothing under test slugs
// anything, so it is stubbed the way the other specs on that path do.
jest.mock('github-slugger', () => ({
    __esModule: true,
    default: class {
        slug(input: string): string {
            return input;
        }
    },
}));

import { Global, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '@nestjs/cache-manager';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ENTITIES } from '@src/database/database.config';
import { PluginRegistryService } from '@src/plugins/services/plugin-registry.service';
import { PluginSettingsService } from '@src/plugins/services/plugin-settings.service';
import { PluginContextFactoryService } from '@src/plugins/services/plugin-context-factory.service';
import { PluginUsageService } from '@src/usage/plugin-usage.service';
import { BudgetGuardService } from '@src/budgets/budget-guard.service';
import { WorkPluginRepository } from '@src/plugins/repositories/work-plugin.repository';
import { WorkCustomDomainRepository } from '@src/database/repositories/work-custom-domain.repository';
import { EverWorksK8sDeployProvider } from '@src/ever-works-providers/ever-works-k8s-deploy.provider';
import { TasksService } from '@src/tasks-domain/tasks.service';
import { AgentsService } from '@src/agents/agents.service';
import { AgentScheduleDispatcherService } from '@src/agents/agent-schedule-dispatcher.service';
import { MissionsService } from '@src/missions/missions.service';
import { InboundTriggersService } from '@src/triggers/inbound-triggers.service';
import { ActivityLogService } from '@src/activity-log/activity-log.service';
import { TasksDomainModule } from '@src/tasks-domain/tasks.module';
import { AgentsModule } from '@src/agents/agents.module';
import { MissionsModule } from '@src/missions/missions.module';
import { InboundTriggersModule } from '@src/triggers/inbound-triggers.module';
import { ActivityLogModule } from '@src/activity-log/activity-log.module';
import { ScheduleControlsModule } from '../schedule-controls.module';
import { ScheduleControlService } from '../schedule-control.service';
import { ScheduleHealthService } from '../schedule-health.service';
import { SchedulesModule } from '../schedules.module';
import { SchedulesService } from '../schedules.service';

/**
 * The Schedules workspace controls, against a REAL Nest container compiling
 * the REAL `ScheduleControlsModule` and `SchedulesModule`.
 *
 * Why this exists: every collaborator of `ScheduleControlService` is
 * injected `@Optional()`, so that a reduced graph answers 503 for the one
 * control it cannot perform instead of refusing to boot. The price of that
 * posture is that a wiring break is SILENT — drop `MissionsModule` from the
 * imports, or stop `AgentsModule` exporting `AgentsService`, and the API
 * still boots, every unit spec (which constructs the service positionally)
 * still passes, and pause / resume / run-now quietly start answering 503 in
 * production. A compile-only assertion would not notice either, because an
 * optional dependency that fails to resolve is just `undefined`.
 *
 * So the assertions below check that each collaborator actually LANDED on
 * the service, and that it is the very instance the owning module exports.
 *
 * The module graph reaches a handful of providers that the API supplies
 * from its ROOT rather than from any of these modules; those — and only
 * those — are stubbed through a `@Global()` module, the same shape
 * `tasks-domain/__tests__/release-promotion.module.spec.ts` uses. Nothing
 * the controls depend on is stubbed.
 */

const APP_ROOT_PROVIDERS = [
    PluginRegistryService,
    PluginSettingsService,
    PluginContextFactoryService,
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

type ControlServiceInternals = {
    schedules?: unknown;
    tasks?: unknown;
    agents?: unknown;
    heartbeatDispatcher?: unknown;
    missions?: unknown;
    inboundTriggers?: unknown;
    activityLog?: unknown;
};

describe('ScheduleControlsModule — dependency injection', () => {
    let moduleRef: TestingModule;

    beforeAll(async () => {
        moduleRef = await Test.createTestingModule({
            imports: [
                AppRootStubModule,
                // Both registered at the API root (`api.module.ts`); the
                // real, in-process implementations — nothing is stubbed.
                EventEmitterModule.forRoot(),
                CacheModule.register({ isGlobal: true }),
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                }),
                ScheduleControlsModule,
            ],
        }).compile();
    }, 120_000);

    afterAll(async () => {
        await moduleRef?.close();
    });

    it('compiles the REAL module and resolves both exported services', () => {
        expect(moduleRef.get(ScheduleControlService)).toBeInstanceOf(ScheduleControlService);
        expect(moduleRef.get(ScheduleHealthService)).toBeInstanceOf(ScheduleHealthService);
    });

    it('hands the control service the read projection it resolves ids against', () => {
        const service = moduleRef.get(ScheduleControlService) as unknown as ControlServiceInternals;
        const projection = moduleRef.get(SchedulesService, { strict: false });
        expect(projection).toBeInstanceOf(SchedulesService);
        expect(service.schedules).toBe(projection);
    });

    it.each([
        ['tasks', TasksService],
        ['agents', AgentsService],
        ['heartbeatDispatcher', AgentScheduleDispatcherService],
        ['missions', MissionsService],
        ['inboundTriggers', InboundTriggersService],
        ['activityLog', ActivityLogService],
    ] as const)(
        'resolves the @Optional() %s collaborator from the real graph — unresolved, its controls answer 503',
        (field, token) => {
            const service = moduleRef.get(
                ScheduleControlService,
            ) as unknown as ControlServiceInternals;
            const provided = moduleRef.get(token as never, { strict: false });
            expect(provided).toBeDefined();
            expect(service[field]).toBeDefined();
            expect(service[field]).toBe(provided);
        },
    );

    it('gives the projection its @Optional() assignee repository, so recurring Tasks name their Agent', () => {
        const projection = moduleRef.get(SchedulesService, { strict: false }) as unknown as {
            taskAssigneeRepo?: unknown;
        };
        expect(projection.taskAssigneeRepo).toBeDefined();
    });

    it('reads the projection end to end on the real DataSource — every entity is registered', async () => {
        // A forFeature'd-but-unregistered entity throws on the FIRST query,
        // not at compile, and a source that throws is silently reported as
        // degraded — so ask, and require that nothing degraded.
        const projection = moduleRef.get(SchedulesService, { strict: false });
        const scope = { userId: 'user-1', organizationId: null };

        await expect(projection.getSchedules(scope)).resolves.toEqual([]);
        const page = await projection.getPage(scope);
        expect(page.items).toEqual([]);
        expect(page.degradedSources).toEqual([]);
    });
});

describe('ScheduleControlsModule — module shape', () => {
    const imports = () => Reflect.getMetadata('imports', ScheduleControlsModule) ?? [];
    const exports_ = () => Reflect.getMetadata('exports', ScheduleControlsModule) ?? [];

    it('imports every module that owns a write the controls delegate to', () => {
        expect(imports()).toEqual(
            expect.arrayContaining([
                SchedulesModule,
                TasksDomainModule,
                AgentsModule,
                MissionsModule,
                InboundTriggersModule,
                ActivityLogModule,
            ]),
        );
    });

    it('exports the control and health services for the API module', () => {
        expect(exports_()).toEqual(
            expect.arrayContaining([ScheduleControlService, ScheduleHealthService]),
        );
    });

    it('keeps the read-only SchedulesModule free of the domain graphs', () => {
        // Home and the Activity tab import only the projection; pulling the
        // Task / Agent / Mission / Trigger graphs into it would drag them in.
        const readImports = Reflect.getMetadata('imports', SchedulesModule) ?? [];
        for (const heavy of [
            TasksDomainModule,
            AgentsModule,
            MissionsModule,
            InboundTriggersModule,
            ScheduleControlsModule,
        ]) {
            expect(readImports).not.toContain(heavy);
        }
    });
});
