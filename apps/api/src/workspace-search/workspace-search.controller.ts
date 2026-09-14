import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { WorkspaceSearchService } from '@ever-works/agent/workspace-search';
import {
    WORKSPACE_SEARCH_MIN_QUERY_LENGTH,
    type WorkspaceSearchResponse,
} from '@ever-works/contracts/api';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope';
import { WorkspaceSearchQueryDto } from './dto/workspace-search-query.dto';

/**
 * Workspace search — the read-only endpoint behind the dashboard command
 * palette (AW-01).
 *
 * `GET /api/workspace-search?q=` answers "where is anything called X in my
 * workspace" across Missions, Tasks, Agents, Works, Ideas, Skills, Teams and
 * Knowledge-Base documents, grouped and ranked. Auth-guarded by the global
 * session guard; scoped by the request's `{ tenantId, organizationId }`, so
 * no result ever comes from another workspace. Rate-limited because the
 * palette calls it on every settled keystroke.
 *
 * Not to be confused with `/api/search`, which searches the web through the
 * configured search plugin.
 */
@ApiTags('Workspace Search')
@ApiBearerAuth('JWT-auth')
@Controller('api/workspace-search')
export class WorkspaceSearchController {
    constructor(
        private readonly workspaceSearch: WorkspaceSearchService,
        private readonly scopeContext: ScopeContextService,
    ) {}

    @Get()
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Search every record the caller can open in the active workspace',
        description:
            'Grouped, ranked lexical search across Missions, Tasks, Agents, Works, Ideas, Skills, Teams and Knowledge documents. A failing source is reported in `degradedKinds` rather than failing the request.',
    })
    @ApiResponse({ status: 200, description: 'Grouped search results' })
    async search(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: WorkspaceSearchQueryDto,
    ): Promise<WorkspaceSearchResponse> {
        const q = (query.q ?? '').trim();
        if (q.length < WORKSPACE_SEARCH_MIN_QUERY_LENGTH) {
            return { query: q, groups: [], degradedKinds: [], servedBy: 'fanout', tookMs: 0 };
        }

        const scope = this.scopeContext.getScope();
        return this.workspaceSearch.search(
            { userId: auth.userId, tenantId: scope.tenantId, organizationId: scope.organizationId },
            {
                query: q,
                kinds: query.kinds,
                limit: query.limit,
                perKindLimit: query.perKindLimit,
                recent: query.recent,
            },
        );
    }
}
