import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Logger,
    NotFoundException,
    Post,
    Req,
    ServiceUnavailableException,
    UseFilters,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    SHARED_VIEW_LIMITS,
    SHARED_VIEW_NOT_ACTIVE,
    type PublishedBoardDto,
    type SharedViewSessionDto,
} from '@ever-works/contracts/api';
import {
    SharedViewProjectionService,
    SharedViewService,
    type SharedView,
} from '@ever-works/agent/shared-views';
import { Public } from '../auth/decorators/public.decorator';
import { CreateSharedViewSessionDto } from './dto/shared-view.dto';
import {
    SHARED_VIEW_INDEXABLE_KEY,
    SharedViewPublicExceptionFilter,
    SharedViewPublicHeadersInterceptor,
    sharedViewClientTracker,
    sharedViewSessionTracker,
    sharedViewThrottleKey,
    sharedViewTokenTracker,
} from './shared-view-public.http';
import { SHARED_VIEW_KEY, SharedViewSessionGuard } from './shared-view-session.guard';
import { SharedViewSessionService } from './shared-view-session.service';
import { SharedViewViewDedupe } from './shared-view-view-dedupe';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** 600 public requests per hour per client, shared by every route below. */
const CLIENT_BUCKET = {
    limit: SHARED_VIEW_LIMITS.requestsPerClientPerHour,
    ttl: HOUR_MS,
    getTracker: sharedViewClientTracker,
    generateKey: sharedViewThrottleKey,
};

type PublicRequest = Record<string, unknown> & {
    [SHARED_VIEW_KEY]?: SharedView;
};

/**
 * Shared view — the public share-link API. No account, no cookie, no user
 * session.
 *
 * **The token never travels in a URL.** A request line is persisted by the
 * request log and by error monitoring, so no route here takes the token in
 * its path or query string. A visit presents it once, in the body of
 * `POST /sessions` (a `POST` for the same reason the invitation preview is
 * one), and receives a fifteen-minute view session; every read presents only
 * that, as `Authorization: Bearer <viewSession>`.
 *
 * **Every refusal is the same bytes.** Unknown, malformed, regenerated-away
 * and paused tokens, and every stale or tampered view session, answer the one
 * not-active `404` (see `SharedViewPublicExceptionFilter`).
 *
 * **Read-only end to end.** The exchange is the only non-`GET` route, and it
 * writes nothing a visitor chose: it counts a view. Every response carries
 * `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `nosniff`, and
 * the crawler block unless the owner allowed indexing.
 *
 * **Throttled before any read.** 60 per minute per token (exchange) or per
 * view (reads), and 600 per hour per client across both, evaluated by the
 * platform throttler guard before the handler runs. Over the limit answers
 * `429` with `Retry-After: 60`, and a throttled request is never counted as a
 * view.
 */
@ApiTags('Shared view')
@Controller('api/public/shared-view')
@Public()
@UseFilters(SharedViewPublicExceptionFilter)
@UseInterceptors(SharedViewPublicHeadersInterceptor)
export class SharedViewPublicController {
    private readonly logger = new Logger(SharedViewPublicController.name);

    constructor(
        private readonly views: SharedViewService,
        private readonly projection: SharedViewProjectionService,
        private readonly sessions: SharedViewSessionService,
        private readonly dedupe: SharedViewViewDedupe,
    ) {}

    @Post('sessions')
    @HttpCode(HttpStatus.OK)
    @Throttle({
        long: {
            limit: SHARED_VIEW_LIMITS.requestsPerTokenPerMinute,
            ttl: MINUTE_MS,
            getTracker: sharedViewTokenTracker,
            generateKey: sharedViewThrottleKey,
        },
        medium: CLIENT_BUCKET,
    })
    @ApiOperation({
        summary: 'Exchange a share token for a view session',
        description:
            'Public. The token travels only in this body. Answers a fifteen-minute view session for the published view, or the not-active 404 for any token that does not resolve to a live link.',
    })
    @ApiResponse({ status: 200, description: 'View session issued' })
    @ApiResponse({
        status: 404,
        description: 'The link is not active (every cause answers the same)',
    })
    @ApiResponse({ status: 429, description: 'Too many requests; retry after 60 seconds' })
    async createSession(
        @Body() body: CreateSharedViewSessionDto,
        @Req() request: PublicRequest,
    ): Promise<SharedViewSessionDto> {
        const view = await this.views.resolveByToken(body?.token);
        // A view that publishes nothing is not active for a visitor.
        if (!view || !view.sections?.board) {
            throw new NotFoundException(SHARED_VIEW_NOT_ACTIVE);
        }
        const session = this.sessions.mint(view);
        request[SHARED_VIEW_INDEXABLE_KEY] = view.searchIndexable === true;

        const client = sharedViewClientTracker(
            request as Parameters<typeof sharedViewClientTracker>[0],
        );
        if (this.dedupe.shouldCount(client, view.id)) {
            await this.views.recordView(view);
        }

        return {
            viewSession: session.viewSession,
            expiresAt: session.expiresAt,
            searchIndexable: view.searchIndexable === true,
            sections: { board: view.sections.board, knowledge: view.sections.knowledge },
        };
    }

    @Get('board')
    @UseGuards(SharedViewSessionGuard)
    @Throttle({
        long: {
            limit: SHARED_VIEW_LIMITS.requestsPerTokenPerMinute,
            ttl: MINUTE_MS,
            getTracker: sharedViewSessionTracker,
            generateKey: sharedViewThrottleKey,
        },
        medium: CLIENT_BUCKET,
    })
    @ApiHeader({ name: 'Authorization', description: 'Bearer <viewSession>', required: true })
    @ApiOperation({
        summary: 'Read the published Task board',
        description:
            'The live Focus columns (at most fifty cards each), the Agent roster and the recent activity strip — nothing else.',
    })
    @ApiResponse({ status: 200, description: 'Published board' })
    @ApiResponse({ status: 404, description: 'The link is not active' })
    @ApiResponse({ status: 503, description: 'The board could not be read right now' })
    async board(@Req() request: PublicRequest): Promise<PublishedBoardDto> {
        const view = request[SHARED_VIEW_KEY];
        if (!view || !view.sections?.board) {
            throw new NotFoundException(SHARED_VIEW_NOT_ACTIVE);
        }
        request[SHARED_VIEW_INDEXABLE_KEY] = view.searchIndexable === true;
        try {
            return await this.projection.projectBoard(view);
        } catch (error) {
            this.logger.warn(
                `Shared view ${view.id} board could not be projected: ${error instanceof Error ? error.name : 'error'}`,
            );
            throw new ServiceUnavailableException('shared_view_unavailable');
        }
    }
}
