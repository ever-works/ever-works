import { Controller, Get, HttpCode, HttpException, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AppUpstreamStateResponse } from '@ever-works/contracts';
import {
    AppUpstreamStateService,
    AppUpstreamSyncDispatcherService,
    isAppUpstreamRefusalError,
    type AppUpstreamDispatchResult,
    type AppUpstreamErrorCode,
} from '@ever-works/agent/app-works';
import { CurrentUser } from '@src/auth/decorators/user.decorator';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';

/**
 * APW-02 T27 — the three Upstream routes (plan §4.1, `plan.md:487-516`).
 *
 * Spec: FR-33 (Sync now), FR-34 (one sync at a time), FR-46 (a stale divergence reading
 * refreshes on view), FR-56/ACC-02-21 (another account's Work is not found). ACC-02-05,
 * ACC-02-13, ACC-02-14, ACC-02-21.
 *
 * ## The controller decides nothing
 *
 * Every rule these routes enforce — visibility, readiness, the pause states, the two
 * rolling-hour allowances, the error code and the HTTP status that goes with it — lives in
 * `AppUpstreamStateService` (T23) and is reached through it. This file's whole job is:
 * take the caller's id from the session, hand the service the Work id and that user,
 * translate the service's typed refusal into the `{ status: 'error', code, message,
 * details? }` body §4.1 fixes, and fire the one background compare the GET route owns.
 * A second copy of a refusal rule here would be a second answer to the same question —
 * which is why there is no `if` in this file that inspects a Work, a state or a count.
 *
 * ## Why the refusals are translated instead of filtered
 *
 * `AppUpstreamRefusalError` is a plain `Error` with a `code`, an HTTP `status` and a
 * `details` bag (`app-upstream-state.service.ts:172-189`): the service already decided
 * the answer, so the mapping is a projection and never a decision. It is done here rather
 * than in a global filter because the body shape is §4.1's contract for *these* routes,
 * and because `isAppUpstreamRefusalError` also admits the look-alike object a bundled copy
 * of the class produces (the same cross-bundle guard `AppLauncherPinLimitError` uses).
 * Anything that is not a refusal keeps travelling: a `FacadeError` still reaches
 * `FacadeExceptionFilter`, and a genuine bug is still a 500.
 *
 * ## The GET fires the divergence compare and never waits for the run
 *
 * §4.1 hangs a background `app-upstream-sync` with `trigger: 'divergence'` off the read
 * when the stored reading is older than 600 000 ms — at most once per 600 000 ms per Work
 * (FR-46, ACC-02-13). The **decision and the window** are
 * `AppUpstreamSyncDispatcherService.requestDivergenceCompare`; this route calls it on every
 * read and never lets it change the answer: the **enqueue** is awaited (so a queue outage
 * cannot leave an unhandled rejection behind and the state a test observes is the state
 * the route produced), while the **run** is not — the response carries the reading the row
 * has now, with `divergence.stale: true` saying it is old, exactly as FR-46 requires.
 */
@ApiTags('App Works')
@Controller('api/works')
export class AppUpstreamController {
    constructor(
        private readonly upstream: AppUpstreamStateService,
        private readonly dispatcher: AppUpstreamSyncDispatcherService,
    ) {}

    /**
     * `GET /api/works/:id/upstream` — the whole Upstream card in one answer
     * (`AppUpstreamStateResponse`, §3.4).
     *
     * `120` per minute: the card is read on every view of the Upstream tab and on the
     * Work overview, and the reading it renders is refreshed by a background job rather
     * than by the caller, so a generous read budget costs nothing and a tight one would
     * break a page that polls.
     */
    @Get(':id/upstream')
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Read one App Work’s upstream state',
        description:
            'Relation, repositories, readiness, the last divergence reading with its age, the sync state, the Actions hygiene state and every warning the card renders. A Work that does not exist, is not kind `app`, or is not visible to the caller answers `404 not_found`. A reading older than ten minutes is returned with `divergence.stale: true` and refreshed in the background.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: '`AppUpstreamStateResponse`.' })
    @ApiResponse({ status: 401, description: 'No session.' })
    @ApiResponse({
        status: 404,
        description:
            '`{ status: "error", code: "not_found" }` — missing, not an app Work, or another account’s.',
    })
    async getUpstream(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<AppUpstreamStateResponse> {
        // The service's own `get` is the visibility check and the whole response at once
        // (FR-56): the controller must not pre-read the Work, or a stranger's probe would
        // be answered by a second code path with its own idea of "visible". Its refusal is
        // translated exactly as the two POSTs' are — §4.1's `404 not_found` must reach the
        // client as that code, never as the `500` an untranslated plain `Error` becomes.
        const state = await this.translate(() => this.upstream.get(id, auth.userId));

        await this.refreshDivergence(id);
        // The second background half of §4.1 (FR-24a, T43): a Work waiting on its setup pull
        // request is re-checked when the card is opened, at most once a minute — the row's own
        // `setupCheckedAt` is the gate. Same posture as the divergence refresh above: it can
        // never turn a rendered card into an error.
        await this.refreshSetupPullRequest(id);

        return state;
    }

    /**
     * `POST /api/works/:id/upstream/sync` — **Sync now** (FR-33, FR-34).
     *
     * `202 { queued: true, runId }` without awaiting the run (ACC-02-14), `12` per minute
     * at the route (the authoritative allowance is the six-per-rolling-hour the service
     * takes), and §4.1's refusals verbatim: `422 no_upstream` for a `link`,
     * `409 not_ready` / `409 sync_paused` / `409 sync_in_progress` and
     * `429 sync_limit_reached`.
     */
    @Post(':id/upstream/sync')
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 12, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Queue an upstream sync for one App Work',
        description:
            'Answers as soon as the job is queued — never after it has run. Refused with `422` when the Work is a link, `409` when it is not ready, when it is paused or when a sync is already running, and `429` on the seventh call inside a rolling hour.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 202, description: '`{ queued: true, runId: string | null }`.' })
    @ApiResponse({ status: 401, description: 'No session.' })
    @ApiResponse({ status: 404, description: '`not_found`.' })
    @ApiResponse({
        status: 409,
        description: '`not_ready` · `sync_paused` (+ `details.reason`) · `sync_in_progress`.',
    })
    @ApiResponse({ status: 422, description: '`no_upstream` — the App Work is a link.' })
    @ApiResponse({
        status: 429,
        description: '`sync_limit_reached` (+ `details.retryAt`).',
    })
    async syncUpstream(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<AppUpstreamDispatchResult> {
        return this.translate(() => this.upstream.requestSync(id, auth.userId));
    }

    /**
     * `POST /api/works/:id/upstream/readiness/retry` — **Try again** (FR-19).
     *
     * `202 { queued: true, runId }`, `6` per minute at the route, and §4.1's refusals:
     * `409 not_retryable` while the readiness is `preparing` or `ready` (nothing is stuck),
     * `429 retry_limit_reached` on the fourth call inside a rolling hour. A refusal consumes
     * no attempt — the service takes the allowance only after it has decided the retry means
     * something.
     */
    @Post(':id/upstream/readiness/retry')
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 6, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Retry the readiness of one App Work',
        description:
            'Puts the Work back to `preparing` and re-queues the readiness job without requesting a second fork. Refused with `409` when nothing is stuck and `429` on the fourth call inside a rolling hour.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 202, description: '`{ queued: true, runId: string | null }`.' })
    @ApiResponse({ status: 401, description: 'No session.' })
    @ApiResponse({ status: 404, description: '`not_found`.' })
    @ApiResponse({ status: 409, description: '`not_retryable`.' })
    @ApiResponse({ status: 429, description: '`retry_limit_reached`.' })
    async retryUpstreamReadiness(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<AppUpstreamDispatchResult> {
        return this.translate(() => this.upstream.retryReadiness(id, auth.userId));
    }

    /**
     * The three routes' shared body: run the service call, translate a typed refusal and
     * let everything else through.
     */
    private async translate<T>(call: () => Promise<T>): Promise<T> {
        try {
            return await call();
        } catch (error) {
            if (isAppUpstreamRefusalError(error)) {
                throw new HttpException(refusalBody(error), error.status);
            }
            throw error;
        }
    }

    /**
     * The background compare (§4.1, FR-46).
     *
     * Best-effort by construction: `requestDivergenceCompare` answers `null` for every
     * "nothing to do" case and catches its own dispatch failures, and this wrapper is the
     * second belt — a refresh that cannot be queued must never turn a readable card into a
     * `500`, because the card is exactly what the member needs in order to see that
     * something is stale.
     */
    private async refreshDivergence(workId: string): Promise<void> {
        try {
            await this.dispatcher.requestDivergenceCompare(workId);
        } catch {
            // Deliberately swallowed: the reading and its `stale` flag are already in the
            // response above. The dispatcher logs its own failures.
        }
    }

    /**
     * The background setup pull request check (§4.1, FR-24a — the on-view half of T43).
     *
     * Best-effort for the same reason {@link refreshDivergence} is: the card has already been
     * read, and a check that cannot run must not turn it into a `500`. The dispatcher owns the
     * 60 000 ms gate (the row's `setupCheckedAt`) and the service owns the transition, so this
     * wrapper adds nothing but the swallow — which is exactly what it should add.
     */
    private async refreshSetupPullRequest(workId: string): Promise<void> {
        try {
            await this.dispatcher.requestSetupPullRequestCheck(workId);
        } catch {
            // Deliberately swallowed: see the docstring.
        }
    }
}

/** §4.1's error body, projected from the refusal the service threw. */
function refusalBody(error: {
    code: AppUpstreamErrorCode;
    message: string;
    details?: Record<string, string>;
}): {
    status: 'error';
    code: AppUpstreamErrorCode;
    message: string;
    details?: Record<string, string>;
} {
    return {
        status: 'error',
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
    };
}
