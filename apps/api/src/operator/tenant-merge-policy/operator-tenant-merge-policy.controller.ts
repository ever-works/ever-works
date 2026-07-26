/**
 * Merge-policy matrix (Wave 3, founder decision D4) — the TENANT write
 * path.
 *
 * The matrix resolves at four scopes (tenant → organization → Work →
 * Agent). Three of them are set through the owning entity's existing
 * PATCH endpoint with that entity's existing permission checks. The
 * tenant was the exception: the column and the resolution shipped, and
 * nothing could write it — the top of the matrix was inert.
 *
 * **Why this surface is operator-only, and stays that way.** A Tenant is
 * not a user-facing entity: it is lazily created on first Organization,
 * never listed, never rendered, and has no settings page to hang a field
 * on. More importantly, a tenant-scoped policy is the CEILING over every
 * organization beneath it — and a ceiling that the people underneath can
 * raise is not a ceiling. So the write lives at `/api/operator/...`
 * behind `IsPlatformAdminGuard` (`User.isPlatformAdmin === true`), the
 * same gate as `OperatorTenantRuntimeAllowlistController`,
 * `PluginAllowlistController` and `AdminUsageController`.
 *
 * **No UI**, deliberately — matching the sibling operator surfaces:
 * operators use the OpenAPI explorer / curl / scripts. The org, Work and
 * Agent scopes are the ones that got settings cards, because those are
 * the scopes a customer owns.
 *
 * Both endpoints answer with STORED + RESOLVED + the chain, so an
 * operator sees the effect of a write in the same round trip that made
 * it rather than having to call the preview endpoint separately.
 */
import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Put,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TenantRepository } from '@ever-works/agent/database';
import { MergePolicyService } from '@ever-works/agent/policy';
import { IsPlatformAdminGuard } from '../../auth/guards/platform-admin.guard';
import {
    ReplaceTenantMergePolicyDto,
    TenantMergePolicyResponseDto,
} from './dto/tenant-merge-policy.dto';

@ApiTags('Operator · Tenant Merge Policy')
@ApiBearerAuth('JWT-auth')
@Controller('api/operator/tenants/:tenantId/merge-policy')
@UseGuards(IsPlatformAdminGuard)
export class OperatorTenantMergePolicyController {
    constructor(
        private readonly tenants: TenantRepository,
        private readonly mergePolicy: MergePolicyService,
    ) {}

    @Get()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Read the tenant-scoped merge policy (stored override + what it resolves to)',
        description:
            'A `stored` of `null` means the tenant declares nothing and everything beneath it inherits ' +
            'the platform default. `resolved` folds the stored override over that default.',
    })
    @ApiParam({ name: 'tenantId', type: String, format: 'uuid' })
    @ApiResponse({ status: 200, type: TenantMergePolicyResponseDto })
    @ApiResponse({ status: 403, description: 'Caller is not a platform admin' })
    @ApiResponse({ status: 404, description: 'No such tenant' })
    async read(
        @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    ): Promise<TenantMergePolicyResponseDto> {
        const tenant = await this.tenants.findById(tenantId);
        if (!tenant) {
            throw new NotFoundException(`Tenant with id '${tenantId}' not found`);
        }
        return this.describe(tenantId, tenant.mergePolicy ?? null);
    }

    @Put()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Set (or clear) the tenant-scoped merge policy',
        description:
            'Replaces the tenant override wholesale with the supplied PARTIAL. Every field omitted inside ' +
            '`mergePolicy` inherits the platform default and stays overridable by organizations, Works ' +
            'and Agents beneath this tenant. Omit `mergePolicy` (or send `null`) to clear the override.',
    })
    @ApiParam({ name: 'tenantId', type: String, format: 'uuid' })
    @ApiResponse({ status: 200, type: TenantMergePolicyResponseDto })
    @ApiResponse({ status: 400, description: 'Validation failed' })
    @ApiResponse({ status: 403, description: 'Caller is not a platform admin' })
    @ApiResponse({ status: 404, description: 'No such tenant' })
    async replace(
        @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
        @Body() dto: ReplaceTenantMergePolicyDto,
    ): Promise<TenantMergePolicyResponseDto> {
        // The repository sanitizes (drop-if-unrecognized, never coerce) and
        // normalizes an empty override to NULL, so "inherit" has exactly one
        // representation at rest — same posture as the other three scopes.
        const updated = await this.tenants.updateMergePolicy(tenantId, dto.mergePolicy ?? null);
        if (!updated) {
            throw new NotFoundException(`Tenant with id '${tenantId}' not found`);
        }
        return this.describe(tenantId, updated.mergePolicy ?? null);
    }

    private async describe(
        tenantId: string,
        stored: TenantMergePolicyResponseDto['stored'],
    ): Promise<TenantMergePolicyResponseDto> {
        const resolution = await this.mergePolicy.resolve({ tenantId });
        return {
            tenantId,
            stored,
            resolved: resolution.policy,
            source: resolution.source,
            chain: resolution.chain,
        };
    }
}
