import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    FeedInvalidCursorError,
    FeedService,
    FeedTooManyAgentsError,
} from '@ever-works/agent/activity-log';
import type { FeedActorsDto, FeedPageDto } from '@ever-works/contracts';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope/scope-context.service';
import { FeedActorsQueryDto } from './dto/feed-actors-query.dto';
import { FeedQueryDto } from './dto/feed-query.dto';

/**
 * Live Feed — the narrated, filterable view of the caller's activity log.
 *
 * Read-only over the same `activity_log` rows the Activity page lists, and
 * registered in the same module: one store, one module. Nothing here writes
 * an activity record, so opening the feed or changing its filters never
 * shows up in the feed itself.
 *
 * **Security — no caller-supplied subject.** There is no user id and no
 * organization id parameter. The owner is the authenticated session
 * (`@CurrentUser()`) and the scope is the request scope context, which only
 * an explicit `X-Scope-Slug` header or an `/api/<slug>/…` path can select
 * (see `DigestController` for the same posture). A request can therefore
 * never read another user's feed, and a record outside the caller's scope is
 * simply absent — indistinguishable from one that does not exist.
 *
 * Authentication is the global `AuthSessionGuard`, as on every sibling
 * controller in this module.
 */
@ApiTags('Live Feed')
@ApiBearerAuth('JWT-auth')
@Controller('api/feed')
export class FeedController {
    constructor(
        private readonly feed: FeedService,
        private readonly scopeContext: ScopeContextService,
    ) {}

    @Get()
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Read one page of the Live Feed',
        description:
            'Newest first, keyset-paged. Each entry is an existing activity record with its actor, a narration key plus sanitized params, its feed kind and the thing it points at. Filter by agent (at most 20), by kind, or to only what failed.',
    })
    @ApiResponse({
        status: 200,
        description: 'A page of feed entries and the cursor for the next older page.',
    })
    @ApiResponse({ status: 400, description: '`invalid-cursor` or `too-many-agents`.' })
    @ApiResponse({ status: 401, description: 'No session.' })
    async getPage(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: FeedQueryDto,
    ): Promise<FeedPageDto> {
        try {
            return await this.feed.getPage(auth.userId, this.scopeContext.getScope(), {
                agentIds: query.agentIds,
                kinds: query.kinds,
                failedOnly: query.failedOnly === 'true' || query.failedOnly === '1',
                cursor: query.cursor,
                limit: query.limit,
            });
        } catch (error) {
            if (error instanceof FeedInvalidCursorError) {
                throw new BadRequestException({ error: error.code, message: error.message });
            }
            if (error instanceof FeedTooManyAgentsError) {
                throw new BadRequestException({
                    error: error.code,
                    max: error.max,
                    message: error.message,
                });
            }
            throw error;
        }
    }

    @Get('actors')
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary: 'List the agents the Live Feed can be filtered by',
        description:
            'Every agent in the active scope, plus any agent with activity in the window, ordered by how much they did in that window.',
    })
    @ApiResponse({ status: 200, description: 'The agent roster with per-agent entry counts.' })
    @ApiResponse({ status: 401, description: 'No session.' })
    async getActors(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: FeedActorsQueryDto,
    ): Promise<FeedActorsDto> {
        return this.feed.getActors(auth.userId, this.scopeContext.getScope(), query.windowHours);
    }
}
