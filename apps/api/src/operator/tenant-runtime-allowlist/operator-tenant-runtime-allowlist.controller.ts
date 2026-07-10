/**
 * EW-752 P5.1 (T35a) — operator-scoped CRUD for the per-tenant runtime
 * provider allow-list.
 *
 * Spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * Plan: [`plan.md` §10 P5.1](../../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md)
 *
 * **Scope:**
 * These endpoints are OPERATOR-scoped (cross-tenant), not tenant-scoped:
 * the caller is an instance operator acting on ANOTHER tenant's row.
 * That's why they live under `/api/operator/...` rather than under
 * `/api/account/...` like the tenant-self-service surface. Gating
 * follows the existing `IsPlatformAdminGuard` (EW-602) which checks
 * `User.isPlatformAdmin === true` via the user repository — same gate
 * the existing `PluginAllowlistController` (EW-693 T23) and
 * `AdminUsageController` (EW-602) sit behind.
 *
 * **Audit:**
 * Mutations route through `TenantJobRuntimeService` which emits an
 * `operator_allowlist_change` audit row with `before` / `after`
 * snapshots of the per-tenant allow-list. The same service emits
 * the boot-time `operator_allowlist_boot` row for the global
 * snapshot.
 *
 * **No UI in P5.1** — operators manage this surface via direct API
 * (curl / OpenAPI explorer / scripts). A future P5.2 may add an
 * admin UI; nothing here precludes it.
 */
import {
    Body,
    Controller,
    Delete,
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
import { CurrentUser } from '../../auth/decorators/user.decorator';
import { IsPlatformAdminGuard } from '../../auth/guards/platform-admin.guard';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { config } from '../../config/constants';
import { TenantJobRuntimeService } from '../../account/tenant-job-runtime/tenant-job-runtime.service';
import {
    TENANT_JOB_RUNTIME_PROVIDER_IDS,
    type TenantJobRuntimeProviderId,
} from '../../account/tenant-job-runtime/dto/upsert-tenant-job-runtime.dto';
import {
    ReplaceTenantRuntimeAllowlistDto,
    TenantRuntimeAllowlistResponseDto,
} from './dto/tenant-runtime-allowlist.dto';

@ApiTags('Operator · Tenant Runtime Allowlist')
@ApiBearerAuth('JWT-auth')
@Controller('api/operator/tenants/:tenantId/runtime-allowlist')
@UseGuards(IsPlatformAdminGuard)
export class OperatorTenantRuntimeAllowlistController {
    constructor(private readonly service: TenantJobRuntimeService) {}

    @Get()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List the per-tenant runtime provider allow-list rows for a tenant',
        description:
            'Returns the per-tenant overlay rows. Empty array = the tenant inherits the ' +
            'global allow-list. The response also echoes the current gating-flag state ' +
            'so the caller can tell at a glance whether the rows actually take effect.',
    })
    @ApiParam({ name: 'tenantId', type: String, format: 'uuid' })
    @ApiResponse({ status: 200, type: TenantRuntimeAllowlistResponseDto })
    @ApiResponse({ status: 403, description: 'Caller is not a platform admin' })
    async list(
        @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    ): Promise<TenantRuntimeAllowlistResponseDto> {
        const providerIds = await this.service.listTenantAllowlist(tenantId);
        return {
            tenantId,
            providerIds,
            perTenantGatingEnabled: config.tenantJobRuntime.isPerTenantGatingEnabled(),
        };
    }

    @Put()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Replace the per-tenant runtime provider allow-list (atomic)',
        description:
            'Atomically replaces the whole per-tenant allow-list row set in a single ' +
            'transaction (delete-then-insert). Each `providerIds[]` entry must be in the ' +
            'static bundled list (`TENANT_JOB_RUNTIME_PROVIDER_IDS`). An empty array ' +
            'clears the per-tenant overlay (tenant falls back to inheriting the global list). ' +
            'Emits an `operator_allowlist_change` audit row.',
    })
    @ApiParam({ name: 'tenantId', type: String, format: 'uuid' })
    @ApiResponse({ status: 200, type: TenantRuntimeAllowlistResponseDto })
    @ApiResponse({
        status: 400,
        description: 'Validation failed (unknown providerId or duplicates)',
    })
    @ApiResponse({ status: 403, description: 'Caller is not a platform admin' })
    async replace(
        @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
        @Body() dto: ReplaceTenantRuntimeAllowlistDto,
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<TenantRuntimeAllowlistResponseDto> {
        const providerIds = await this.service.replaceTenantAllowlist(
            tenantId,
            dto.providerIds,
            auth.userId,
        );
        return {
            tenantId,
            providerIds,
            perTenantGatingEnabled: config.tenantJobRuntime.isPerTenantGatingEnabled(),
        };
    }

    @Delete(':providerId')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Remove a single provider from the per-tenant allow-list',
        description:
            'Idempotent — deleting a row that does not exist returns 404. Use the PUT ' +
            'endpoint to clear the whole overlay in one call. Emits an ' +
            '`operator_allowlist_change` audit row when a row is actually removed.',
    })
    @ApiParam({ name: 'tenantId', type: String, format: 'uuid' })
    @ApiParam({ name: 'providerId', enum: TENANT_JOB_RUNTIME_PROVIDER_IDS })
    @ApiResponse({ status: 200, type: TenantRuntimeAllowlistResponseDto })
    @ApiResponse({ status: 403, description: 'Caller is not a platform admin' })
    @ApiResponse({ status: 404, description: 'Provider not in the per-tenant allow-list' })
    async removeEntry(
        @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
        @Param('providerId') providerId: string,
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<TenantRuntimeAllowlistResponseDto> {
        if (!this.isKnownProvider(providerId)) {
            // Reject unknown providerId at the controller layer so the
            // service never has to think about "what if the path param
            // doesn't match the static enum". Same posture as the DTO
            // validator on the PUT body.
            throw new NotFoundException(`provider '${providerId}' is not a known runtime`);
        }
        const removed = await this.service.deleteTenantAllowlistEntry(
            tenantId,
            providerId,
            auth.userId,
        );
        if (!removed) {
            throw new NotFoundException(
                `provider '${providerId}' is not in the per-tenant allow-list for tenant ${tenantId}`,
            );
        }
        const providerIds = await this.service.listTenantAllowlist(tenantId);
        return {
            tenantId,
            providerIds,
            perTenantGatingEnabled: config.tenantJobRuntime.isPerTenantGatingEnabled(),
        };
    }

    private isKnownProvider(value: string): value is TenantJobRuntimeProviderId {
        return (TENANT_JOB_RUNTIME_PROVIDER_IDS as readonly string[]).includes(value);
    }
}
