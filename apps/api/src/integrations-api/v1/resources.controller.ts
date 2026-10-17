import {
    Controller,
    Get,
    Param,
    ParseUUIDPipe,
    Query,
    Res,
    UseFilters,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
    type IntegrationResource,
    type IntegrationResourceKind,
    IntegrationResourcesService,
    type KeysetPage,
} from '@ever-works/agent/integrations-api';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { RequireScopes } from '../../auth/integration/integration.decorators';
import { ScopeContextService } from '../../scope/scope-context.service';
import { IntegrationOnlyGuard } from './integration-only.guard';
import { IntegrationExceptionFilter } from './integration-exception.filter';
import {
    linkSourceOf,
    parseLimit,
    parseUpdatedSince,
    pinnedOrganizationOf,
    principalOf,
    rethrowCursor,
} from './integration-request';

interface ListQuery {
    readonly updatedSince?: string;
    readonly cursor?: string;
    readonly limit?: string;
    readonly includeArchived?: string;
}

type Response = { setHeader(name: string, value: string): void };

/**
 * Read routes of the P1 resources (contract v1 B.6) in the `X-Scope-Slug`
 * organization: lists are `?updatedSince=&cursor=&limit=` keyset pages
 * ordered by `(updatedAt, id)` (`{data, nextCursor, hasMore}`); a single
 * resource carries `ETag: "<version>"`. Writes (teams, tasks) ship next.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationResourcesController {
    constructor(
        private readonly resources: IntegrationResourcesService,
        private readonly scope: ScopeContextService,
    ) {}

    @Get('organization')
    @RequireScopes('org:read')
    @ApiOperation({ summary: 'The pinned organization (X-Scope-Slug)' })
    async organization(
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        return this.send(res, await this.resources.organization(this.organizationId()));
    }

    @Get('members')
    @RequireScopes('members:read')
    @ApiOperation({ summary: "The organization's members" })
    async members(@Query() query: ListQuery): Promise<KeysetPage<Record<string, unknown>>> {
        return this.resources
            .members(this.organizationId(), this.keyset(query))
            .catch(rethrowCursor);
    }

    @Get('agents')
    @RequireScopes('agents:read')
    @ApiOperation({ summary: 'Agents (read-only for integrations)' })
    listAgents(@CurrentUser() user: AuthenticatedUser, @Query() query: ListQuery) {
        return this.list('agent', user, query);
    }

    @Get('agents/:id')
    @RequireScopes('agents:read')
    @ApiOperation({ summary: 'One agent' })
    getAgent(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res: Response,
    ) {
        return this.get('agent', user, id, res);
    }

    @Get('teams')
    @RequireScopes('teams:read')
    @ApiOperation({ summary: 'Teams (members and resources embedded)' })
    listTeams(@CurrentUser() user: AuthenticatedUser, @Query() query: ListQuery) {
        return this.list('team', user, query);
    }

    @Get('teams/:id')
    @RequireScopes('teams:read')
    @ApiOperation({ summary: 'One team' })
    getTeam(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res: Response,
    ) {
        return this.get('team', user, id, res);
    }

    @Get('works')
    @RequireScopes('works:read')
    @ApiOperation({ summary: 'Works (members and repositories embedded)' })
    listWorks(@CurrentUser() user: AuthenticatedUser, @Query() query: ListQuery) {
        return this.list('work', user, query);
    }

    @Get('works/:id')
    @RequireScopes('works:read')
    @ApiOperation({ summary: 'One work' })
    getWork(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res: Response,
    ) {
        return this.get('work', user, id, res);
    }

    @Get('tasks')
    @RequireScopes('tasks:read')
    @ApiOperation({ summary: 'Tasks' })
    listTasks(@CurrentUser() user: AuthenticatedUser, @Query() query: ListQuery) {
        return this.list('task', user, query);
    }

    @Get('tasks/:id')
    @RequireScopes('tasks:read')
    @ApiOperation({ summary: 'One task' })
    getTask(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res: Response,
    ) {
        return this.get('task', user, id, res);
    }

    private organizationId(): string {
        return pinnedOrganizationOf(this.scope.getScope().organizationId);
    }

    private keyset(query: ListQuery) {
        return {
            updatedSince: parseUpdatedSince(query.updatedSince),
            cursor: query.cursor || null,
            limit: parseLimit(query.limit),
            includeArchived: query.includeArchived === 'true',
        };
    }

    private list(kind: IntegrationResourceKind, user: AuthenticatedUser, query: ListQuery) {
        const principal = principalOf(user);
        return this.resources
            .list(kind, this.organizationId(), this.keyset(query), linkSourceOf(principal))
            .catch(rethrowCursor);
    }

    private async get(
        kind: IntegrationResourceKind,
        user: AuthenticatedUser,
        id: string,
        res: Response,
    ): Promise<Record<string, unknown>> {
        const principal = principalOf(user);
        return this.send(
            res,
            await this.resources.get(kind, this.organizationId(), id, linkSourceOf(principal)),
        );
    }

    private send(res: Response, resource: IntegrationResource): Record<string, unknown> {
        if (resource.etag) res.setHeader('ETag', resource.etag);
        return resource.dto;
    }
}
