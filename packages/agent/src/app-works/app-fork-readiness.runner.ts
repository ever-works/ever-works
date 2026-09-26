import { Injectable, Logger } from '@nestjs/common';
import {
    AppForkReadinessService,
    type AppForkReadinessRunResult,
} from './app-fork-readiness.service';
import type { AppForkReadinessJobPayload } from './app-upstream-state.service';

/**
 * APW-02 T24's job-facing half — **C10** (`docs/internal/app-works-build-progress.md`
 * §5.2 row C10). A thin, serialisable seam in front of
 * {@link AppForkReadinessService}, modelled on T19/T20's
 * `AppBuildPrepareRunner` / `AppBuildWatchRunner` because the shape of the
 * problem is the same one C7 and C17 closed for the Build pair.
 *
 * ## Why this class exists at all
 *
 * `AppForkReadinessService.run(payload, deps)` takes a **function**
 * (`deps.sleep`) — that is what makes the poll testable without waiting fifteen
 * minutes, and it is also what makes `run` unreachable over the internal RPC
 * channel: `createRemoteProxy` serialises arguments with SuperJSON
 * (`packages/tasks/src/trigger/worker/remote-proxy.ts:93-96`), and SuperJSON has
 * no transformer for a function. Handing a worker's `wait.for` across the hop is
 * therefore **not** a thing that can be done, and the two remaining shapes are:
 *
 *   1. run the readiness service **where the `DataSource` is** (the API process),
 *      with a real timer as the sleep — this file; or
 *   2. move the run into the worker, which owns no `DataSource`, so
 *      `beginAttempt` / `probeReadiness` / `markReady` — every write this job
 *      exists to make — would have to cross back over the same channel anyway.
 *
 * The service is API-side by plan §2.4 (`plan.md:194` names the long poll and the
 * private-copy push as off-the-API-event-loop work, and §6.2 gives the job the
 * worker machine), and the *state row* is the record FR-17…FR-24a are read
 * through, so (1) is the shape that keeps one writer: this runner is provided in
 * the API process beside the state service, `AppForkReadinessRunner` is the
 * `remoteMap` entry the worker proxies, and the one method it exposes is `run`
 * with a **serialisable** payload.
 *
 * ## What the RPC hop costs, stated honestly
 *
 * The internal call holds for the duration of the attempt: the poll schedule of
 * FR-18 (2 s, 4 s, 8 s, then every 15 s, up to `APP_FORK_READINESS_TIMEOUT_MS`)
 * is spent inside the API process as real timer waits, with the worker's HTTP
 * request open. That is bounded by the same deadline the poll is bounded by, and
 * it is the one property this seam waives in exchange for the writes landing
 * where the row is. A run that ends before the first wait (no state row, already
 * `ready`, `setup_merged`) costs nothing — which is what the RPC probe of this
 * slice measures.
 */

/**
 * The job id this seam answers for — the same literal
 * `packages/tasks/src/tasks/trigger/app-fork-readiness.task.ts` registers its
 * `task({ id })` under. Declared here (not copied from `packages/tasks`, which
 * the agent package cannot import) so the dispatch site and the task module have
 * one string to disagree about, and `app-fork-readiness.task.spec.ts` fails if
 * they ever do.
 */
export const APP_FORK_READINESS_JOB_ID = 'app-fork-readiness' as const;

/**
 * The one method the worker calls over the internal channel. Declared as an
 * interface (rather than published as the service itself) for two reasons: the
 * arguments must be serialisable, and `run` is the whole surface a worker needs —
 * publishing `AppForkReadinessService` would also publish `get`, `retryReadiness`
 * and its other members to the RPC allow-list.
 */
export interface AppForkReadinessRunnerSeam {
    run(payload: AppForkReadinessJobPayload): Promise<AppForkReadinessRunResult>;
}

/**
 * `AppForkReadinessService.run` with a real clock, so the poll spends real time
 * and the job's payload stays the only thing that crosses the hop.
 *
 * The deadlines the run enforces are the service's own (`resolveReadinessTimeoutMs`,
 * FR-18/FR-18a) — this file adds no second timeout and no second schedule.
 */
@Injectable()
export class AppForkReadinessRunner implements AppForkReadinessRunnerSeam {
    private readonly logger = new Logger(AppForkReadinessRunner.name);

    constructor(private readonly readiness: AppForkReadinessService) {}

    /**
     * One readiness attempt. Never swallows: a run that throws is the service's
     * own answer (its state calls are already guarded by `safe()`), and the task
     * reports it as `failed` with the RPC's own message rather than as a green
     * run that prepared nothing.
     */
    async run(payload: AppForkReadinessJobPayload): Promise<AppForkReadinessRunResult> {
        const workId = payload?.workId;
        this.logger.log(
            `App fork readiness run: work ${workId ?? '<none>'} attempt ${payload?.attempt ?? 1} reason ${payload?.reason ?? 'initial'}`,
        );

        return this.readiness.run(payload, { sleep: sleepMs });
    }
}

/** The real wait: a timer. See the class docstring for why it is not `wait.for`. */
function sleepMs(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}
