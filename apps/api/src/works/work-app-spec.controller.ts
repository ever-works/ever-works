import {
    Body,
    Controller,
    Get,
    HttpException,
    HttpStatus,
    Optional,
    Param,
    ParseUUIDPipe,
    Post,
    Res,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerException } from '@nestjs/throttler';
import {
    APP_SPEC_FILE_MAX_BYTES,
    APP_SOURCE_SPEC_FILE,
    BLUEPRINT_APPLY_PER_HOUR,
    LICENSE_ATTEST_PER_MIN,
} from '@ever-works/contracts';
import type { LicenseAttestation } from '@ever-works/contracts';
import { AppLicenseService } from '@ever-works/agent/app-license';
import type { WorkAppSpecLinks } from '@ever-works/contracts';
import {
    AppSpecService,
    type AppSpecDraftValidation,
    type AppSpecStateRead,
} from '@ever-works/agent/app-spec';
import {
    APP_WORK_GIT_PROVIDER_ID,
    AppBlueprintUpgradeService,
    type AppBlueprintRequestOutcome,
} from '@ever-works/agent/app-works';
import { WorkOwnershipService, type WorkAccessResult } from '@ever-works/agent/services';
import { GitFacadeService } from '@ever-works/agent/facades';
import type { Work } from '@ever-works/agent/entities';
import { AuthSessionGuard, CurrentUser } from '../auth';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { requireHumanSession } from '../auth/machine-principal';
import { appLicenseAttestSessionOnly } from './app-owner-gate';
import {
    AppBlueprintApplyRequestDto,
    AppBlueprintDismissRequestDto,
    AppBlueprintRunAcceptedDto,
    AppBlueprintUpgradeRequestDto,
    AppSpecDraftValidationDto,
    AppSpecErrorDto,
    AppSpecEvaluationPendingDto,
    AppSpecValidateRequestDto,
    WorkAppSpecStateResponseDto,
    toWorkAppSpecStateResponse,
} from './dto/app-spec.dto';

/**
 * APW-03 T15 — the two App-spec routes (plan §4.1, `plan.md:547-548`).
 *
 * ```
 * GET  /api/works/:id/app-spec            view · 200 WorkAppSpecStateDto  (+ lazy head check)
 * POST /api/works/:id/app-spec/validate   view (content) / edit (branch)
 *                                         · 202 { evaluationPending: true }  — source: branch
 *                                         · 200 AppSpecDraftValidation        — source: content
 * ```
 *
 * Spec: FR-15…FR-22, FR-66…FR-70; ACC-03-08, ACC-03-13, ACC-03-14, ACC-03-41;
 * plan §2.3 (`plan.md:168-201`), §2.7:380-386, §4.1, §4.2 (`plan.md:561-574`)
 * and §6.6 (`plan.md:701-705`).
 *
 * ## The controller decides nothing that the service already decides
 *
 * Every rule behind these two routes — visibility, the coalescing window, the
 * head the evaluation reads, the validator, the five-second coalescing
 * arithmetic, the 60-second lazy-check window, `evaluationPending` — lives in
 * `AppSpecService` (T12) and the repository it writes through (T11). A second
 * copy of any of them here would be a second answer to the same question, so
 * this file holds exactly the four things that belong to HTTP:
 *
 *   1. **the two paths** (`:id/app-spec`, `:id/app-spec/validate`) and their
 *      verbs. Both are four segments deep under `api/works`, so no
 *      `works/:id/<something>` handler can shadow them — asserted in the spec
 *      against the real `WorksController` route table;
 *   2. **the two access levels §4.1 fixes** — view for the read, **edit** for
 *      `source: 'branch'` (it re-checks the tracked branch, which is a write of
 *      the Work's spec state) and view for `source: 'content'` (validating text
 *      the member is still editing changes nothing);
 *   3. **§4.2's three error answers** — `404` for a Work that does not exist, is
 *      not visible, or belongs to another account; `422 notAnAppWork`; `413
 *      file_too_large`;
 *   4. **the two throttles §4.1 fixes** — 6/min per Work for `branch`, 30/min
 *      per member for `content` — plus the route's own `@Throttle` backstop.
 *
 * ## Why the two throttles are not a `@Throttle` decorator
 *
 * `@Throttle`'s named throttlers are keyed by the guard's tracker and are fixed
 * per handler (or per tracker function), and this route needs **two different
 * limits on one handler, chosen by the body's `source`**: a per-Work bucket of 6
 * for `branch` and a per-member bucket of 30 for `content`. Two named throttlers
 * would both run on every request, so the `branch` bucket would refuse the 7th
 * *content* request of a minute — a refusal neither §4.1 nor ACC-03-08 asks for.
 * The limits are therefore taken in the handler, from `AppSpecValidateThrottle`,
 * and refused with `ThrottlerException` — the same exception, status and body the
 * platform's own `UserAwareThrottlerGuard` produces, so a client cannot tell the
 * two apart. The route also carries a `@Throttle({ long: … })` of 30/min, which
 * is the per-member ceiling both sources share: it is the outer backstop the
 * global guard enforces, and it is what bounds a caller who alternates sources.
 *
 * ## The `202` never awaits the job
 *
 * `requestEvaluation` records the request (atomically, with the sequence
 * arithmetic of plan §2.3) and hands the job to `APP_SPEC_EVALUATE_DISPATCHER`.
 * This route answers `202 { evaluationPending: true }` as soon as that has
 * happened: it never calls `evaluate`, never reads the head itself and never
 * waits for the evaluation to finish, which is what makes three presses inside
 * the five-second window one job rather than three (ACC-03-13).
 */

/* -------------------------------------------------------------------------- *
 * The two limits of plan §4.1:548
 * -------------------------------------------------------------------------- */

/** `branch` — 6 per minute **per Work** (plan §4.1:548). */
export const APP_SPEC_BRANCH_VALIDATIONS_PER_MINUTE = 6;

/** `content` — 30 per minute **per member** (plan §4.1:548, ACC-03-08). */
export const APP_SPEC_CONTENT_VALIDATIONS_PER_MINUTE = 30;

/** The window both counts are taken in — one minute, as §4.1's throttles read. */
export const APP_SPEC_VALIDATE_WINDOW_MS = 60_000;

/**
 * APW-03 T29 (lane aw-blueprints) — plan §4.1:554-556: apply and upgrade share ONE
 * bucket of `BLUEPRINT_APPLY_PER_HOUR` (5) per Work per hour (each run reads the
 * Blueprint repository and may open a pull request); dismiss is 30 per minute per member.
 */
export const APP_BLUEPRINT_RUN_WINDOW_MS = 3_600_000;
export const APP_BLUEPRINT_DISMISSALS_PER_MINUTE = 30;

/**
 * The two per-resource allowances of §4.1:548.
 *
 * A fixed window that starts at the first counted request, per key: "the 7th
 * press in a minute is refused" (ACC-03-13) and "the 31st request in a minute is
 * refused" (ACC-03-08) are both statements about a window that begins at the
 * first call, and a sliding window would admit a 31st request that a fixed one
 * refuses.
 *
 * **Bounded and in-memory, deliberately.** The map holds one entry per App Work
 * (`branch`) or per member (`content`) this process has served in the current
 * minute and is never persisted: it is a throttle, not state — the same posture
 * (and the same per-replica caveat) as the platform's own throttler, whose
 * counters are per pod unless `THROTTLER_REDIS_URL` is configured.
 * `AppSpecService`'s 60-second lazy-check window makes the equivalent choice for
 * the same reason.
 */
export class AppSpecValidateThrottle {
    private readonly windows = new Map<string, { startedAt: number; count: number }>();

    /** The clock, injectable so a spec can drive a window exactly. */
    constructor(private readonly now: () => number = Date.now) {}

    /**
     * Take one allowance from `key`'s window. `true` ⇒ this request is admitted.
     *
     * A key that has not been seen in the current window opens a new one with
     * this request as its first, so a throttle never refuses the first call
     * whatever the previous minute did.
     */
    take(key: string, limit: number, windowMs: number = APP_SPEC_VALIDATE_WINDOW_MS): boolean {
        const at = this.now();
        const window = this.windows.get(key);

        if (!window || at - window.startedAt >= windowMs) {
            this.windows.set(key, { startedAt: at, count: 1 });
            return true;
        }

        if (window.count >= limit) {
            return false;
        }

        window.count += 1;
        return true;
    }
}

/** The `@Res({ passthrough: true })` surface this controller needs — nothing else. */
interface StatusOnlyResponse {
    status(code: number): unknown;
}

@ApiTags('Works')
@ApiBearerAuth('JWT-auth')
@Controller('api/works')
@UseGuards(AuthSessionGuard)
export class WorkAppSpecController {
    /** One instance per controller (i.e. per process), shared by both routes. */
    private readonly throttle = new AppSpecValidateThrottle();

    constructor(
        private readonly ownership: WorkOwnershipService,
        private readonly appSpec: AppSpecService,
        /** The provider read the `links.file` block is built from (plan §4.3:578). */
        private readonly git: GitFacadeService,
        /**
         * APW-03 T44 — the attestation record's one writer. Appended LAST and
         * `@Optional()` so every positional construction in the specs keeps
         * compiling; absent, the attest route answers `503 licenseUnavailable`.
         */
        @Optional()
        private readonly licenses?: AppLicenseService,
        /**
         * APW-03 T29 (lane aw-blueprints) — the Blueprint apply / upgrade / dismiss
         * service (bound in the agent `AppWorksModule`, which `WorksModule` imports).
         * Appended LAST and `@Optional()` for the same reason as `licenses`; absent, the
         * three Blueprint routes answer `503 dependenciesUnavailable`.
         */
        @Optional()
        private readonly blueprints?: AppBlueprintUpgradeService,
    ) {}

    /**
     * `POST /api/works/:id/app-spec/blueprint` — apply a Blueprint to an App Work that has
     * none (plan §4.1:554, FR-45/46). **Edit** access. The run three-way merges the
     * Blueprint into the Work's own `.works/works.yml` (an empty base, so nothing of the
     * member's is overwritten) and proposes the result as ONE pull request — never a push.
     * Answers `202` as soon as the run is queued, never after it.
     */
    @Post(':id/app-spec/blueprint')
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Apply a Blueprint to an App Work (edit)',
        description:
            'Queues the `app-blueprint-apply` run and answers 202 without waiting for it. The run opens one pull ' +
            'request on `ever-works/blueprint/<id>`; nothing is pushed to the tracked branch. Errors: 404 ' +
            'blueprintNotFound / blueprintVersionNotFound, 409 applyInProgress / blueprintAlreadyApplied, 422 ' +
            'notAnAppWork, 429 past 5 runs per hour per App Work, 503 catalogUnavailable.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 202, type: AppBlueprintRunAcceptedDto })
    @ApiResponse({
        status: 200,
        description: 'An open proposal already exists.',
        type: AppBlueprintRunAcceptedDto,
    })
    @ApiResponse({ status: 404, type: AppSpecErrorDto })
    @ApiResponse({ status: 409, type: AppSpecErrorDto })
    @ApiResponse({ status: 422, type: AppSpecErrorDto })
    async applyBlueprint(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: AppBlueprintApplyRequestDto,
        @Res({ passthrough: true }) response: StatusOnlyResponse,
    ): Promise<AppBlueprintRunAcceptedDto> {
        await this.authorize(id, auth.userId, 'edit');
        const blueprints = this.requireBlueprints();
        this.takeAllowance(
            `blueprint:${id}`,
            BLUEPRINT_APPLY_PER_HOUR,
            APP_BLUEPRINT_RUN_WINDOW_MS,
        );
        const outcome = await blueprints.request({
            workId: id,
            userId: auth.userId,
            mode: 'apply',
            blueprintId: dto.blueprintId,
            version: dto.version ? dto.version.replace(/^v/, '') : null,
        });
        return this.answerRun(outcome, response);
    }

    /**
     * `POST /api/works/:id/app-spec/blueprint/upgrade` — review an upgrade to a newer
     * Blueprint version (plan §4.1:555, FR-50/51, ACC-03-29). **Edit** access. `202` when the
     * run is queued, `200` with the open pull request when one already proposes that
     * version. A newer version later UPDATES that pull request rather than opening a second.
     */
    @Post(':id/app-spec/blueprint/upgrade')
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Propose a Blueprint upgrade as a pull request (edit)',
        description:
            'Three-way merges the applied Blueprint version, the App Work file and the new version: a value the ' +
            'member changed is never overwritten — a conflict keeps it and is listed in the pull request. Errors: 422 ' +
            'noBlueprint / noUpgrade / notAnAppWork, 404 blueprintVersionNotFound, 409 applyInProgress, 429 past 5 ' +
            'runs per hour per App Work.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 202, type: AppBlueprintRunAcceptedDto })
    @ApiResponse({
        status: 200,
        description: 'The open pull request for that version.',
        type: AppBlueprintRunAcceptedDto,
    })
    @ApiResponse({ status: 404, type: AppSpecErrorDto })
    @ApiResponse({ status: 409, type: AppSpecErrorDto })
    @ApiResponse({ status: 422, type: AppSpecErrorDto })
    async upgradeBlueprint(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: AppBlueprintUpgradeRequestDto,
        @Res({ passthrough: true }) response: StatusOnlyResponse,
    ): Promise<AppBlueprintRunAcceptedDto> {
        await this.authorize(id, auth.userId, 'edit');
        const blueprints = this.requireBlueprints();
        this.takeAllowance(
            `blueprint:${id}`,
            BLUEPRINT_APPLY_PER_HOUR,
            APP_BLUEPRINT_RUN_WINDOW_MS,
        );
        const outcome = await blueprints.request({
            workId: id,
            userId: auth.userId,
            mode: 'upgrade',
            version: dto?.version ? dto.version.replace(/^v/, '') : null,
        });
        return this.answerRun(outcome, response);
    }

    /**
     * `POST /api/works/:id/app-spec/blueprint/dismiss` — hide the upgrade notice for ONE
     * version (plan §4.1:556, FR-50). **Edit** access, 30 per minute per member. A newer
     * version raises the notice again.
     */
    @Post(':id/app-spec/blueprint/dismiss')
    @Throttle({ long: { limit: APP_BLUEPRINT_DISMISSALS_PER_MINUTE, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Dismiss a Blueprint upgrade notice for one version (edit)',
        description: 'Errors: 422 noBlueprint / noUpgrade / notAnAppWork, 404 not_found.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: '`{ status: "dismissed", version }`.' })
    @ApiResponse({ status: 422, type: AppSpecErrorDto })
    async dismissBlueprintUpgrade(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: AppBlueprintDismissRequestDto,
        @Res({ passthrough: true }) response: StatusOnlyResponse,
    ): Promise<{ status: 'dismissed'; version: string }> {
        await this.authorize(id, auth.userId, 'edit');
        const blueprints = this.requireBlueprints();
        this.takeAllowance(`dismiss:${auth.userId}`, APP_BLUEPRINT_DISMISSALS_PER_MINUTE);
        const outcome = await blueprints.dismiss({
            workId: id,
            userId: auth.userId,
            version: dto.version.replace(/^v/, ''),
        });
        if (outcome.status === 'refused') {
            throw this.refusal(outcome.code, outcome.message, outcome.httpStatus);
        }
        response.status(HttpStatus.OK);
        return outcome;
    }

    /**
     * `POST /api/works/:id/app-license/attest` — the OWNER attests the App Work's
     * current licence classification (APW-03 T44, R-3, FR-57…FR-60).
     *
     * The caller must see the Work (`404 not_found` otherwise, ACC-03-41), must be its
     * owner (`403 ownerOnly` — a manager included, ACC-03-34), the licence must need an
     * attestation (`422 attestationNotRequired`), and — when the body names the
     * classification the caller reviewed — it must still be current (`409
     * licenseChanged`). 10 per minute per member.
     *
     * Works-security (2026-10-18): an attestation is a person's statement, so while
     * `APP_LICENSE_ATTEST_SESSION_ONLY` is on (the default) it is taken only from a signed-in
     * session — never from the owner's personal API key, a fleet run or an integration key,
     * which is how every other attestation and approval on the platform already works.
     */
    @Post(':id/app-license/attest')
    @ApiOperation({
        summary: 'Attest an App Work’s licence (owner only)',
        description:
            'Records the owner’s attestation for the current amber, red or unknown licence classification, ' +
            'which your-cluster deploys require. Errors: 403 ownerOnly, 409 licenseChanged, ' +
            '422 attestationNotRequired, 404 not_found.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'The attestation record.' })
    @ApiResponse({ status: 403, description: '`ownerOnly` — only the owner may attest.' })
    @ApiResponse({ status: 404, description: '`not_found`.' })
    @ApiResponse({ status: 409, description: '`licenseChanged` — the classification moved.' })
    @ApiResponse({ status: 422, description: '`attestationNotRequired`.' })
    async attestLicense(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: { spdx?: string | null; class?: string | null } = {},
    ): Promise<{ attestation: LicenseAttestation }> {
        await this.authorize(id, auth.userId, 'view');
        if (appLicenseAttestSessionOnly()) requireHumanSession(auth, 'attest an App licence');
        this.takeAllowance(`attest:${auth.userId}`, LICENSE_ATTEST_PER_MIN);
        if (!this.licenses) {
            throw new HttpException(
                {
                    status: 'error',
                    code: 'licenseUnavailable',
                    message: 'The licence service is not available in this installation.',
                },
                HttpStatus.SERVICE_UNAVAILABLE,
            );
        }
        const expected =
            body && (body.spdx !== undefined || body.class !== undefined)
                ? {
                      ...(body.spdx !== undefined ? { spdx: body.spdx } : {}),
                      ...(body.class !== undefined ? { class: body.class } : {}),
                  }
                : undefined;
        const attestation = await this.licenses.attest(id, auth.userId, expected);
        return { attestation };
    }

    /**
     * `GET /api/works/:id/app-spec` — the App spec state of one App Work
     * (plan §4.1:547), plus FR-19(d)'s lazy head check.
     *
     * Any member may read it (view). The lazy check is the service's: **at most
     * one evaluation per 60 s per Work, with exactly one `getLatestCommit` read**
     * (ACC-03-14), and it can never turn the read into an error — a provider that
     * will not answer leaves the stored state to speak for itself.
     */
    @Get(':id/app-spec')
    @ApiOperation({
        summary: 'Read one App Work’s App spec state',
        description:
            'The whole App spec tab in one answer: the head reading, the validation status and its problems, ' +
            'the effective spec, the Blueprint and licence columns, whether an evaluation is pending, and the ' +
            'file link the problems list builds from. Opening this route checks the tracked branch’s head at ' +
            'most once a minute per App Work, and schedules an evaluation when the head moved (ACC-03-14); ' +
            'the answer never waits for that evaluation. A Work that does not exist, is not kind `app`, or ' +
            'is not visible to the caller answers `404 not_found` — the same answer for all three, so the ' +
            'route can never be used to discover whose Work is whose (ACC-03-41).',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({
        status: 200,
        description: '`WorkAppSpecStateDto` — the state minus the internal sequence columns.',
        type: WorkAppSpecStateResponseDto,
    })
    @ApiResponse({ status: 401, description: 'No session.' })
    @ApiResponse({
        status: 404,
        description:
            '`{ status: "error", code: "not_found", message: "Work <id> not found." }` — the Work is ' +
            'missing, not visible to the caller, or another account’s; or, for a visible App Work, ' +
            '`"Work <id> has no App spec state yet."` when no state row exists.',
        type: AppSpecErrorDto,
    })
    @ApiResponse({
        status: 422,
        description:
            '`{ status: "error", code: "notAnAppWork", message }` — the Work is visible but its kind is ' +
            'not `app`, so it has no App spec.',
        type: AppSpecErrorDto,
    })
    async getAppSpec(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<WorkAppSpecStateResponseDto> {
        const { work } = await this.authorize(id, auth.userId, 'view');

        const state: AppSpecStateRead = await this.appSpec.getState(id);
        if (!state.state) {
            // A visible App Work with no state row: APW-01 initializes one with
            // the Work, so its absence means the Work predates that path or the
            // row was removed. There is nothing to render, so the answer is the
            // sibling epic's (`app-upstream-state.service.ts:1381-1388`): 404 —
            // never a synthesized state the database does not hold.
            throw this.notFound(`Work ${id} has no App spec state yet.`);
        }

        return toWorkAppSpecStateResponse(state.state, {
            evaluationPending: state.evaluationPending,
            // The commit the link points at is the head **this read** saw: the
            // one an evaluation stored, or — before the first evaluation lands —
            // the one FR-19(d)'s lazy check just read. Either way the link is
            // useful on the first paint rather than only after the job finishes.
            links: await this.fileLinks(
                work,
                state.state.headCommitSha ?? state.lazyCheck.headCommitSha ?? null,
            ),
        });
    }

    /**
     * `POST /api/works/:id/app-spec/validate` — Re-check, or a draft validation
     * (plan §4.1:548).
     *
     * `{ source: 'branch' }` (edit) records a `manual` evaluation request and
     * answers `202 { evaluationPending: true }` **without awaiting the job**
     * (ACC-03-13). `{ source: 'content', content }` (view) validates the text in
     * memory and answers `200` with the verdict, **storing nothing** (ACC-03-08).
     *
     * Two statuses on one handler, so the status is set explicitly rather than
     * with `@HttpCode` — the decorator would fix one answer for both sources
     * (the same reason `shared-views.controller.ts:108-115` sets its own).
     */
    @Post(':id/app-spec/validate')
    @Throttle({
        long: { limit: APP_SPEC_CONTENT_VALIDATIONS_PER_MINUTE, ttl: APP_SPEC_VALIDATE_WINDOW_MS },
    })
    @ApiOperation({
        summary: 'Re-check an App Work’s spec, or validate a draft',
        description:
            '`{ source: "branch" }` requests an evaluation of the tracked branch and answers as soon as the ' +
            'request is recorded — `202 { evaluationPending: true }`, never after the job has run. Three ' +
            'presses inside the five-second window coalesce into the one job already on its way (ACC-03-13). ' +
            '`{ source: "content", content }` validates the text in the request in `draft` mode and answers ' +
            '`200 { status, issues, truncated, … }`, storing nothing at all (ACC-03-08). Throttled at 6 per ' +
            'minute per Work for `branch` and 30 per minute per member for `content`; a `content` larger ' +
            'than 256 KiB is refused with `413 file_too_large` before any allowance is taken.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({
        status: 202,
        description:
            '`source: "branch"` — `{ evaluationPending: true }`. The evaluation is queued or already on ' +
            'its way; this answer does not wait for it.',
        type: AppSpecEvaluationPendingDto,
    })
    @ApiResponse({
        status: 200,
        description:
            '`source: "content"` — the validator’s verdict on the text in the request. Nothing is stored: ' +
            'no state write, no Activity row, no provider call.',
        type: AppSpecDraftValidationDto,
    })
    @ApiResponse({ status: 401, description: 'No session.' })
    @ApiResponse({
        status: 404,
        description:
            '`{ status: "error", code: "not_found", message: "Work <id> not found." }` — the Work is ' +
            'missing, not visible to the caller, or another account’s (ACC-03-41); or ' +
            '`"Work <id> has no App spec state yet."` when a visible App Work has no state row for the ' +
            'request to be recorded against — `202` is only ever answered for a request that was recorded.',
        type: AppSpecErrorDto,
    })
    @ApiResponse({
        status: 413,
        description:
            '`{ status: "error", code: "file_too_large", message }` — `content` is larger than 256 KiB ' +
            '(`APP_SPEC_FILE_MAX_BYTES`). Nothing is validated and nothing is stored.',
        type: AppSpecErrorDto,
    })
    @ApiResponse({
        status: 422,
        description:
            '`{ status: "error", code: "notAnAppWork", message }` — the Work is visible but its kind is ' +
            'not `app`, so it has no App spec to re-check or validate against.',
        type: AppSpecErrorDto,
    })
    @ApiResponse({
        status: 429,
        description:
            'Throttled. Nest’s own body: the 7th `branch` press inside a minute for one Work, the 31st ' +
            '`content` request inside a minute by one member, or the route’s 30-per-minute `long` tier.',
    })
    async validateAppSpec(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: AppSpecValidateRequestDto,
        @Res({ passthrough: true }) response: StatusOnlyResponse,
    ): Promise<AppSpecDraftValidation | AppSpecEvaluationPendingDto> {
        const branch = dto.source === 'branch';

        // `branch` re-checks the tracked branch — a write of the Work's spec
        // state, so edit; `content` validates text the member holds and changes
        // nothing, so view.
        const { work } = await this.authorize(id, auth.userId, branch ? 'edit' : 'view');

        if (!branch) {
            const content = dto.content as string;

            // §4.2's 413, measured on the bytes the validator would read. Checked
            // before the allowance so a request that can never be served consumes
            // none — and before the validator, so a 256 KiB+ document never
            // reaches it.
            if (Buffer.byteLength(content, 'utf8') > APP_SPEC_FILE_MAX_BYTES) {
                throw new HttpException(
                    {
                        status: 'error',
                        code: 'file_too_large',
                        message: `The App spec is larger than ${APP_SPEC_FILE_MAX_BYTES} bytes (256 KiB).`,
                    },
                    HttpStatus.PAYLOAD_TOO_LARGE,
                );
            }

            this.takeAllowance(`content:${auth.userId}`, APP_SPEC_CONTENT_VALIDATIONS_PER_MINUTE);
            response.status(HttpStatus.OK);

            // A read: `validateDraft` runs the validator in `draft` mode and
            // writes nothing anywhere (ACC-03-08).
            return this.appSpec.validateDraft(id, content);
        }

        this.takeAllowance(`branch:${id}`, APP_SPEC_BRANCH_VALIDATIONS_PER_MINUTE);
        response.status(HttpStatus.ACCEPTED);

        // The enqueue is awaited (so a queue outage cannot leave an unhandled
        // rejection behind); the evaluation is not — this call returns the
        // moment the request is recorded.
        const requested = await this.appSpec.requestEvaluation(id, 'manual', {
            tenantId: work.tenantId ?? null,
            organizationId: work.organizationId ?? null,
            providerId: work.gitProvider || APP_WORK_GIT_PROVIDER_ID,
        });

        // 🛑 `202 { evaluationPending: true }` is a claim that the request was
        // recorded. When there is no state row to record it against — the same
        // condition the read answers `404` for — answering `202` would say an
        // evaluation is pending that nothing holds, so the refusal is the read's
        // own (T12's `requested: false`, `reason: 'work_not_found'`).
        if (!requested.requested) {
            throw this.notFound(`Work ${id} has no App spec state yet.`);
        }

        return { evaluationPending: true };
    }

    // ────────────────────────────────────────────────────────────────────────
    // The two gates §4.2 fixes
    // ────────────────────────────────────────────────────────────────────────

    /**
     * The Work behind one request, the access level §4.1 requires, and §4.2's
     * two answers.
     *
     * **One `404` for every way a Work can be out of reach.** `ensureCanView` /
     * `ensureCanEdit` answer `NotFoundException` for a Work that does not exist
     * and `ForbiddenException` for one the caller is not a member of; §4.2 has a
     * single row for "work not visible to the caller", and ACC-03-41 requires
     * another account's Work id to answer not found on **every** endpoint — so
     * both are translated to the same `404`, and no caller can tell "not yours"
     * from "does not exist".
     *
     * `422 notAnAppWork` follows the access check, never precedes it: a stranger
     * asking about somebody else's `website` Work must learn nothing, and
     * "not an App Work" is information about a Work they can already see.
     */
    private async authorize(
        workId: string,
        userId: string,
        need: 'view' | 'edit',
    ): Promise<WorkAccessResult> {
        let access: WorkAccessResult;
        try {
            access =
                need === 'edit'
                    ? await this.ownership.ensureCanEdit(workId, userId)
                    : await this.ownership.ensureCanView(workId, userId);
        } catch (error) {
            if (error instanceof HttpException) {
                const status = error.getStatus();
                if (status === HttpStatus.NOT_FOUND || status === HttpStatus.FORBIDDEN) {
                    throw this.notFound(`Work ${workId} not found.`);
                }
            }
            throw error;
        }

        if (access.work.kind !== 'app') {
            throw new HttpException(
                {
                    status: 'error',
                    code: 'notAnAppWork',
                    message: `Work ${workId} is not an App Work, so it has no App spec.`,
                },
                HttpStatus.UNPROCESSABLE_ENTITY,
            );
        }

        return access;
    }

    /** §4.2's `404`, as the one body every not-found answer of these routes uses. */
    private notFound(message: string): HttpException {
        return new HttpException(
            { status: 'error', code: 'not_found', message },
            HttpStatus.NOT_FOUND,
        );
    }

    /** Take one allowance of `key`'s window, or answer the platform's own `429`. */
    private takeAllowance(key: string, limit: number, windowMs?: number): void {
        if (!this.throttle.take(key, limit, windowMs)) {
            throw new ThrottlerException();
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // APW-03 T29 — the Blueprint routes' answers
    // ────────────────────────────────────────────────────────────────────────

    private requireBlueprints(): AppBlueprintUpgradeService {
        if (!this.blueprints) {
            throw this.refusal(
                'dependenciesUnavailable',
                'Blueprint apply and upgrade are not available in this installation.',
                HttpStatus.SERVICE_UNAVAILABLE,
            );
        }
        return this.blueprints;
    }

    /** §4.2's body for every refusal: `{ status: 'error', code, message }`. */
    private refusal(code: string, message: string, status: number): HttpException {
        return new HttpException({ status: 'error', code, message }, status);
    }

    /** `202` queued · `200` an open proposal · the refusal's own status otherwise. */
    private answerRun(
        outcome: AppBlueprintRequestOutcome,
        response: StatusOnlyResponse,
    ): AppBlueprintRunAcceptedDto {
        if (outcome.status === 'refused') {
            throw this.refusal(outcome.code, outcome.message, outcome.httpStatus);
        }
        if (outcome.status === 'existing') {
            response.status(HttpStatus.OK);
            return {
                status: 'existing',
                mode: outcome.mode,
                blueprintId: outcome.blueprintId,
                version: outcome.version,
                pullRequest: outcome.pullRequest,
            };
        }
        response.status(HttpStatus.ACCEPTED);
        return {
            status: 'queued',
            mode: outcome.mode,
            blueprintId: outcome.blueprintId,
            version: outcome.version,
            runId: outcome.runId,
            ...(outcome.mode === 'apply' ? { applyStatus: 'applying' as const } : {}),
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // The file link (plan §4.3:578-580)
    // ────────────────────────────────────────────────────────────────────────

    /**
     * The `links` block of the DTO: where `.works/works.yml` can be opened and
     * the provider's line-anchor hint.
     *
     * Plan §4.3:578-580 asks the **provider** for the URL
     * (`git.getFileWebUrl(owner, repo, commitSha, path)`, plan §7:720), so no URL
     * shape is assembled by the web app. That provider method arrives with T22;
     * until it does, the block carries what the facade can answer **today** —
     * the repository's own web URL — and upgrades itself the moment the method
     * exists. The check is duck-typed on purpose, exactly as `AppSpecService`
     * checks its dispatcher, because a facade that predates a capability must
     * degrade to a usable link rather than fail a readable page.
     *
     * A provider that will not answer at all (no credential, no registered
     * plugin, a thrown read) leaves `base` empty rather than turning the App spec
     * tab into a `500`: the state, the problems and the verdict are what the page
     * is for, and the link is an affordance on top of them.
     */
    private async fileLinks(work: Work, commitSha: string | null): Promise<WorkAppSpecLinks> {
        const owner = work.getRepoOwner('website');
        const repo = work.getWebsiteRepo();
        const providerId = work.gitProvider || APP_WORK_GIT_PROVIDER_ID;

        // The facade as this controller needs it: T22's method when the bound
        // build has it, the repository URL otherwise.
        const facade = this.git as unknown as {
            getFileWebUrl?: (
                owner: string,
                repo: string,
                ref: string,
                path: string,
            ) =>
                | Promise<{ url?: string; lineAnchor?: string } | null>
                | { url?: string; lineAnchor?: string }
                | null;
            getWebUrl?: (
                providerId: string,
                owner: string,
                repo: string,
            ) => Promise<string> | string;
        };

        let base = '';
        let lineAnchor: string | null = null;

        try {
            if (commitSha && typeof facade.getFileWebUrl === 'function') {
                const file = await facade.getFileWebUrl(
                    owner,
                    repo,
                    commitSha,
                    APP_SOURCE_SPEC_FILE,
                );
                base = file?.url ?? '';
                lineAnchor = file?.lineAnchor ?? null;
            } else if (typeof facade.getWebUrl === 'function') {
                base = (await facade.getWebUrl(providerId, owner, repo)) ?? '';
            }
        } catch {
            // Deliberately swallowed — see the docstring. The block keeps an
            // empty `base`, and `buildAppSpecLineLink` then links to nothing
            // rather than to a broken URL.
        }

        return {
            file: { base, commitSha, path: APP_SOURCE_SPEC_FILE },
            lineAnchor,
        };
    }
}
