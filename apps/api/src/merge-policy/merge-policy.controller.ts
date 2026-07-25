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
import { AgentRepository } from '@ever-works/agent/database';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ResolveMergePolicyQueryDto } from './dto/resolve-merge-policy.dto';

/**
 * Merge-policy matrix (Wave 3, founder decision D4) — read-only preview
 * of the EFFECTIVE policy:
 *
 *   GET /api/merge-policy/resolve?workId=&agentId=
 *     → { policy, source, chain }
 *
 * The response deliberately includes the whole `chain` (least → most
 * specific, starting at the platform default) with the fields each scope
 * contributed. "Agents may not merge here" is only a usable answer if the
 * UI can also say WHERE that came from and which knob to change.
 *
 * WRITES live on the existing entity surfaces — `PATCH /api/works/:id`,
 * `PATCH /api/agents/:id` and `PATCH /api/organizations/:id` each accept
 * an additive optional `mergePolicy` object. The Tenant scope is
 * resolvable and storable (`tenants.mergePolicy`) but has no HTTP write
 * surface: Tenants are internal-only and never rendered in the UI, so an
 * operator-level ceiling there is set out-of-band today. That is a
 * documented gap, not an oversight.
 *
 * Security: owner-scoped on BOTH inputs before any resolution runs —
 * `WorkOwnershipService.ensureAccess` for the Work (cross-user Works 404
 * with no existence leak) and an owner-filtered lookup for the Agent.
 * Without this the endpoint would be a cross-tenant policy oracle.
 */
@ApiTags('merge-policy')
@Controller('api/merge-policy')
export class MergePolicyController {
    constructor(
        private readonly mergePolicy: MergePolicyService,
        private readonly ownership: WorkOwnershipService,
        private readonly agents: AgentRepository,
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
        if (!query.workId && !query.agentId) {
            throw new BadRequestException('Provide workId and/or agentId.');
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

        return this.mergePolicy.resolve({
            workId: query.workId ?? null,
            agentId: query.agentId ?? null,
        });
    }
}
