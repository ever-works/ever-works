import {
    BadRequestException,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ResolvedMergePolicy } from '@ever-works/contracts';
import { MergePolicyService } from '@ever-works/agent/policy';
import {
    AgentRepository,
    OrganizationRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ResolveMergePolicyQueryDto } from './dto/resolve-merge-policy.dto';

/**
 * Merge-policy matrix (Wave 3, founder decision D4) — read-only preview
 * of the EFFECTIVE policy:
 *
 *   GET /api/merge-policy/resolve?workId=&agentId=&organizationId=
 *     → { policy, source, chain }
 *
 * The response deliberately includes the whole `chain` (least → most
 * specific, starting at the platform default) with the fields each scope
 * contributed. "Agents may not merge here" is only a usable answer if the
 * UI can also say WHERE that came from and which knob to change.
 *
 * WRITES live on the existing entity surfaces — `PATCH /api/works/:id`,
 * `PATCH /api/agents/:id` and `PATCH /api/organizations/:id` each accept
 * an additive optional `mergePolicy` object. The Tenant scope is the one
 * exception: it owns no user-facing entity, so its write is
 * `PUT /api/operator/tenants/:tenantId/merge-policy` behind
 * `IsPlatformAdminGuard` (a tenant ceiling that the orgs beneath it can
 * set is not a ceiling). Its contribution is still visible here as a link
 * in the returned `chain`.
 *
 * Security: every input is scope-checked BEFORE any resolution runs —
 * `WorkOwnershipService.ensureAccess` for the Work (cross-user Works 404
 * with no existence leak), an owner-filtered lookup for the Agent, and a
 * same-Tenant check for the Organization. Without this the endpoint would
 * be a cross-tenant policy oracle.
 */
@ApiTags('merge-policy')
@Controller('api/merge-policy')
export class MergePolicyController {
    constructor(
        private readonly mergePolicy: MergePolicyService,
        private readonly ownership: WorkOwnershipService,
        private readonly agents: AgentRepository,
        private readonly organizations: OrganizationRepository,
        private readonly users: UserRepository,
    ) {}

    @Get('resolve')
    @ApiOperation({
        summary:
            'Preview the effective merge policy for a Work and/or Agent, with the resolution chain (tenant → organization → Work → Agent over the platform default).',
    })
    @HttpCode(HttpStatus.OK)
    async resolve(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ResolveMergePolicyQueryDto,
    ): Promise<ResolvedMergePolicy> {
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
            // Same-Tenant check as `OrganizationService.update` — an
            // Organization outside the caller's Tenant 404s with no
            // existence leak, so the org layer of the chain can never
            // become a cross-tenant oracle either.
            const user = await this.users.findById(auth.userId);
            const org = await this.organizations.findById(query.organizationId);
            if (!user?.tenantId || !org || org.tenantId !== user.tenantId) {
                throw new NotFoundException(
                    `Organization with id '${query.organizationId}' not found`,
                );
            }
        }

        return this.mergePolicy.resolve({
            workId: query.workId ?? null,
            agentId: query.agentId ?? null,
            organizationId: query.organizationId ?? null,
        });
    }
}
