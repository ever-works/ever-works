import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Team, TeamResourceType } from '@ever-works/agent/teams';
import { OrgChartService, TeamResourcesService, TeamsService } from '@ever-works/agent/teams';
import type {
    OrgChartPayload,
    ResourceTeamRef,
    TeamMemberView,
    TeamResourceItem,
    TeamResourcesGrouped,
} from '@ever-works/agent/teams';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import {
    OrgAdmin,
    OrganizationOwnershipGuard,
} from '../organizations/guards/organization-ownership.guard';
import {
    AddTeamMemberDto,
    AttachTeamResourceDto,
    CreateTeamDto,
    RemoveTeamMemberQueryDto,
    ResourceTeamsQueryDto,
    UpdateTeamDto,
} from './dto/team.dto';

/** Wire shape for a Team (hand-mirrored by `apps/web/src/lib/api/teams.ts`). */
export interface TeamResponse {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    parentTeamId: string | null;
    managerAgentId: string | null;
    avatarIcon: string | null;
    organizationId: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface TeamDetailResponse extends TeamResponse {
    members: TeamMemberView[];
    childTeamIds: string[];
}

/**
 * Teams & Prebuilt Companies — org-nested Teams API
 * (`docs/specs/features/teams-and-companies/spec.md` §3).
 *
 * Every route is object-level authorized by `OrganizationOwnershipGuard`
 * (class-level — all routes carry `:orgId`): the raw
 * `/api/organizations/:orgId/...` shape yields EMPTY_SCOPE, so the global
 * scope guards do NOT validate the attacker-supplied `:orgId` (see
 * org-kb.controller.ts for the full rationale). Writes additionally carry
 * `@OrgAdmin()` — today identical to member, but the seam tightens in one
 * place once per-Org roles land. 404-never-403 posture throughout.
 */
@ApiTags('Teams')
@ApiBearerAuth('JWT-auth')
@Controller('api/organizations/:orgId')
@UseGuards(AuthSessionGuard, OrganizationOwnershipGuard)
export class TeamsController {
    constructor(
        private readonly teamsService: TeamsService,
        private readonly orgChart: OrgChartService,
        private readonly teamResources: TeamResourcesService,
    ) {}

    @Get('teams')
    @ApiOperation({
        summary: 'List teams of an Organization',
        description: 'Flat list (with parentTeamId edges) — clients build the tree.',
    })
    @ApiResponse({ status: 200, description: 'Teams listed' })
    async list(@Param('orgId', ParseUUIDPipe) orgId: string): Promise<TeamResponse[]> {
        const teams = await this.teamsService.list(orgId);
        return teams.map((t) => this.toResponse(t));
    }

    @Post('teams')
    @OrgAdmin()
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({ summary: 'Create a team in an Organization' })
    @ApiResponse({ status: 201, description: 'Team created' })
    @ApiResponse({ status: 409, description: 'Slug already used in this Organization' })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Body() dto: CreateTeamDto,
    ): Promise<TeamResponse> {
        const team = await this.teamsService.create(auth.userId, orgId, dto);
        return this.toResponse(team);
    }

    @Get('teams/:teamId')
    @ApiOperation({ summary: 'Get a team (roster + child team ids included)' })
    @ApiResponse({ status: 200, description: 'Team detail' })
    async get(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Param('teamId', ParseUUIDPipe) teamId: string,
    ): Promise<TeamDetailResponse> {
        const team = await this.teamsService.getOrThrow(orgId, teamId);
        const [members, childTeamIds] = await Promise.all([
            this.teamsService.listMembers(orgId, teamId),
            this.teamsService.childTeamIds(teamId),
        ]);
        return { ...this.toResponse(team), members, childTeamIds };
    }

    @Patch('teams/:teamId')
    @OrgAdmin()
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({ summary: 'Update a team (re-parent is cycle-checked)' })
    @ApiResponse({ status: 200, description: 'Team updated' })
    async update(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Param('teamId', ParseUUIDPipe) teamId: string,
        @Body() dto: UpdateTeamDto,
    ): Promise<TeamResponse> {
        const team = await this.teamsService.update(orgId, teamId, dto);
        return this.toResponse(team);
    }

    @Delete('teams/:teamId')
    @OrgAdmin()
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary: 'Delete a team',
        description: "Child teams re-parent to the deleted team's parent; roster rows cascade.",
    })
    @ApiResponse({ status: 204, description: 'Team deleted' })
    async remove(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Param('teamId', ParseUUIDPipe) teamId: string,
    ): Promise<void> {
        await this.teamsService.remove(orgId, teamId);
    }

    @Get('teams/:teamId/members')
    @ApiOperation({ summary: 'List team roster (agents + human members)' })
    @ApiResponse({ status: 200, description: 'Roster listed' })
    async listMembers(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Param('teamId', ParseUUIDPipe) teamId: string,
    ): Promise<TeamMemberView[]> {
        return this.teamsService.listMembers(orgId, teamId);
    }

    @Post('teams/:teamId/members')
    @OrgAdmin()
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({ summary: 'Add an agent or human member to a team' })
    @ApiResponse({ status: 201, description: 'Member added' })
    @ApiResponse({ status: 409, description: 'Already a member' })
    async addMember(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Param('teamId', ParseUUIDPipe) teamId: string,
        @Body() dto: AddTeamMemberDto,
    ): Promise<TeamMemberView> {
        return this.teamsService.addMember(auth.userId, orgId, teamId, dto);
    }

    @Delete('teams/:teamId/members/:memberId')
    @OrgAdmin()
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Remove a member from a team' })
    @ApiResponse({ status: 204, description: 'Member removed' })
    async removeMember(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Param('teamId', ParseUUIDPipe) teamId: string,
        @Param('memberId', ParseUUIDPipe) memberId: string,
        @Query() query: RemoveTeamMemberQueryDto,
    ): Promise<void> {
        await this.teamsService.removeMember(orgId, teamId, query.memberType, memberId);
    }

    @Get('teams/:teamId/resources')
    @ApiOperation({
        summary: 'List resources attached to a team',
        description: 'Attached Works/Tasks/Agents/Missions/Ideas, resolved + grouped by type.',
    })
    @ApiResponse({ status: 200, description: 'Team resources listed' })
    async listResources(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Param('teamId', ParseUUIDPipe) teamId: string,
    ): Promise<TeamResourcesGrouped> {
        return this.teamResources.listForTeam(orgId, teamId);
    }

    @Post('teams/:teamId/resources')
    @OrgAdmin()
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Attach a resource (Work/Task/Agent/Mission/Idea) to a team',
        description: 'The resource must belong to the same Organization (404-never-403 on mismatch).',
    })
    @ApiResponse({ status: 201, description: 'Resource attached' })
    @ApiResponse({ status: 404, description: 'Team or resource not found in this Organization' })
    @ApiResponse({ status: 409, description: 'Resource already attached to this team' })
    async attachResource(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Param('teamId', ParseUUIDPipe) teamId: string,
        @Body() dto: AttachTeamResourceDto,
    ): Promise<TeamResourceItem> {
        return this.teamResources.attach(auth.userId, orgId, teamId, dto);
    }

    @Delete('teams/:teamId/resources/:resourceType/:resourceId')
    @OrgAdmin()
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Detach a resource from a team' })
    @ApiResponse({ status: 204, description: 'Resource detached' })
    @ApiResponse({ status: 404, description: 'Resource is not attached to this team' })
    async detachResource(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Param('teamId', ParseUUIDPipe) teamId: string,
        @Param('resourceType') resourceType: TeamResourceType,
        @Param('resourceId', ParseUUIDPipe) resourceId: string,
    ): Promise<void> {
        await this.teamResources.detach(orgId, teamId, resourceType, resourceId);
    }

    @Get('resource-teams')
    @ApiOperation({
        summary: 'Reverse lookup: teams that own a given resource',
        description: 'Which Teams in this Organization a Work/Task/Agent/Mission/Idea belongs to.',
    })
    @ApiResponse({ status: 200, description: 'Owning teams listed' })
    async resourceTeams(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Query() query: ResourceTeamsQueryDto,
    ): Promise<ResourceTeamRef[]> {
        return this.teamResources.listTeamsForResource(orgId, query.resourceType, query.resourceId);
    }

    @Get('org-chart')
    @ApiOperation({
        summary: 'Org chart payload (teams + agents + members, flat)',
        description:
            'Flat nodes with parentTeamId / reportsToAgentId edges and teamIds projections — the tree is a pure client-side layout.',
    })
    @ApiResponse({ status: 200, description: 'Org chart payload' })
    async chart(@Param('orgId', ParseUUIDPipe) orgId: string): Promise<OrgChartPayload> {
        return this.orgChart.build(orgId);
    }

    private toResponse(team: Team): TeamResponse {
        return {
            id: team.id,
            name: team.name,
            slug: team.slug,
            description: team.description ?? null,
            parentTeamId: team.parentTeamId ?? null,
            managerAgentId: team.managerAgentId ?? null,
            avatarIcon: team.avatarIcon ?? null,
            organizationId: team.organizationId ?? null,
            createdAt: team.createdAt,
            updatedAt: team.updatedAt,
        };
    }
}
