import { CacheModule } from '@nestjs/cache-manager';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ENTITIES } from '../../database/_entities-inventory';
import { TaskRepository } from '../../database/repositories/task.repository';
import { PluginsModule } from '../../plugins/plugins.module';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { NotificationService } from '../../notifications/notification.service';
import { TaskChatService } from '../../tasks-domain/task-chat.service';
import { TasksService } from '../../tasks-domain/tasks.service';
import { AppActionsHygieneService } from '../app-actions-hygiene.service';
import { AppSourceInitializerService } from '../app-source-initializer.service';
import { AppUpstreamStateService } from '../app-upstream-state.service';
import { AppWorksModule } from '../app-works.module';

/**
 * APW-02 §6.5 / §3.5 — the agent `AppWorksModule`'s services reach the Task,
 * notification and Activity services they inject, in a REAL graph.
 *
 * ## The defect this pins
 *
 * `AppUpstreamStateService` files the conflict Task (`TasksService`), comments on an
 * open one (`TaskChatService`, after a `TaskRepository` lookup), tells the owner when
 * no Agent resolved (`NotificationService`) and writes the epic's eight dotted
 * Activity events (`ActivityLogService`); `AppActionsHygieneService` and this
 * module's copy of `AppSourceInitializerService` write Activity too. Every one of
 * those is `@Optional()`.
 *
 * Nest resolves a provider's dependencies in the module that DECLARES it — this
 * one. It imported only `DatabaseModule` and `FacadesModule`, neither of which
 * exports any of the five (`FacadesModule` reaches `ActivityLogModule` through
 * `ModelRoutingModule`, which does not re-export it). The API's own App Works
 * module imports `NotificationsModule`, `TasksDomainModule` and `ActivityLogModule`
 * "for the state service", but a provider declared in the agent module cannot see
 * what the API module imports. So in the running API every conflict was recorded
 * without a Task, no owner was notified, and no `app.upstream.*` / `app.actions.*`
 * Activity row was ever written. `apps/api/src/app-works-di-reachability.spec.ts`
 * found it.
 *
 * Stood in: only the API root's infrastructure — the DataSource (in-memory sqlite
 * over `ENTITIES`), the global event emitter, the global cache and the global
 * `PluginsModule.forRoot()` (registered, never bootstrapped). Nothing is mocked.
 */

type WithActivity = { activity?: unknown };
type UpstreamCollaborators = WithActivity & {
    taskRepository?: unknown;
    tasks?: unknown;
    taskChat?: unknown;
    notifications?: unknown;
};

describe('AppWorksModule (agent) — the collaborators its services inject, composed for real', () => {
    let moduleRef: TestingModule;

    beforeAll(async () => {
        moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                    logging: false,
                }),
                EventEmitterModule.forRoot(),
                CacheModule.register({ isGlobal: true }),
                PluginsModule.forRoot(),
                AppWorksModule,
            ],
        }).compile();
    });

    afterAll(async () => {
        await moduleRef?.close();
    });

    function upstream(): UpstreamCollaborators {
        return moduleRef.get(AppUpstreamStateService, {
            strict: false,
        }) as unknown as UpstreamCollaborators;
    }

    it('hands the upstream state service the three Task collaborators of §6.5', () => {
        expect(upstream().taskRepository).toBeInstanceOf(TaskRepository);
        expect(upstream().tasks).toBeInstanceOf(TasksService);
        expect(upstream().taskChat).toBeInstanceOf(TaskChatService);
    });

    it('is the SAME Task service the rest of the graph uses, not a second instance', () => {
        expect(upstream().tasks).toBe(moduleRef.get(TasksService, { strict: false }));
        expect(upstream().taskChat).toBe(moduleRef.get(TaskChatService, { strict: false }));
    });

    it('hands it the notification service (the owner notice when no Agent resolved)', () => {
        expect(upstream().notifications).toBeInstanceOf(NotificationService);
    });

    it('hands every Activity writer this module declares the Activity service', () => {
        const activity = moduleRef.get(ActivityLogService, { strict: false });

        expect(upstream().activity).toBe(activity);
        expect(
            (moduleRef.get(AppActionsHygieneService, { strict: false }) as unknown as WithActivity)
                .activity,
        ).toBe(activity);
        expect(
            (
                moduleRef.get(AppSourceInitializerService, {
                    strict: false,
                }) as unknown as WithActivity
            ).activity,
        ).toBe(activity);
    });
});
