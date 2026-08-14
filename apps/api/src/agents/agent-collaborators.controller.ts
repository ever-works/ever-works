import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Put,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AgentCollaboratorRepository, AgentsService } from '@ever-works/agent/agents';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { UpdateAgentCollaboratorDto } from './dto/agent.dto';

/**
 * Agent Collaborators — the per-agent sub-agent delegation allow-list.
 *
 *   GET    /api/agents/:id/collaborators                       candidates + state
 *   PUT    /api/agents/:id/collaborators/:collaboratorAgentId  upsert {enabled}
 *   DELETE /api/agents/:id/collaborators/:collaboratorAgentId  remove the rule
 *
 * GET returns EVERY other agent of the owner as a candidate row (the
 * surface is fully dynamic — new agents appear automatically), each
 * carrying its configured state: `configured` (a rule row exists) and
 * `enabled` (the rule permits delegation right now). No rows at all
 * means the agent keeps the legacy self-only delegation default.
 *
 * Enforcement does NOT live here — the delegation runner checks the
 * rows on every delegation. This controller only edits them.
 *
 * Cross-user access to either end of the edge = 404, never 403
 * (architecture/security §9 — no existence leak). Both lookups go
 * through `AgentsService.getOne`, the same gate every other per-Agent
 * endpoint uses.
 */
export interface AgentCollaboratorCandidateRow {
    agentId: string;
    name: string;
    slug: string;
    title: string | null;
    status: string;
    avatarMode: string;
    avatarIcon: string | null;
    /** A rule row exists for this pair (enabled OR disabled). */
    configured: boolean;
    /** The rule currently permits delegation. False when unconfigured. */
    enabled: boolean;
}

@ApiTags('agents')
@Controller('api/agents/:id/collaborators')
export class AgentCollaboratorsController {
    constructor(
        private readonly service: AgentsService,
        private readonly collaborators: AgentCollaboratorRepository,
    ) {}

    /**
     * Candidate cap. The list endpoint pages through the owner's agents
     * via the same repository filter as GET /api/agents; one page of 200
     * comfortably covers every real roster while bounding the response.
     */
    private static readonly MAX_CANDIDATES = 200;

    @Get()
    @ApiOperation({
        summary:
            "List collaborator candidates for this Agent: every OTHER agent of the owner, with each row's configured/enabled allow-list state.",
    })
    @HttpCode(HttpStatus.OK)
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ data: AgentCollaboratorCandidateRow[] }> {
        // Cross-user 404 via the service-level ownership gate.
        await this.service.getOne(auth.userId, id);
        const [{ rows }, rules] = await Promise.all([
            this.service.list(auth.userId, {
                limit: AgentCollaboratorsController.MAX_CANDIDATES,
                offset: 0,
            }),
            this.collaborators.listForAgent(id),
        ]);
        const ruleByCollaborator = new Map(
            rules.map((rule) => [rule.collaboratorAgentId, rule] as const),
        );
        return {
            data: rows
                .filter((agent) => agent.id !== id)
                .map((agent) => {
                    const rule = ruleByCollaborator.get(agent.id);
                    return {
                        agentId: agent.id,
                        name: agent.name,
                        slug: agent.slug,
                        title: agent.title ?? null,
                        status: agent.status,
                        avatarMode: agent.avatarMode,
                        avatarIcon: agent.avatarIcon ?? null,
                        configured: Boolean(rule),
                        enabled: Boolean(rule?.enabled),
                    };
                }),
        };
    }

    @Put(':collaboratorAgentId')
    @ApiOperation({
        summary:
            'Enable/disable an agent as a collaborator of this Agent (idempotent upsert of the allow-list rule).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async upsert(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('collaboratorAgentId', ParseUUIDPipe) collaboratorAgentId: string,
        @Body() body: UpdateAgentCollaboratorDto,
    ): Promise<{ agentId: string; collaboratorAgentId: string; enabled: boolean }> {
        if (id === collaboratorAgentId) {
            throw new BadRequestException('An agent cannot be its own collaborator.');
        }
        // BOTH ends must be the caller's agents — a foreign id on either
        // side 404s with no existence leak.
        await this.service.getOne(auth.userId, id);
        await this.service.getOne(auth.userId, collaboratorAgentId);
        // tenantId/organizationId are left to `ScopeStampingSubscriber`,
        // which stamps them on insert for every entity declaring both
        // Tier C columns (the AgentDto does not carry them).
        const row = await this.collaborators.upsert({
            userId: auth.userId,
            agentId: id,
            collaboratorAgentId,
            enabled: body.enabled,
        });
        return {
            agentId: row.agentId,
            collaboratorAgentId: row.collaboratorAgentId,
            enabled: row.enabled,
        };
    }

    @Delete(':collaboratorAgentId')
    @ApiOperation({
        summary: 'Remove the collaborator rule entirely (falls back to unconfigured). Idempotent.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('collaboratorAgentId', ParseUUIDPipe) collaboratorAgentId: string,
    ): Promise<{ removed: boolean }> {
        await this.service.getOne(auth.userId, id);
        const removed = await this.collaborators.remove(id, collaboratorAgentId);
        return { removed };
    }
}
