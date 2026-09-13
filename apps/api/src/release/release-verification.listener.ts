import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { FleetJobCompletedEvent } from '@ever-works/agent/events';
import { ReleaseVerificationService } from '@ever-works/agent/tasks-domain';
import { isReleaseVerifyCheckPass, type FleetBrowserCheckResult } from '@ever-works/contracts';

/**
 * Post-deploy verification (self-build slice AJ, EW-809) — the API-side
 * half that turns "a node reported on a browser check" into a verdict on
 * the promotion it belonged to.
 *
 * ## Why a listener
 *
 * Every terminal path a fleet job can take converges on ONE event:
 * `FleetJobCompletedEvent`, emitted for a node's own report, for an
 * operator cancel, for a lease the reclaim sweep exhausted, and for a job
 * the queue SLA failed after nobody took it. Subscribing here covers all
 * four with one subscription — which matters more than usual for this
 * slice, because three of the four are ways a check can fail to happen at
 * all, and every one of them has to reach the state machine or a
 * verification would hang until its deadline for a reason nobody recorded.
 *
 * ## Where `ok` is decided, and why it is decided HERE
 *
 * This is the trust boundary. `result` is whatever a node PUT on the
 * completion endpoint — untrusted data from somebody's PC — so it is
 * narrowed to a strict `=== true` on a `done` job and nothing else is
 * allowed to mean "pass":
 *
 *   - a `failed` job is not a pass;
 *   - a job with no result is not a pass;
 *   - `ok: "true"`, `ok: 1`, `ok: {}` are not passes;
 *   - a lease exhausted, a cancel and a queue-SLA expiry are not passes.
 *
 * The direction matters. A false negative delays a verdict and, at worst,
 * settles it `inconclusive` — which offers nothing and reverts nothing. A
 * false positive would tell a human a broken production deployment is
 * healthy, or, one state later, would confirm a failure that never
 * happened. So every ambiguity resolves to "not a pass".
 *
 * The rule itself lives in `@ever-works/contracts` as
 * `isReleaseVerifyCheckPass`, because this is no longer the only caller:
 * the sweep reconciles a check that reached a terminal fleet state without
 * its result reaching the state machine (a transient database error here,
 * or a replica restarting between the fleet write and this handler), and a
 * lane where the two paths disagreed could call one job green on one and
 * red on the other.
 */
@Injectable()
export class ReleaseVerificationListener {
    private readonly logger = new Logger(ReleaseVerificationListener.name);

    constructor(private readonly verification: ReleaseVerificationService) {}

    @OnEvent(FleetJobCompletedEvent.EVENT_NAME, { async: true })
    async onCompleted(event: FleetJobCompletedEvent): Promise<void> {
        // Cheap guard, not an authorization: the authorization is that the
        // promotion row itself has to be pointing at this job id.
        if (event.job?.kind !== 'browser-check') return;

        const ok = isCheckPass(event);
        try {
            await this.verification.onBrowserCheckCompleted(
                event.job.id,
                ok,
                describeReading(event),
            );
        } catch (error) {
            // Never throw out of an event handler: the emitter has no
            // caller to report to, and the verification's own deadline
            // still ends the row if this keeps failing.
            this.logger.warn(
                `Browser check ${event.job.id}: could not record the verification result: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}

/**
 * Did this check PASS?
 *
 * `succeeded` is the job reaching `done`; `result.ok === true` is the
 * executor's own verdict, which it sets only when the browser rendered the
 * page AND every expectation held (`apps/node/src/core/executors/browser-check.ts`).
 * Both, strictly, or it is not a pass.
 */
function isCheckPass(event: FleetJobCompletedEvent): boolean {
    // `event.succeeded` is `job.status === 'done'`; passing the status
    // itself keeps this and the sweep's recovery path on ONE rule.
    return isReleaseVerifyCheckPass(event.job?.status, event.result);
}

/**
 * A short, human-readable note about what the node saw.
 *
 * Everything here is node-reported and therefore untrusted; the service
 * flattens control characters and caps the length before it reaches a row,
 * an Inbox body or a Task thread.
 */
function describeReading(event: FleetJobCompletedEvent): string {
    if (event.error) return `Node reported: ${event.error}`;
    const result = event.result as Partial<FleetBrowserCheckResult> | null;
    if (!result) {
        return `The check settled ${event.job.status} with no result (${event.source}).`;
    }
    if (result.ok === true) {
        const title = typeof result.title === 'string' && result.title ? ` "${result.title}"` : '';
        return `Page loaded${title} (${result.domBytes ?? 0} bytes of DOM).`;
    }
    return typeof result.error === 'string' && result.error
        ? `Check failed: ${result.error}`
        : 'Check failed with no reason given.';
}
