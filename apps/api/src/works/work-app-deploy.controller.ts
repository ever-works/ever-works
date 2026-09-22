import {
    Body,
    Controller,
    HttpException,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Res,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
    AppDeployRequestService,
    type AppDeployRequestResult,
} from '@ever-works/agent/app-runtime';
import { WorkOwnershipService, type WorkAccessResult } from '@ever-works/agent/services';
import { AuthSessionGuard, CurrentUser } from '../auth';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { AppDeployRequestDto, AppDeployResponseDto } from './dto/app-deploy.dto';

/**
 * APW-06 §2.2 — `POST /api/works/:id/deploy`, the App Work deploy request.
 *
 * ```
 * POST /api/works/:id/deploy   edit · 202 { deploymentId, status }
 *                                   · 409 APP_DEPLOY_IN_PROGRESS
 *                                   · 422 APP_DEPLOY_PRECONDITIONS | worker_not_isolated
 * ```
 *
 * ## Why this is a new route and not the existing deploy one
 *
 * The platform already has `POST /api/deploy/works/:id`, and plan §12's own
 * drift note records the mismatch: CONTRACTS §4 calls the App route
 * `POST /api/works/:id/deploy` and the existing one lives elsewhere. They are
 * genuinely different requests, not two spellings of one:
 *
 *   - the existing route resolves a **website** deploy provider, checks that the
 *     member has configured its credentials and validates the token, all before
 *     `DeployService.deploy` is reached. An App Work deploys to a Kubernetes
 *     cluster through `work_app_runtime_states.targetSettings`, has no such
 *     provider token, and would be refused at the first check;
 *   - it answers `200` synchronously. This one answers **`202`**: §2.2 gives the
 *     dispatch a 2 s budget and the Deployment runs on the isolated worker.
 *
 * So the App path gets its own route, at the path CONTRACTS §4 already names,
 * and the website path is left exactly as it was.
 *
 * ## The controller decides nothing the service already decides
 *
 * Every rule behind this route — the isolated-worker gate, the preconditions,
 * the atomic lock claim, the latest-wins queue, the dedupe, the 2 s dispatch
 * budget — lives in `AppDeployRequestService` (T24) and the preconditions pass
 * it calls (T21). A second copy of any of them here would be a second answer to
 * the same question, so this file holds exactly the three things that belong to
 * HTTP:
 *
 *   1. **the path and the verb**, four segments deep under `api/works` so no
 *      `works/:id/<something>` handler can shadow it;
 *   2. **the access level** — `edit`, because a Deployment changes what the
 *      Work serves. A Work that does not exist, is not visible, or belongs to
 *      another account answers the same `404`, so the route cannot be used to
 *      discover whose Work is whose; a visible non-App Work answers
 *      `422 notAnAppWork`;
 *   3. **the status mapping** — `result.httpStatus` verbatim. The service
 *      chooses it precisely so the route does not have to re-derive a status
 *      from a code, which is how the two would drift apart.
 *
 * ## `userId` is the CALLER, not the owner
 *
 * The existing website route deploys as the Work's owner when an editor asks,
 * because it needs that member's provider token. This route needs no token: the
 * cluster credential belongs to the Work. So the Deployment records who actually
 * pressed the button, which is what FR-23's `manual` trigger and the Activity
 * row are for.
 */
@ApiTags('Works')
@ApiBearerAuth('JWT-auth')
@Controller('api/works')
@UseGuards(AuthSessionGuard)
export class WorkAppDeployController {
    constructor(
        private readonly ownership: WorkOwnershipService,
        private readonly deployRequest: AppDeployRequestService,
    ) {}

    /**
     * `POST /api/works/:id/deploy` — ask for a Deployment of one App Work.
     *
     * Answers for every outcome, including a refusal, because that is what
     * `request()` does: it resolves with an `httpStatus` and a `code` for each
     * one rather than throwing, so the member is told what to fix instead of
     * being shown a 500.
     *
     * The status is set on the response object rather than with `@HttpCode`,
     * because one handler has four of them (`202`, `409`, `422`, `503`) and the
     * decorator would fix a single answer for all of them.
     */
    @Post(':id/deploy')
    @ApiOperation({
        summary: 'Deploy one App Work',
        description:
            'Evaluates the preconditions that need no cluster, claims the deploy lock, creates the ' +
            'Deployment row and dispatches it to the isolated App cluster worker. Answers `202` with the ' +
            'Deployment id as soon as the dispatch is accepted — never waits for the rollout. A second ' +
            'request while one is running is queued (latest wins) or refused `409` with the running ' +
            'Deployment’s id. Unmet preconditions answer `422` with the full list, and a process with no ' +
            'attested isolated worker answers `422 worker_not_isolated` having created nothing.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({
        status: 202,
        description: 'The Deployment was created and dispatched, or queued behind a running one.',
        type: AppDeployResponseDto,
    })
    @ApiResponse({ status: 401, description: 'No session.' })
    @ApiResponse({
        status: 404,
        description:
            'The Work is missing, not visible to the caller, or another account’s — one answer for all three.',
    })
    @ApiResponse({
        status: 409,
        description: '`APP_DEPLOY_IN_PROGRESS` — another Deployment holds the lock.',
        type: AppDeployResponseDto,
    })
    @ApiResponse({
        status: 422,
        description:
            '`notAnAppWork`, `APP_DEPLOY_PRECONDITIONS` with the unmet list, or `worker_not_isolated`.',
        type: AppDeployResponseDto,
    })
    async deploy(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: AppDeployRequestDto,
        @Res({ passthrough: true }) response: StatusOnlyResponse,
    ): Promise<AppDeployResponseDto> {
        await this.authorize(id, auth.userId);

        const result: AppDeployRequestResult = await this.deployRequest.request({
            workId: id,
            // The caller, not the owner — see the class docstring.
            userId: auth.userId,
            trigger: 'manual',
            ...(body?.buildId ? { buildId: String(body.buildId) } : {}),
            ...(body?.confirmClusterChange === true ? { confirmClusterChange: true } : {}),
        });

        // The service's own status, verbatim. Re-deriving one from `code` here is
        // how a route and a service start disagreeing about what a refusal means.
        response.status(result.httpStatus);

        return {
            status: result.status,
            code: result.code,
            deploymentId: result.deploymentId,
            queuedDeploymentId: result.queuedDeploymentId,
            runningDeploymentId: result.runningDeploymentId,
            dispatched: result.dispatched,
            deduplicated: result.deduplicated,
            unmet: result.unmet.map((entry) => ({
                code: String(entry?.code ?? ''),
                message: String(entry?.message ?? ''),
            })),
            advisory: result.advisory.map((entry) => ({
                code: String(entry?.code ?? ''),
                message: String(entry?.message ?? ''),
            })),
            warnings: result.warnings.map((entry) => ({
                code: String(entry?.code ?? ''),
                message: String(entry?.message ?? ''),
            })),
        };
    }

    /**
     * Edit access to a visible App Work, or the one refusal each failure gets.
     *
     * `404` for missing, invisible and another account's alike — the same
     * posture `work-app-spec.controller.ts:408` takes, and for the same reason:
     * three different answers would make the route a way to discover whose Work
     * is whose.
     */
    private async authorize(workId: string, userId: string): Promise<WorkAccessResult> {
        let access: WorkAccessResult;
        try {
            access = await this.ownership.ensureCanEdit(workId, userId);
        } catch (error) {
            if (error instanceof HttpException) {
                const status = error.getStatus();
                if (status === HttpStatus.NOT_FOUND || status === HttpStatus.FORBIDDEN) {
                    throw new HttpException(
                        {
                            status: 'error',
                            code: 'not_found',
                            message: `Work ${workId} not found.`,
                        },
                        HttpStatus.NOT_FOUND,
                    );
                }
            }
            throw error;
        }

        if (access.work.kind !== 'app') {
            throw new HttpException(
                {
                    status: 'error',
                    code: 'notAnAppWork',
                    message: `Work ${workId} is not an App Work, so it has nothing to deploy this way.`,
                },
                HttpStatus.UNPROCESSABLE_ENTITY,
            );
        }

        return access;
    }
}

/** The `@Res({ passthrough: true })` surface this controller needs — nothing else. */
interface StatusOnlyResponse {
    status(code: number): unknown;
}
