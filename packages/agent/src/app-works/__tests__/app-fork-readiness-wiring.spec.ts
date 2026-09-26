// The two sibling modules `AppWorksModule` imports pull in the whole TypeORM +
// facade + plugin-registry tree, exactly as `app-works.module.spec.ts` records for
// its own two. Shelling them keeps THIS spec a test of the module's own wiring: the
// metadata assertions see the real module's imports, and the compiles below exercise
// only what it provides or mints itself. Every collaborator the epic's services read
// from those modules is `@Optional()` (or, for `AppActionsHygieneService`, supplied
// here), so a shelled module is a supported graph rather than a broken one.
jest.mock('../../database/database.module', () => ({
    DatabaseModule: class DatabaseModule {},
}));
jest.mock('../../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));
// 2026-09-26 — `AppWorksModule` also imports the Activity, notification and Task
// modules its services inject (see its "bound by IMPORT" section). They are shelled
// for the reason the two above are: this is a bare-graph test of THIS module's own
// wiring, and every one of those collaborators is `@Optional()`.
// `app-works.module.graph.spec.ts` composes all of them for real.
jest.mock('../../activity-log/activity-log.module', () => ({
    ActivityLogModule: class ActivityLogModule {},
}));
jest.mock('../../notifications/notifications.module', () => ({
    NotificationsModule: class NotificationsModule {},
}));
jest.mock('../../tasks-domain/tasks.module', () => ({
    TasksDomainModule: class TasksDomainModule {},
}));

import { Global, Module, type ModuleMetadata } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DistributedTaskLockService } from '../../cache/distributed-task-lock.service';
import { WorkUpstreamStateRepository } from '../../database/repositories/work-upstream-state.repository';
import { WorkUpstreamState } from '../../entities/work-upstream-state.entity';
import {
    JOB_RUNTIME_PROVIDER_REGISTRY,
    type JobRuntimeProviderRegistry,
} from '../../tasks/job-runtime.providers';
import { AppActionsHygieneService } from '../app-actions-hygiene.service';
import {
    APP_FORK_READINESS_DISPATCHER,
    AppUpstreamStateService,
    type AppForkReadinessJobPayload,
} from '../app-upstream-state.service';
import { AppWorkCreateService } from '../app-work-create.service';
import { APP_FORK_READINESS_JOB_ID } from '../app-fork-readiness.runner';
import { AppWorksModule, buildAppForkReadinessDispatcherProvider } from '../app-works.module';

/**
 * C10 — `APP_FORK_READINESS_DISPATCHER` is bound, in a real container, and the two
 * call sites that inject it can see it.
 *
 * ## What C10 measured, and what this spec pins instead
 *
 * `docs/internal/app-works-build-progress.md` §5.2 row C10: the token had **no
 * `provide:` anywhere**, so `AppWorkCreateService.dispatchReadiness` and
 * `AppUpstreamStateService.retryReadiness` both found `undefined`, logged "no
 * readiness dispatcher is bound" and left the row at `dispatch_unavailable` — an
 * App Work that can never become `ready`, in **any** environment. Three claims
 * therefore have to be true together, and each has its own case below:
 *
 *   1. the module BINDS the token (metadata: a `useFactory` provider, never
 *      `useExisting`, and never a placeholder), with the job-runtime registry
 *      injected **optionally** so a process without a runtime still compiles;
 *   2. a dispatch goes THROUGH to the active runtime's
 *      `dispatchAppForkReadiness` — the method `TriggerService` implements and
 *      `TriggerService`'s own dispatchers view publishes — and answers `null`
 *      (never an invented run id) when there is nothing to dispatch through;
 *   3. the two injecting services receive it, read through the container rather
 *      than through the class, which is the half a hand-built unit test cannot see
 *      and the half the defect lived in.
 *
 * The registry is supplied to the container by a `@Global()` module below, which is
 * how the real graph supplies it too (`TriggerModule` is `@Global()` and every
 * `*_DISPATCHER` binding resolves through it). A provider declared at the test root
 * would NOT be visible to `AppWorksModule`'s own providers — that visibility rule is
 * the reason C10's binding could not live in the API-side module, and this spec
 * exercises it rather than describing it.
 */

/** A uuid that exists in no database. */
const WORK_ID = '00000000-0000-4000-8000-0000000000fd';

/** The one method the binding looks for on the active runtime's dispatchers view. */
const DISPATCH_METHOD = 'dispatchAppForkReadiness';

const PAYLOAD: AppForkReadinessJobPayload = {
    workId: WORK_ID,
    attempt: 1,
    reason: 'initial',
    providerId: 'github',
};

/** A registry holding one provider whose dispatchers view is `dispatchers`. */
function registryWith(dispatchers: unknown): JobRuntimeProviderRegistry {
    return {
        register: jest.fn(),
        getActive: () => ({ dispatchers }) as never,
    };
}

/** An empty registry: a process where no job runtime was registered. */
function emptyRegistry(): JobRuntimeProviderRegistry {
    return { register: jest.fn(), getActive: () => null };
}

/** The provider entry the module declares for the token, as metadata. */
function dispatcherBinding(): {
    provide?: unknown;
    useFactory?: unknown;
    useExisting?: unknown;
    inject?: unknown[];
} {
    const providers = (Reflect.getMetadata('providers', AppWorksModule) as unknown[]) ?? [];
    const binding = providers.find(
        (provider) =>
            typeof provider === 'object' &&
            provider !== null &&
            (provider as { provide?: unknown }).provide === APP_FORK_READINESS_DISPATCHER,
    );
    expect(binding).toBeDefined();
    return binding as { useFactory?: unknown; inject?: unknown[] };
}

describe('C10 — the App Works module binds APP_FORK_READINESS_DISPATCHER', () => {
    it('provides the token through a factory, and exports it', () => {
        const binding = dispatcherBinding();

        expect(typeof binding.useFactory).toBe('function');
        // A `useExisting` alias would be a placeholder by another name: it resolves
        // the token to a service instead of to a dispatch, which is what T28's note
        // ("a tick that queues nothing look like a tick that queued something")
        // forbids.
        expect(binding.useExisting).toBeUndefined();
        expect((Reflect.getMetadata('exports', AppWorksModule) as unknown[]) ?? []).toContain(
            APP_FORK_READINESS_DISPATCHER,
        );
    });

    it('injects the job-runtime registry OPTIONALLY, so a runtime-less process still compiles', () => {
        const binding = dispatcherBinding();

        expect(binding.inject).toEqual([{ token: JOB_RUNTIME_PROVIDER_REGISTRY, optional: true }]);
    });

    it('provides and exports AppActionsHygieneService — the readiness run’s required collaborator', () => {
        // `AppForkReadinessService` injects it NON-optionally, so a module that binds
        // the runner but not the hygiene service would fail at the first run rather
        // than at boot.
        expect((Reflect.getMetadata('providers', AppWorksModule) as unknown[]) ?? []).toContain(
            AppActionsHygieneService,
        );
        expect((Reflect.getMetadata('exports', AppWorksModule) as unknown[]) ?? []).toContain(
            AppActionsHygieneService,
        );
        expect(typeof buildAppForkReadinessDispatcherProvider().useFactory).toBe('function');
    });

    describe('the factory, driven directly', () => {
        const dispatcherOf = (registry: JobRuntimeProviderRegistry | undefined) => {
            const factory = buildAppForkReadinessDispatcherProvider().useFactory as (
                registry?: JobRuntimeProviderRegistry | null,
            ) => { dispatch(payload: AppForkReadinessJobPayload): Promise<string | null> };
            return factory(registry);
        };

        it('answers null when no registry is reachable (nothing is invented)', async () => {
            await expect(dispatcherOf(undefined).dispatch(PAYLOAD)).resolves.toBeNull();
        });

        it('answers null when no runtime is registered, or it has no such dispatcher', async () => {
            await expect(dispatcherOf(emptyRegistry()).dispatch(PAYLOAD)).resolves.toBeNull();
            await expect(
                dispatcherOf(registryWith({ dispatchAppBuildPrepare: jest.fn() })).dispatch(
                    PAYLOAD,
                ),
            ).resolves.toBeNull();
        });

        it('dispatches through the active runtime and returns its run id', async () => {
            const dispatchAppForkReadiness = jest.fn(async () => 'run_readiness_1');

            await expect(
                dispatcherOf(registryWith({ dispatchAppForkReadiness })).dispatch(PAYLOAD),
            ).resolves.toBe('run_readiness_1');
            // The payload arrives unchanged: the binding is a hop, not a translation.
            expect(dispatchAppForkReadiness).toHaveBeenCalledTimes(1);
            expect(dispatchAppForkReadiness).toHaveBeenCalledWith(PAYLOAD);
        });

        it('normalises a runtime that answers undefined to null', async () => {
            const dispatchers = { [DISPATCH_METHOD]: jest.fn(async () => undefined) };

            await expect(
                dispatcherOf(registryWith(dispatchers)).dispatch(PAYLOAD),
            ).resolves.toBeNull();
        });

        it('propagates a runtime failure — the call sites already log and fail closed', async () => {
            // Both call sites wrap `dispatch` in try/catch and record
            // `dispatch_unavailable`, so swallowing here would hide the provider's own
            // message from the only place that logs it.
            const dispatchers = {
                [DISPATCH_METHOD]: jest.fn(async () => {
                    throw new Error('trigger api unreachable');
                }),
            };

            await expect(dispatcherOf(registryWith(dispatchers)).dispatch(PAYLOAD)).rejects.toThrow(
                'trigger api unreachable',
            );
        });
    });

    describe('a real container', () => {
        const containerDispatchers = {
            [DISPATCH_METHOD]: jest.fn(async () => 'run_readiness_container'),
        };

        /**
         * See the file header: a `@Global()` module is how the production graph
         * supplies the registry too (`TriggerModule` is `@Global()`), and it is the
         * only shape that reaches `AppWorksModule`'s own providers from outside it.
         */
        @Global()
        @Module({
            providers: [
                {
                    provide: JOB_RUNTIME_PROVIDER_REGISTRY,
                    useValue: registryWith(containerDispatchers),
                },
            ],
            exports: [JOB_RUNTIME_PROVIDER_REGISTRY],
        })
        class TestRegistryModule {}

        /** The two tokens the module cannot mint itself, as its own spec supplies them. */
        async function compile(imports: ModuleMetadata['imports']) {
            return Test.createTestingModule({ imports })
                .overrideProvider(getRepositoryToken(WorkUpstreamState))
                .useValue({ findOne: jest.fn().mockResolvedValue(null) })
                .overrideProvider(DistributedTaskLockService)
                .useValue({ runExclusive: jest.fn(), isLocked: jest.fn() })
                .compile();
        }

        it('resolves the token with no runtime in the graph, and answers null', async () => {
            const moduleRef = await compile([AppWorksModule]);

            const dispatcher = moduleRef.get(APP_FORK_READINESS_DISPATCHER) as {
                dispatch(payload: AppForkReadinessJobPayload): Promise<string | null>;
            };
            expect(typeof dispatcher.dispatch).toBe('function');
            await expect(dispatcher.dispatch(PAYLOAD)).resolves.toBeNull();

            await moduleRef.close();
        });

        it('reaches the active runtime through the registry the graph provides', async () => {
            const moduleRef = await compile([TestRegistryModule, AppWorksModule]);

            const dispatcher = moduleRef.get(APP_FORK_READINESS_DISPATCHER) as {
                dispatch(payload: AppForkReadinessJobPayload): Promise<string | null>;
            };
            await expect(dispatcher.dispatch(PAYLOAD)).resolves.toBe('run_readiness_container');
            expect(containerDispatchers[DISPATCH_METHOD]).toHaveBeenCalledWith(PAYLOAD);

            await moduleRef.close();
        });

        it('hands the SAME binding to both call sites that inject it', async () => {
            // The C10 claim in one assertion: before this binding both services' private
            // `readinessDispatcher` fields were `undefined`. They are read here rather
            // than through a public method because the defect was in the injection, not
            // in what the method does with it.
            const moduleRef = await compile([TestRegistryModule, AppWorksModule]);

            const bound = moduleRef.get(APP_FORK_READINESS_DISPATCHER);
            expect(bound).toBeDefined();
            expect((moduleRef.get(AppWorkCreateService) as any).readinessDispatcher).toBe(bound);
            expect((moduleRef.get(AppUpstreamStateService) as any).readinessDispatcher).toBe(bound);
            expect(moduleRef.get(AppActionsHygieneService)).toBeInstanceOf(
                AppActionsHygieneService,
            );

            await moduleRef.close();
        });
    });

    describe('the two halves of the chain agree on their constants', () => {
        /**
         * The task file this slice ships, read as text — the T20 idiom
         * (`app-build-watch.runner.spec.ts:542-566`) for a pair that lives in two
         * packages the compiler cannot check together: the agent package cannot import
         * `@ever-works/trigger-tasks`, so the *id* the job registers under and the *name*
         * the worker proxies are two strings that must match, and nothing else in the
         * tree would notice if they drifted.
         */
        const taskSource = readFileSync(
            join(
                __dirname,
                '..',
                '..',
                '..',
                '..',
                'tasks',
                'src',
                'tasks',
                'trigger',
                'app-fork-readiness.task.ts',
            ),
            'utf8',
        );

        /**
         * The same source with every whitespace character removed — the assertions below
         * are about WHICH tokens the file contains, not about how prettier wrapped them
         * (`task<\n  'app-fork-readiness',\n  AppForkReadinessTaskPayload\n>` and the
         * one-line form are the same registration, and a wrap-sensitive assertion is a
         * test that goes red on a `prettier --write`).
         */
        const denseSource = taskSource.replace(/\s+/g, '');

        it('registers the job id this package names', () => {
            expect(APP_FORK_READINESS_JOB_ID).toBe('app-fork-readiness');
            expect(taskSource).toContain(
                "export const APP_FORK_READINESS_TASK_ID = 'app-fork-readiness' as const;",
            );
            expect(denseSource).toContain('id:APP_FORK_READINESS_TASK_ID,');
            expect(denseSource).toContain("task<'app-fork-readiness',AppForkReadinessTaskPayload>");
        });

        it('proxies the remote target the API’s remoteMap entry is named', () => {
            // `AppForkReadinessRunner` is the name the controller's `remoteMap` publishes
            // (asserted from the API side in `trigger-internal.controller.spec.ts`); a
            // rename on either side would otherwise only fail on the run that needed it.
            expect(denseSource).toContain("createRemoteProxy(apiClient,'AppForkReadinessRunner')");
        });
    });
});
