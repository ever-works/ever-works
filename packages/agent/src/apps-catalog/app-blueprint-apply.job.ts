/**
 * APW-03 T28 (lane aw-blueprints) — the `app-blueprint-apply` job: its id, its payload,
 * its dispatcher token and the binding of that token to the active job runtime.
 *
 * Plan §6.1 names one job for both halves of the Blueprint lifecycle:
 *
 * | Job id | Dispatcher symbol | Payload | Budget |
 * | ------ | ----------------- | ------- | ------ |
 * | `app-blueprint-apply` | `APP_BLUEPRINT_APPLY_DISPATCHER` | `{ workId, userId, blueprintId, mode: 'apply' \| 'upgrade', version?, … }` | 300 s, retries 1 |
 *
 * The FIRST apply of a Blueprint chosen at create time does not go through this job —
 * it lands inline through the ready handler (`AppBlueprintApplyService.compose`, decision
 * 2026-10-17). This job is what the App spec tab's **Apply a Blueprint** (a Work created
 * without one) and **Review upgrade** run: compose with the three-way merge
 * (`app-spec-merge.ts`) and propose the result as ONE pull request on the Work
 * Repository — never a push to the tracked branch.
 *
 * ## The binding (the C10 shape)
 *
 * `APP_BLUEPRINT_APPLY_DISPATCHER` is bound in the agent `AppWorksModule`, where its one
 * consumer (`AppBlueprintUpgradeService`) is declared, to the active runtime's
 * `dispatchers.dispatchAppBlueprintApply` — `TriggerService.dispatchAppBlueprintApply`
 * in `packages/tasks`. No runtime, or a runtime without the method, answers `null`, and
 * the service then runs the job in the API process (see its docstring): nothing is
 * dropped and nothing pretends to be queued.
 */
import type { FactoryProvider } from '@nestjs/common';
import type { AppBlueprintRunMode } from '@ever-works/contracts';
import {
    JOB_RUNTIME_PROVIDER_REGISTRY,
    type JobRuntimeProviderRegistry,
} from '../tasks/job-runtime.providers';

/** Job id / Trigger.dev task id (plan §6.1). */
export const APP_BLUEPRINT_APPLY_JOB_ID = 'app-blueprint-apply';

/** Plan §6.1's budget: 300 s, retries 1. */
export const APP_BLUEPRINT_APPLY_MAX_DURATION_S = 300;

/** The payload of one run. Ids, a version and a mode — never a value of the spec. */
export interface AppBlueprintApplyJobPayload {
    /** The App Work. */
    readonly workId: string;
    readonly mode: AppBlueprintRunMode;
    /** The Blueprint id (`ever-works/<id>-template`). */
    readonly blueprintId: string;
    /** The Blueprint version the run composes. */
    readonly version: string;
    /** Who asked. The Work owner's credential lands the pull request either way. */
    readonly userId?: string | null;
    /** ISO time of the request, for the run log. */
    readonly requestedAt?: string;
}

/** Producer-side interface; `null` = no runtime (the caller runs it in-process). */
export interface AppBlueprintApplyDispatcher {
    dispatch(payload: AppBlueprintApplyJobPayload): Promise<string | null>;
}

export const APP_BLUEPRINT_APPLY_DISPATCHER = Symbol('APP_BLUEPRINT_APPLY_DISPATCHER');

/** The method the active job runtime exposes (`TriggerService.dispatchAppBlueprintApply`). */
export const BLUEPRINT_APPLY_DISPATCH_METHOD = 'dispatchAppBlueprintApply' as const;

/**
 * The binding, built by a function so a spec can drive the factory with a fake registry
 * as well as through a container. The registry is injected optionally, so the module
 * compiles where no job runtime exists (the agent's own module specs, a CLI context).
 */
export function buildAppBlueprintApplyDispatcherProvider(): FactoryProvider {
    return {
        provide: APP_BLUEPRINT_APPLY_DISPATCHER,
        useFactory: (
            registry?: JobRuntimeProviderRegistry | null,
        ): AppBlueprintApplyDispatcher => ({
            dispatch: async (payload: AppBlueprintApplyJobPayload): Promise<string | null> => {
                const dispatchers = registry?.getActive()?.dispatchers as
                    | Record<string, unknown>
                    | undefined;
                const dispatch = dispatchers?.[BLUEPRINT_APPLY_DISPATCH_METHOD];
                if (typeof dispatch !== 'function') {
                    return null;
                }
                const runId = await (
                    dispatch as (p: AppBlueprintApplyJobPayload) => Promise<string | null>
                ).call(dispatchers, payload);
                return runId ?? null;
            },
        }),
        inject: [{ token: JOB_RUNTIME_PROVIDER_REGISTRY, optional: true }],
    };
}
