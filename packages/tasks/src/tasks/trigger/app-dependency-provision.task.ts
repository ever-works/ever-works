import { Module } from '@nestjs/common';
import { logger, task } from '@trigger.dev/sdk';
import { config } from '@ever-works/agent/config';
import {
    AppDependenciesService,
    AppDependencyProvisionRunner,
} from '@ever-works/agent/app-dependencies';
import type { AppDependencyProvisionPayload } from '@ever-works/agent/tasks';
import { TriggerWorkerModule } from '../../trigger/worker/modules/trigger-worker.module';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * APW-07 T17 — `app-dependency-provision` on APW-06's `app-cluster-io` queue
 * (plan §7:864-888, APW-06 plan §6.2:940-952, CONTRACTS §5).
 *
 * One message per (App Work, dependency kind): claim the row's lease, dial the
 * provider through `AppDependenciesService` (namespace preparation, decrypted
 * configuration, outputs encryption and every Activity event are that service's
 * work), settle the row, and let the RUNNER schedule the delayed re-dispatch —
 * the job never sleeps (plan §7:875-876).
 *
 * ## Why this runs on `app-cluster-io` and nowhere else
 *
 * The dependency providers create StatefulSets, Secrets, PVCs, Jobs and
 * NetworkPolicies in the owner's cluster, and the external ones dial the
 * owner's SMTP/S3 server. FR-5 and ACC-06-04 say no App Work cluster connection
 * originates from the API or the web process, so this task declares the queue
 * APW-06 created for exactly that traffic (`concurrencyLimit: 20`, APW-06 plan
 * §6.2:942) and shares it with `app-deploy`, `app-smoke`, `app-cluster-op`,
 * `app-health-poll` and `app-preview-gc`.
 *
 * ## The production gate (APW-06 plan §6.2:950-952)
 *
 * `NODE_ENV=production` refuses to touch a cluster unless the operator has
 * attested that this queue's worker has no route to internal networks
 * (`EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED=true`, read through
 * `config.everWorks.apps.isClusterWorkerIsolated()`). The attestation is
 * enforced in TWO places on purpose: the **dispatcher**
 * (`TriggerService.dispatchAppDependencyProvision`) refuses to enqueue
 * (`worker_not_isolated`), so nothing is even scheduled, and this task refuses
 * to RUN, so a message enqueued before the flag was flipped — or by an older
 * deployment — still cannot dial anything. Failing closed here means a lease is
 * never claimed and no provider is ever called.
 *
 * `maxDuration` is 30 minutes: the longest kind deadline is 10 minutes (FR-41)
 * and a run that has not settled by then has already lost its lease to the
 * compare-and-set. `retry.maxAttempts` is 1 because the runner owns retries —
 * they are observable re-dispatches with their own spacing (5 minutes / 3
 * attempts, FR-43) and a runtime-level retry would collapse that spacing into
 * an immediate second dial.
 */

/**
 * Provisional composition — **reported, not hidden** (the seam APW-06 T71 owns).
 *
 * APW-06's T32 gives its five sibling tasks the isolated-worker module
 * `TriggerAppRuntimeModule` (APW-06 plan §6.4:966-991, its T71), whose rule is:
 * no `DatabaseModule`, no TypeORM `DataSource`, and repositories provided as
 * `createRemoteProxy` entries over the internal API. That module is not in this
 * tree, and this task cannot import it without inventing it (the module is
 * APW-06's file, and its repository proxy list is what would give
 * `AppDependenciesService` its `WorkAppDependencyRepository`).
 *
 * Until it lands, this module is the narrowest composition that boots the
 * runner: the standard worker graph plus the two providers the job resolves.
 * `AppDependenciesService` is provided directly (not through its own
 * `AppDependenciesModule`, which would drag a `DataSource` into the worker and
 * break the §6.4 rule) and every one of its collaborators is `@Optional()`, so
 * an unproxied repository degrades into the runner's own reported
 * `storeUnavailable` / `serviceUnavailable` — a named refusal in the run log,
 * never a silent success.
 *
 * **The swap when T71 lands is one line**: replace
 * `AppDependencyProvisionWorkerModule` with `TriggerAppRuntimeModule` in the
 * `withWorkerContext` call below, exactly as APW-06's T32 tasks do.
 *
 * ⚠ Correction, 2026-09-26: `TriggerAppRuntimeModule` IS in this tree now, and the
 * swap is NOT one line — that module provides none of this service's collaborators
 * either. `apps/api/src/app-works-di-reachability.spec.ts` measures what this
 * context leaves unbound: `WorkAppDependencyRepository` and the entity's TypeORM
 * repository (row creation goes through `@InjectRepository(WorkAppDependency)`, which
 * a remote proxy cannot carry — the write path needs repository methods first),
 * `APP_DEPENDENCY_CONFIG_CIPHER` (`AppEnvCrypto` and its key in the isolated worker),
 * `APP_DEPENDENCY_CLUSTER_ACCESS` (`AppRuntimeFacadeService`, which lives in T71's
 * module), `AppDependencyFacadeService` and `APP_DEPENDENCY_PROVISION_DISPATCHER`
 * (the runner's re-dispatch). That composition is T71's and T17's open work; until it
 * lands every run answers the runner's named `storeUnavailable`, and nothing is
 * dialled.
 */
@Module({
    imports: [TriggerWorkerModule],
    providers: [AppDependenciesService, AppDependencyProvisionRunner],
})
class AppDependencyProvisionWorkerModule {}

export const appDependencyProvisionTask = task<
    'app-dependency-provision',
    AppDependencyProvisionPayload
>({
    id: 'app-dependency-provision',
    // The longest kind deadline is 10 minutes (Postgres and object storage,
    // FR-41); a run still going after 30 has already lost its lease.
    maxDuration: 1800,
    // The runner owns the retry schedule (FR-43) — see the file header.
    retry: { maxAttempts: 1 },
    queue: {
        // APW-06's queue for every App Work cluster connection (plan §6.2:942).
        name: 'app-cluster-io',
        concurrencyLimit: 20,
    },
    run: async (payload) => {
        // The production gate, before ANY cluster code path is reached and
        // before a lease is claimed (APW-06 plan §6.2:950-952, ACC-06-04).
        if (
            process.env.NODE_ENV === 'production' &&
            !config.everWorks.apps.isClusterWorkerIsolated()
        ) {
            logger.error(
                'app-dependency-provision: refusing to run in production — ' +
                    'EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED is not true, so this worker is not ' +
                    'attested as having no route to internal networks.',
                { workId: payload?.workId, kind: payload?.kind, mode: payload?.mode },
            );
            return {
                status: 'skipped' as const,
                reason: 'worker_not_isolated',
                workId: payload?.workId,
                kind: payload?.kind,
            };
        }

        return withWorkerContext(
            'AppDependencyProvision',
            async (appContext) => {
                const runner = appContext.get(AppDependencyProvisionRunner);
                const result = await runner.run(payload);

                if (result.reason) {
                    // A missing seam is an operator-visible problem, not a
                    // quiet no-op: nothing was dialled and nothing will retry.
                    logger.error(
                        `app-dependency-provision: ${result.reason} — nothing was provisioned.`,
                        { workId: result.workId, mode: result.mode },
                    );
                }

                logger.info('app-dependency-provision finished', {
                    workId: result.workId,
                    mode: result.mode,
                    kinds: result.kinds.map((entry) => `${entry.kind}:${entry.status}`),
                    redispatch: result.redispatch.length,
                });

                return result;
            },
            AppDependencyProvisionWorkerModule,
        );
    },
});
