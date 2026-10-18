import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpException,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Put,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    AppBuildPullTokenService,
    AppBuildsService,
    toAppBuildSummary,
} from '@ever-works/agent/app-builds';
import { config } from '@ever-works/agent/config';
import { WorkOwnershipService, type WorkAccessResult } from '@ever-works/agent/services';
import type {
    AppBuildApiError,
    AppBuildApiErrorCode,
    AppBuildCancelResponse,
    AppBuildDetail,
    AppBuildListQuery,
    AppBuildListResponse,
    AppBuildPullTokenResponse,
    AppBuildRequestResponse,
    AppBuildStatus,
    AppBuildTrigger,
} from '@ever-works/contracts';
import { AuthSessionGuard, CurrentUser } from '../auth';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import {
    CreateAppBuildDto,
    ListAppBuildsQueryDto,
    SaveAppBuildPullTokenDto,
} from './dto/app-builds.dto';

/**
 * APW-05 T23 — the Builds routes (plan §5), `api/works/:id/builds`.
 *
 * ```
 * GET  /api/works/:id/builds                   view · 200 AppBuildListResponse
 * GET  /api/works/:id/builds/:buildId          view · 200 AppBuildDetail          · 404 buildNotFound
 * POST /api/works/:id/builds                   edit · 202 { build, deduped }      · 429 rebuildRateLimited
 *                                                      · 422 commitNotReachable | nothingToBuild
 *                                                      · 503 buildProviderUnavailable
 * POST /api/works/:id/builds/:buildId/cancel   edit · 202 { build }               · 409 notCancellable · 404 buildNotFound
 * PUT  /api/works/:id/builds/pull-token        edit · 202 { pullAccess, expiresInDays }
 *                                                      · 422 pullToken{TooBroad,FineGrained,CannotRead,PublicImage}
 *                                                      · 409 pullTokenNoImageYet · 503 pullTokenUnavailable
 * ```
 *
 * ## Access, and one answer for "not yours"
 *
 * `WorkOwnershipService` decides: a Work that does not exist, is not visible to
 * the caller, or is another account's answers the same `404` on every route, so
 * the routes cannot be used to discover whose Work is whose (ACC-05-24). A
 * visible Work of another kind is `404 notAppWork` (plan §5). A Work the caller
 * can SEE but not edit is `403 editAccessRequired` on the three writing routes.
 * A Build id that belongs to another Work is `404 buildNotFound` — the service
 * reads it scoped to the Work id.
 *
 * ## The feature switch
 *
 * With `EVER_WORKS_APP_WORKS_ENABLED` off every route answers
 * `404 appWorksDisabled` before any database read: there are no App Builds on an
 * installation that cannot have App Works.
 *
 * ## The controller decides nothing the service decides
 *
 * The dedupe, the hourly limit, the cancel rules, the pull-token checks and the
 * verdict all live in `AppBuildsService` / `AppBuildPullTokenService`. This file
 * holds the path, the access level and the status mapping. The pull token is
 * never echoed and never logged.
 */
@ApiTags('Builds')
@ApiBearerAuth('JWT-auth')
@Controller('api/works')
@UseGuards(AuthSessionGuard)
export class AppBuildsController {
    constructor(
        private readonly ownership: WorkOwnershipService,
        private readonly builds: AppBuildsService,
        private readonly pullTokens: AppBuildPullTokenService,
    ) {}

    /** `GET /api/works/:id/builds` — one page of Builds plus the provider/workflow/pull facts. */
    @Get(':id/builds')
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary: "List an App Work's Builds",
        description:
            'One page of Builds, newest first, with the resolved build provider, the repository, the ' +
            'image repository, the workflow state and the pull-token facts (never the token).',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'The page.' })
    @ApiResponse({
        status: 404,
        description: 'Missing, invisible, not an App Work, or App Works off.',
    })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: ListAppBuildsQueryDto,
    ): Promise<AppBuildListResponse> {
        await this.authorize(id, auth.userId, 'view');
        const listQuery: AppBuildListQuery = {
            ...(query?.page !== undefined ? { page: query.page } : {}),
            ...(query?.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
            ...(query?.status ? { status: splitList<AppBuildStatus>(query.status) } : {}),
            ...(query?.trigger ? { trigger: splitList<AppBuildTrigger>(query.trigger) } : {}),
            ...(query?.branch ? { branch: query.branch } : {}),
            ...(query?.pullRequest !== undefined ? { pullRequest: query.pullRequest } : {}),
        };
        return this.builds.listForWork(id, listQuery, auth.userId);
    }

    /**
     * `PUT /api/works/:id/builds/pull-token` — save and validate the GHCR pull token.
     *
     * Declared before the `:buildId` routes so no parameterised route can shadow
     * the literal segment.
     */
    @Put(':id/builds/pull-token')
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 10, ttl: 3_600_000 } })
    @ApiOperation({
        summary: 'Save the registry pull token of an App Work',
        description:
            'Checks the token against the newest pushed image and stores it encrypted. Answers the ' +
            'pull access facts — never the token.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 202, description: 'Stored.' })
    @ApiResponse({ status: 403, description: '`editAccessRequired` — a viewer.' })
    @ApiResponse({ status: 409, description: '`pullTokenNoImageYet`.' })
    @ApiResponse({
        status: 422,
        description:
            '`pullTokenTooBroad` · `pullTokenFineGrained` · `pullTokenCannotRead` · `pullTokenPublicImage`.',
    })
    @ApiResponse({ status: 503, description: '`pullTokenUnavailable`.' })
    async savePullToken(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: SaveAppBuildPullTokenDto,
    ): Promise<AppBuildPullTokenResponse> {
        await this.authorize(id, auth.userId, 'edit');

        const result = await this.pullTokens.save(id, auth.userId, String(body?.token ?? ''));
        if (result.ok === false) {
            throw refusal(result.code, result.status, pullTokenMessage(result.code));
        }

        // The service's answer carries no token; only the three public facts and
        // the FR-51 warning window leave this route.
        return {
            pullAccess: {
                visibility: result.pullAccess.visibility,
                tokenSet: result.pullAccess.tokenSet,
                tokenExpiresAt: result.pullAccess.tokenExpiresAt,
            },
            expiresInDays: this.pullTokens.warningDaysUntilExpiry(result.pullAccess.tokenExpiresAt),
        };
    }

    /** `POST /api/works/:id/builds` — request a Build (Rebuild) of a commit. */
    @Post(':id/builds')
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 10, ttl: 3_600_000 } })
    @ApiOperation({
        summary: 'Request a Build of an App Work',
        description:
            "Queues a Build of `commitSha` (default: the tracked branch's head). A second request for " +
            'the same commit inside 10 s answers the same Build with `deduped: true`.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 202, description: '`{ build, deduped }`.' })
    @ApiResponse({ status: 403, description: '`editAccessRequired` — a viewer.' })
    @ApiResponse({
        status: 422,
        description: '`commitNotReachable` · `nothingToBuild` · `specMissing`.',
    })
    @ApiResponse({ status: 429, description: '`rebuildRateLimited` with `retryAfterMinutes`.' })
    @ApiResponse({ status: 503, description: '`buildProviderUnavailable`.' })
    async request(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: CreateAppBuildDto,
    ): Promise<AppBuildRequestResponse> {
        await this.authorize(id, auth.userId, 'edit');

        const result = await this.builds.requestRebuild(id, auth.userId, {
            ...(body?.commitSha ? { commitSha: body.commitSha.toLowerCase() } : {}),
        });
        if (result.ok === false) {
            switch (result.code) {
                case 'rebuildRateLimited':
                    throw refusal(
                        'rebuildRateLimited',
                        HttpStatus.TOO_MANY_REQUESTS,
                        'Too many Rebuilds of this App Work in the last hour.',
                        result.retryAfterMinutes,
                    );
                case 'commitNotReachable':
                    throw refusal(
                        'commitNotReachable',
                        HttpStatus.UNPROCESSABLE_ENTITY,
                        'The commit is not reachable from the tracked branch.',
                    );
                case 'nothingToBuild':
                    throw refusal(
                        'nothingToBuild',
                        HttpStatus.UNPROCESSABLE_ENTITY,
                        "This App Work's build strategy builds nothing.",
                    );
                case 'specMissing':
                    throw refusal(
                        'specMissing',
                        HttpStatus.UNPROCESSABLE_ENTITY,
                        'This App Work has no App spec (`.works/works.yml`) on its tracked branch yet. ' +
                            'Merge its setup pull request (or add the App spec), then build again.',
                    );
                default:
                    throw refusal(
                        'buildProviderUnavailable',
                        HttpStatus.SERVICE_UNAVAILABLE,
                        'No build provider is available for this App Work right now.',
                    );
            }
        }

        return { build: toAppBuildSummary(result.build), deduped: result.deduped };
    }

    /** `GET /api/works/:id/builds/:buildId` — one Build's drawer. */
    @Get(':id/builds/:buildId')
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({ summary: 'Get one Build of an App Work' })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiParam({ name: 'buildId', description: 'Build ID' })
    @ApiResponse({ status: 200, description: '`AppBuildDetail`.' })
    @ApiResponse({ status: 404, description: '`buildNotFound` — including another Work’s Build.' })
    async detail(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('buildId', ParseUUIDPipe) buildId: string,
    ): Promise<AppBuildDetail> {
        await this.authorize(id, auth.userId, 'view');
        const detail = await this.builds.getDetail(id, buildId, auth.userId);
        if (!detail) {
            throw refusal('buildNotFound', HttpStatus.NOT_FOUND, `Build ${buildId} not found.`);
        }
        return detail;
    }

    /** `POST /api/works/:id/builds/:buildId/cancel` — stop a queued or running Build. */
    @Post(':id/builds/:buildId/cancel')
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({ summary: 'Cancel one Build of an App Work' })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiParam({ name: 'buildId', description: 'Build ID' })
    @ApiResponse({ status: 202, description: '`{ build }`.' })
    @ApiResponse({ status: 403, description: '`editAccessRequired` — a viewer.' })
    @ApiResponse({ status: 404, description: '`buildNotFound`.' })
    @ApiResponse({ status: 409, description: '`notCancellable` — terminal or blocked.' })
    async cancel(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('buildId', ParseUUIDPipe) buildId: string,
    ): Promise<AppBuildCancelResponse> {
        await this.authorize(id, auth.userId, 'edit');
        const result = await this.builds.cancel(id, buildId);
        if (result.ok === false) {
            if (result.code === 'notCancellable') {
                throw refusal(
                    'notCancellable',
                    HttpStatus.CONFLICT,
                    'This Build has already finished or is blocked, so it cannot be cancelled.',
                );
            }
            throw refusal('buildNotFound', HttpStatus.NOT_FOUND, `Build ${buildId} not found.`);
        }
        return { build: toAppBuildSummary(result.build) };
    }

    /**
     * The switch, then view (or edit) access to a visible App Work.
     *
     * `404` for missing, invisible and another account's alike; `404 notAppWork`
     * for a visible Work of another kind; `403 editAccessRequired` for a viewer
     * asking to write.
     */
    private async authorize(
        workId: string,
        userId: string,
        level: 'view' | 'edit',
    ): Promise<WorkAccessResult> {
        if (!config.everWorks.apps.worksEnabled()) {
            throw refusal(
                'appWorksDisabled',
                HttpStatus.NOT_FOUND,
                'App Works is turned off on this installation.',
            );
        }

        let access: WorkAccessResult;
        try {
            access = await this.ownership.ensureCanView(workId, userId);
        } catch (error) {
            if (isStatus(error, HttpStatus.NOT_FOUND) || isStatus(error, HttpStatus.FORBIDDEN)) {
                throw refusal('notAppWork', HttpStatus.NOT_FOUND, `Work ${workId} not found.`);
            }
            throw error;
        }

        if (access.work?.kind !== 'app') {
            throw refusal(
                'notAppWork',
                HttpStatus.NOT_FOUND,
                `Work ${workId} is not an App Work, so it has no Builds.`,
            );
        }

        if (level === 'edit') {
            try {
                access = await this.ownership.ensureCanEdit(workId, userId);
            } catch (error) {
                if (
                    isStatus(error, HttpStatus.FORBIDDEN) ||
                    isStatus(error, HttpStatus.NOT_FOUND)
                ) {
                    throw refusal(
                        'editAccessRequired',
                        HttpStatus.FORBIDDEN,
                        'You need edit access to this App Work to do that.',
                    );
                }
                throw error;
            }
        }

        return access;
    }
}

/** One stable refusal body (`AppBuildApiError`). */
function refusal(
    code: AppBuildApiErrorCode,
    status: number,
    message: string,
    retryAfterMinutes?: number,
): HttpException {
    const body: AppBuildApiError = {
        status: 'error',
        code,
        message,
        ...(retryAfterMinutes !== undefined ? { retryAfterMinutes } : {}),
    };
    return new HttpException(body, status);
}

function isStatus(error: unknown, status: number): boolean {
    return error instanceof HttpException && error.getStatus() === status;
}

/** `a,b` → `['a','b']`; the DTO has already refused anything outside the closed set. */
function splitList<T extends string>(value: string): T[] {
    return value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0) as T[];
}

/** English fallback copy per pull-token code; the web translates by `code`. */
function pullTokenMessage(code: AppBuildApiErrorCode): string {
    switch (code) {
        case 'pullTokenNoImageYet':
            return 'This App Work has not pushed an image yet, so there is nothing for a token to read.';
        case 'pullTokenPublicImage':
            return 'The image is public; no pull token is needed.';
        case 'pullTokenTooBroad':
            return 'Use a classic token with the read:packages scope only.';
        case 'pullTokenFineGrained':
            return 'Fine-grained tokens cannot pull from GHCR; use a classic token with read:packages.';
        case 'pullTokenCannotRead':
            return 'The token cannot read this image.';
        default:
            return 'The pull token could not be checked or stored right now.';
    }
}
