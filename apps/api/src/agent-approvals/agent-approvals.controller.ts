import {
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    AgentApprovalsService,
    type AgentActionProposalDto,
} from '@ever-works/agent/agent-approvals';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ListAgentApprovalsQueryDto } from './dto/agent-approval.dto';

/**
 * Agent Action Approval Queue — API surface.
 *
 *   GET  /api/agent-approvals             list my proposals (?status= filter, default pending)
 *   GET  /api/agent-approvals/:id         get one
 *   POST /api/agent-approvals/:id/approve approve a pending proposal
 *   POST /api/agent-approvals/:id/reject  reject a pending proposal
 *
 * Auth is enforced by the global `AuthSessionGuard`; `@CurrentUser`
 * threads the user id. Cross-user reads return 404 (no existence leak
 * via 403), and re-deciding an already-decided proposal returns 409 —
 * both enforced in `AgentApprovalsService`.
 *
 * Rate limits: writes (approve / reject) at 30/min/user; GET routes use
 * the default global throttler.
 */
@ApiTags('agent-approvals')
@Controller('api/agent-approvals')
export class AgentApprovalsController {
    constructor(private readonly service: AgentApprovalsService) {}

    @Get()
    @ApiOperation({
        summary:
            'List my Agent action proposals (defaults to the pending queue; ?status= to filter)',
    })
    @HttpCode(HttpStatus.OK)
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListAgentApprovalsQueryDto,
    ): Promise<{
        data: AgentActionProposalDto[];
        meta: { total: number; limit: number; offset: number };
    }> {
        const limit = query.limit ?? 50;
        const offset = query.offset ?? 0;
        const { rows, total } = await this.service.list(auth.userId, {
            status: query.status,
            organizationId: query.organizationId ?? null,
            limit,
            offset,
        });
        return { data: rows, meta: { total, limit, offset } };
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get one Agent action proposal' })
    @HttpCode(HttpStatus.OK)
    async getOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<AgentActionProposalDto> {
        return this.service.getOne(auth.userId, id);
    }

    @Post(':id/approve')
    @ApiOperation({
        summary: 'Approve a pending proposal (records the decision; 409 if already decided)',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async approve(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<AgentActionProposalDto> {
        return this.service.decide(auth.userId, id, 'approved');
    }

    @Post(':id/reject')
    @ApiOperation({
        summary: 'Reject a pending proposal (records the decision; 409 if already decided)',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async reject(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<AgentActionProposalDto> {
        return this.service.decide(auth.userId, id, 'rejected');
    }
}
