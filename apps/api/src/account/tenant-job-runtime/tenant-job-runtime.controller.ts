import {
    Body,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    Put,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import {
    TenantJobRuntimeConfigResponseDto,
    TenantJobRuntimeRotateResponseDto,
} from './dto/tenant-job-runtime-response.dto';
import { UpsertTenantJobRuntimeConfigDto } from './dto/upsert-tenant-job-runtime.dto';
import { TenantJobRuntimeService } from './tenant-job-runtime.service';

/**
 * EW-742 / EW-746 (P2.0 — tenant-job-runtime overlay admin API) — five
 * admin endpoints under `/api/account/job-runtime/...` for the tenant
 * owner to inspect + edit the per-tenant job-runtime overlay.
 *
 * Spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * Plan: [`plan.md` §4 API surface](../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md#4-api-surface)
 * Tasks: [`tasks.md` T14](../../../../docs/specs/features/tenant-job-runtime-overlay/tasks.md)
 *
 * **Route shape:** plan.md §4 originally drafted these as
 * `/api/admin/tenants/:tenantId/job-runtime` (a platform-admin facing
 * surface acting on any tenant). tasks.md T14 — the actual implementation
 * directive — places them at `/api/account/job-runtime/config` (the
 * tenant owner acting on their OWN tenant). We follow tasks.md: the
 * Ever Works tenant model is 1 User : 1 Tenant (per
 * [tenants spec §1.1](../../../../docs/specs/features/tenants-and-organizations/spec.md)),
 * so "admin acting on another tenant" has no caller today. A separate
 * `/api/admin/tenants/:tenantId/job-runtime` platform-admin surface can
 * be added later if/when multi-tenant-per-user lands; this controller
 * stays unchanged because the data model is the same. Inconsistency
 * flagged in the implementing PR.
 *
 * **Auth model:** `AuthSessionGuard` (global) ensures `req.user.userId` is
 * set. `SessionScopeGuard` (also global) hydrates `req.user.tenantId`
 * from the User row. Every handler refuses with 403 when `tenantId` is
 * null — a user with no Tenant cannot own an overlay. There is NO
 * separate "tenant.admin" role check because of the 1:1 model: the only
 * user with access to a Tenant's rows IS its owner. A future
 * Organization-member RBAC layer would slot in as a new guard alongside
 * the existing checks; nothing here precludes it.
 *
 * **Tenant resolution:** `tenantId` is ALWAYS the authenticated user's
 * own (`req.user.tenantId`). There is no `:tenantId` path param so a
 * compromised UI client can never confuse the server about which
 * tenant's row to mutate. This is the explicit decision per the
 * implementing prompt: "if it's user-scoped (admin manages OWN
 * tenant), drop the `:tenantId` param".
 */
@ApiTags('Account · Tenant Job Runtime')
@ApiBearerAuth('JWT-auth')
@Controller('api/account/job-runtime')
export class TenantJobRuntimeController {
    constructor(private readonly service: TenantJobRuntimeService) {}

    @Get('config')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Read the current tenant job-runtime overlay (credentials redacted)',
        description:
            'Returns the synthetic `mode: inherit` default when no overlay row exists ' +
            '(FR-7 NULL-safe — the caller never has to special-case 404).',
    })
    @ApiResponse({ status: 200, type: TenantJobRuntimeConfigResponseDto })
    async getConfig(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<TenantJobRuntimeConfigResponseDto> {
        const tenantId = this.requireTenant(auth);
        return this.service.getConfig(tenantId);
    }

    @Put('config')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Upsert the tenant job-runtime overlay',
        description:
            'Validates `providerId` against the static allow-list, enforces ' +
            '`credentialsSecretRef` presence when `mode != inherit`, writes the row, ' +
            'and emits a `create` / `update` audit entry. Bumps `credentialVersion` ' +
            'when `credentialsSecretRef` changes (graceful drain — ADR-017 §3).',
    })
    @ApiResponse({ status: 200, type: TenantJobRuntimeConfigResponseDto })
    @ApiResponse({
        status: 400,
        description: 'Validation failed (invalid provider or mode/ref combination)',
    })
    @ApiResponse({ status: 403, description: 'Caller has no Tenant (user not yet upgraded)' })
    async upsertConfig(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() dto: UpsertTenantJobRuntimeConfigDto,
    ): Promise<TenantJobRuntimeConfigResponseDto> {
        const tenantId = this.requireTenant(auth);
        return this.service.upsertConfig(tenantId, auth.userId, dto);
    }

    @Post('rotate')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Rotate the tenant credential — graceful drain',
        description:
            'Bumps `credentialVersion`. In-flight runs keep their captured ' +
            'version per ADR-017 §3; new enqueues see the bumped version. Emits a ' +
            '`rotate` audit row.',
    })
    @ApiResponse({ status: 200, type: TenantJobRuntimeRotateResponseDto })
    @ApiResponse({ status: 404, description: 'Tenant has no overlay row (mode = inherit)' })
    async rotateCredential(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<TenantJobRuntimeRotateResponseDto> {
        const tenantId = this.requireTenant(auth);
        return this.service.rotateCredential(tenantId, auth.userId);
    }

    /**
     * Force-invalidate is the operator break-glass kill (FR-6). Rate
     * limited to ≤1 call per minute per tenant via the `long` throttler
     * bucket (60s TTL, limit 1) — a compromised admin session cannot
     * churn the credential version faster than the worker can drain.
     *
     * @nestjs/throttler keys by IP by default, NOT by tenantId. That's
     * acceptable here: the route requires authentication and a tenant,
     * and the throttle is per-route per-IP per minute — combined with
     * the auth + tenant gates it's effectively per-tenant for any
     * single attacker session. A stricter per-tenant key would require
     * a custom ThrottlerGuard subclass and is tracked as a follow-up.
     */
    @Post('force-invalidate')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 1, ttl: 60_000 } })
    @ApiOperation({
        summary:
            'Force-invalidate the tenant credential — hard kill (P2.0: audit + version bump only)',
        description:
            'Rate-limited to 1 call / 60s. P2.0 implementation bumps `credentialVersion` ' +
            'and emits a `force_invalidate` audit row. The actual in-flight run kill ' +
            '(FR-6 hard kill) lands with the dispatcher tenancy work in P3+.',
    })
    @ApiResponse({ status: 200, type: TenantJobRuntimeRotateResponseDto })
    @ApiResponse({ status: 404, description: 'Tenant has no overlay row (mode = inherit)' })
    @ApiResponse({ status: 429, description: 'Rate limited (max 1 call / 60s)' })
    async forceInvalidate(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<TenantJobRuntimeRotateResponseDto> {
        const tenantId = this.requireTenant(auth);
        return this.service.forceInvalidate(tenantId, auth.userId);
    }

    @Delete('config')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Revert the tenant job-runtime overlay to inherit',
        description:
            'Sets `mode = inherit`, clears `credentialsSecretRef`, bumps ' +
            '`credentialVersion` so workers holding the old credential snapshot ' +
            'drain gracefully, and emits a `delete` audit row. Idempotent — a ' +
            'tenant already in inherit mode returns the synthetic default.',
    })
    @ApiResponse({ status: 200, type: TenantJobRuntimeConfigResponseDto })
    async revertToInherit(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<TenantJobRuntimeConfigResponseDto> {
        const tenantId = this.requireTenant(auth);
        return this.service.revertToInherit(tenantId, auth.userId);
    }

    /**
     * Resolve the caller's tenant or refuse with 403. Centralised so the
     * five handlers don't repeat the null-check + error message and so a
     * future role-aware tenant resolver has exactly one place to live.
     */
    private requireTenant(auth: AuthenticatedUser): string {
        // `tenantId` is hydrated by `SessionScopeGuard` (global). When the
        // user hasn't been upgraded to a Tenant yet (no Organization
        // created — EW-658 lazy bootstrap), the field is `null` and the
        // overlay concept doesn't apply.
        const tenantId = auth.tenantId;
        if (!tenantId) {
            throw new ForbiddenException(
                'Tenant required to manage the job-runtime overlay. Create an Organization first.',
            );
        }
        return tenantId;
    }
}
