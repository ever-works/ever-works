import { Controller, Get, Query, UseFilters, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DomainEventFeedService, type DomainEventFeedPage } from '@ever-works/agent/domain-events';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import {
    IntegrationOrgOptional,
    RequireScopes,
} from '../../auth/integration/integration.decorators';
import { ScopeContextService } from '../../scope/scope-context.service';
import { IntegrationOnlyGuard } from './integration-only.guard';
import { IntegrationExceptionFilter } from './integration-exception.filter';
import { listParam, parseLimit, principalOf, validationFailed } from './integration-request';

/**
 * `GET /api/integrations/v1/events` — the change feed (contract v1 B.2).
 *
 * `?after=<seq>&limit=≤1000&types=task.*,goal.*&excludeOrigin=gauzy:<id>` →
 * `{events, nextCursor, hasMore, head}`, in ascending `seq`, for the key's
 * pinned organizations (narrowed to one by `X-Scope-Slug` when sent). Never
 * personal scope, never `private` aggregates except the id-only
 * `*.visibility_changed` notice, and `inbox.*` / `email.*` only with
 * `inbox:read` / `email:read`. A cursor older than retention answers
 * `410 cursor_expired`.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationEventsController {
    constructor(
        private readonly feed: DomainEventFeedService,
        private readonly scope: ScopeContextService,
    ) {}

    @Get('events')
    @RequireScopes('events:read')
    @IntegrationOrgOptional()
    @ApiOperation({ summary: 'Read the change feed (domain events) from a seq cursor' })
    @ApiResponse({ status: 200, description: '{events, nextCursor, hasMore, head}' })
    @ApiResponse({ status: 410, description: 'cursor_expired' })
    async events(
        @CurrentUser() user: AuthenticatedUser,
        @Query('after') after?: string,
        @Query('limit') limit?: string,
        @Query('types') types?: string | string[],
        @Query('excludeOrigin') excludeOrigin?: string | string[],
    ): Promise<DomainEventFeedPage> {
        const principal = principalOf(user);
        if (after !== undefined && after !== '' && !/^\d{1,19}$/.test(after)) {
            throw validationFailed('after', 'must be a feed position (a non-negative integer)');
        }
        const pinned = this.scope.getScope().organizationId;
        const organizationIds = pinned ? [pinned] : principal.allowedOrganizationIds;
        return this.feed.readPage({
            organizationIds,
            after: after || '0',
            limit: parseLimit(limit),
            types: listParam(types),
            excludeOrigins: listParam(excludeOrigin),
            // `inbox.*` / `email.*` (one person's messages) need `inbox:read` /
            // `email:read` on top of `events:read`.
            grantedScopes: principal.scopes,
        });
    }
}
