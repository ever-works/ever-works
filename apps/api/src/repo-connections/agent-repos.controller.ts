import {
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
import { RepoRegistryService } from '@ever-works/agent/services';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { SetAgentRepoAttachmentDto } from './dto/repo-connection.dto';

/**
 * Repository registry (Feature G) — Agent ↔ repo grants. Feeds the
 * "Repositories" card on agent settings today and the per-agent
 * Capabilities page later.
 *
 *   GET    /api/agents/:agentId/repos                       registry + attachment state
 *   PUT    /api/agents/:agentId/repos/:repoConnectionId     attach / set enabled
 *   DELETE /api/agents/:agentId/repos/:repoConnectionId     detach
 *
 * Both the agent and the repo must belong to the caller; anything else
 * reads as 404 (no existence leak via 403).
 */
@ApiTags('repo-connections')
@Controller('api/agents/:agentId/repos')
export class AgentReposController {
    constructor(private readonly registry: RepoRegistryService) {}

    @Get()
    @ApiOperation({ summary: "List registry repositories with this agent's attachment state." })
    @HttpCode(HttpStatus.OK)
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('agentId', ParseUUIDPipe) agentId: string,
    ) {
        return this.registry.listForAgent(auth.userId, agentId);
    }

    @Put(':repoConnectionId')
    @ApiOperation({ summary: 'Attach a repository to the agent (or set the enabled flag).' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async set(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('agentId', ParseUUIDPipe) agentId: string,
        @Param('repoConnectionId', ParseUUIDPipe) repoConnectionId: string,
        @Body() dto: SetAgentRepoAttachmentDto,
    ) {
        return this.registry.setAttachment(auth.userId, agentId, repoConnectionId, dto.enabled);
    }

    @Delete(':repoConnectionId')
    @ApiOperation({ summary: 'Detach a repository from the agent.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('agentId', ParseUUIDPipe) agentId: string,
        @Param('repoConnectionId', ParseUUIDPipe) repoConnectionId: string,
    ) {
        return this.registry.removeAttachment(auth.userId, agentId, repoConnectionId);
    }
}
