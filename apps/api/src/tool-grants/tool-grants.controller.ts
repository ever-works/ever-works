import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Optional,
    Param,
    Put,
    Query,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type {
    ConnectionScopePresetProviderDto,
    ConnectionScopePresetStateDto,
    ResolvedToolGrants,
    ToolGrantDecision,
    ToolGrantScope,
} from '@ever-works/contracts';
import { ToolGrantService } from '@ever-works/agent/policy';
import type { ToolGrant } from '@ever-works/agent/entities';
import {
    AgentRepository,
    OrganizationRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import {
    ApplyToolGrantPresetDto,
    CheckToolGrantQueryDto,
    ResolveToolGrantsQueryDto,
    ToolGrantPresetStateQueryDto,
    UpsertToolGrantDto,
} from './dto/tool-grant.dto';
import { ToolGrantPresetsService } from './tool-grant-presets.service';

/**
 * Tool-grant matrix (audit item G4) — the customer-facing surface.
 *
 *   GET    /api/tool-grants/resolve?workId=&agentId=&organizationId=
 *   GET    /api/tool-grants/check?toolName=&workId=&agentId=
 *   GET    /api/tool-grants
 *   PUT    /api/tool-grants
 *   DELETE /api/tool-grants/:id
 *   GET    /api/tool-grants/presets                (AW-15)
 *   GET    /api/tool-grants/presets/state          (AW-15)
 *   PUT    /api/tool-grants/presets                (AW-15)
 *
 * The three `presets` routes put plain-English access levels ("Read only" /
 * "Read and write") that a provider plugin declares ON this same lattice: a
 * level is written as ordinary deny patterns on one scope's row, behind the
 * SAME ownership checks as a raw write below. There is no second permission
 * model to keep in step with this one.
 *
 * `resolve` deliberately returns the whole `chain` (least → most specific,
 * starting at the platform default) including each layer's REJECTED
 * patterns. "That tool isn't available" is only a usable answer if the UI
 * can also say WHERE the restriction came from, and "your Agent-level
 * grant asked for something its Work never granted" is only debuggable if
 * the rejection is reported rather than silently dropped.
 *
 * Unlike the merge policy — a field on an existing entity, written through
 * that entity's PATCH — a tool grant is its own row, so it needs its own
 * write path. Every write is owner-checked against the SAME rules as the
 * read:
 *   - Work → `WorkOwnershipService.ensureAccess` (cross-user Works 404
 *     with no existence leak);
 *   - Agent → owner-filtered lookup;
 *   - Organization → same-Tenant check;
 *   - Tenant → must be the caller's OWN tenant.
 *
 * Without those checks this endpoint would be both a cross-tenant policy
 * oracle and a way to write access policy into someone else's tenant.
 */
@ApiTags('tool-grants')
@Controller('api/tool-grants')
export class ToolGrantsController {
    constructor(
        private readonly toolGrants: ToolGrantService,
        private readonly ownership: WorkOwnershipService,
        private readonly agents: AgentRepository,
        private readonly organizations: OrganizationRepository,
        private readonly users: UserRepository,
        @Optional() private readonly presets?: ToolGrantPresetsService,
    ) {}

    // ── access-level presets (AW-15) ──────────────────────────────────

    @Get('presets')
    @ApiOperation({
        summary:
            'List the providers whose plugins declare plain-English access levels ("read" / "write"), with the agent tools each level unlocks.',
    })
    @HttpCode(HttpStatus.OK)
    async listPresets(): Promise<{ providers: ConnectionScopePresetProviderDto[] }> {
        return { providers: await this.requirePresets().listProviders() };
    }

    @Get('presets/state')
    @ApiOperation({
        summary:
            'The access level one scope selects for one provider, the level in effect after the whole chain, and which scope narrowed it.',
    })
    @HttpCode(HttpStatus.OK)
    async presetState(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ToolGrantPresetStateQueryDto,
    ): Promise<ConnectionScopePresetStateDto> {
        const service = this.requirePresets();
        await this.assertWritableScope(auth, query.scopeType, query.scopeId);
        return service.getState({
            userId: auth.userId,
            providerId: query.providerId,
            scopeType: query.scopeType,
            scopeId: query.scopeId,
        });
    }

    @Put('presets')
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary:
            'Choose an access level for one provider at one scope. Written as deny patterns on that scope’s tool-grant row, so it only ever narrows; a deny pattern the operator wrote before the level control touched the row is never removed (it is reported as blockedByExistingDeny). Widening that needs the connected account re-approved returns 409 preset_requires_reapproval and changes nothing.',
    })
    @HttpCode(HttpStatus.OK)
    async applyPreset(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: ApplyToolGrantPresetDto,
    ): Promise<ConnectionScopePresetStateDto> {
        const service = this.requirePresets();
        await this.assertWritableScope(auth, body.scopeType, body.scopeId);
        return service.apply(
            {
                userId: auth.userId,
                providerId: body.providerId,
                scopeType: body.scopeType,
                scopeId: body.scopeId,
            },
            body.preset,
        );
    }

    private requirePresets(): ToolGrantPresetsService {
        if (!this.presets) {
            throw new ServiceUnavailableException('Access-level presets are not available.');
        }
        return this.presets;
    }

    @Get('resolve')
    @ApiOperation({
        summary:
            'Preview the effective tool-grant matrix for a Work and/or Agent, with the resolution chain (tenant → organization → Work → Agent over the platform default).',
    })
    @HttpCode(HttpStatus.OK)
    async resolve(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ResolveToolGrantsQueryDto,
    ): Promise<ResolvedToolGrants> {
        await this.assertScopeAccess(auth, query);
        return this.toolGrants.resolve({
            userId: auth.userId,
            workId: query.workId ?? null,
            agentId: query.agentId ?? null,
            organizationId: query.organizationId ?? null,
        });
    }

    @Get('check')
    @ApiOperation({
        summary: 'Check whether one named tool is allowed for a Work and/or Agent.',
    })
    @HttpCode(HttpStatus.OK)
    async check(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: CheckToolGrantQueryDto,
    ): Promise<ToolGrantDecision> {
        await this.assertScopeAccess(auth, query);
        return this.toolGrants.decide(
            {
                userId: auth.userId,
                workId: query.workId ?? null,
                agentId: query.agentId ?? null,
                organizationId: query.organizationId ?? null,
            },
            query.toolName,
        );
    }

    @Get()
    @ApiOperation({ summary: "List the caller's own stored tool grants, one row per scope." })
    @HttpCode(HttpStatus.OK)
    async list(@CurrentUser() auth: AuthenticatedUser): Promise<ToolGrant[]> {
        return this.toolGrants.list(auth.userId);
    }

    @Put()
    @ApiOperation({
        summary:
            'Create or update the grant for one scope. A second write for the same scope UPDATES it — a scope never contributes two layers.',
    })
    @HttpCode(HttpStatus.OK)
    async upsert(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: UpsertToolGrantDto,
    ): Promise<ToolGrant> {
        if (body.allow === undefined && body.deny === undefined) {
            throw new BadRequestException(
                'Provide allow and/or deny. To clear a grant, DELETE the row instead.',
            );
        }
        await this.assertWritableScope(auth, body.scopeType, body.scopeId);
        const grant: { allow?: string[]; deny?: string[] } = {};
        if (body.allow !== undefined) grant.allow = body.allow;
        if (body.deny !== undefined) grant.deny = body.deny;
        return this.toolGrants.upsert({
            userId: auth.userId,
            scopeType: body.scopeType,
            scopeId: body.scopeId,
            grant,
            note: body.note ?? null,
        });
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete one grant row. The scope reverts to inheriting.' })
    @HttpCode(HttpStatus.OK)
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<{ deleted: true }> {
        const deleted = await this.toolGrants.remove(auth.userId, id);
        if (!deleted) {
            throw new NotFoundException(`Tool grant with id '${id}' not found`);
        }
        return { deleted: true };
    }

    // ── ownership ─────────────────────────────────────────────────────

    /** Read-side scope check. Mirrors `MergePolicyController.resolve` exactly. */
    private async assertScopeAccess(
        auth: AuthenticatedUser,
        query: ResolveToolGrantsQueryDto,
    ): Promise<void> {
        if (!query.workId && !query.agentId && !query.organizationId) {
            throw new BadRequestException('Provide workId, agentId and/or organizationId.');
        }
        if (query.workId) {
            // Throws 404 for a Work the caller cannot reach.
            await this.ownership.ensureAccess(query.workId, auth.userId);
        }
        if (query.agentId) {
            const agent = await this.agents.findByIdAndUser(query.agentId, auth.userId);
            if (!agent) {
                throw new NotFoundException(`Agent with id '${query.agentId}' not found`);
            }
        }
        if (query.organizationId) {
            await this.assertOrganizationInTenant(auth, query.organizationId);
        }
    }

    /** Write-side scope check — one scope at a time, including tenant. */
    private async assertWritableScope(
        auth: AuthenticatedUser,
        scopeType: ToolGrantScope,
        scopeId: string,
    ): Promise<void> {
        switch (scopeType) {
            case 'work':
                await this.ownership.ensureAccess(scopeId, auth.userId);
                return;
            case 'agent': {
                const agent = await this.agents.findByIdAndUser(scopeId, auth.userId);
                if (!agent) throw new NotFoundException(`Agent with id '${scopeId}' not found`);
                return;
            }
            case 'organization':
                await this.assertOrganizationInTenant(auth, scopeId);
                return;
            case 'tenant': {
                // A tenant ceiling that anyone could write into is not a
                // ceiling. Only the caller's OWN tenant is writable here.
                const user = await this.users.findById(auth.userId);
                if (!user?.tenantId || user.tenantId !== scopeId) {
                    throw new NotFoundException(`Tenant with id '${scopeId}' not found`);
                }
                return;
            }
        }
    }

    private async assertOrganizationInTenant(
        auth: AuthenticatedUser,
        organizationId: string,
    ): Promise<void> {
        // Same-Tenant check as `OrganizationService.update` — an
        // Organization outside the caller's Tenant 404s with no existence
        // leak, so the org layer can never become a cross-tenant oracle.
        const user = await this.users.findById(auth.userId);
        const org = await this.organizations.findById(organizationId);
        if (!user?.tenantId || !org || org.tenantId !== user.tenantId) {
            throw new NotFoundException(`Organization with id '${organizationId}' not found`);
        }
    }
}
