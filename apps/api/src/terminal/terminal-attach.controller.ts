import {
    Controller,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Post,
    Get,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AgentsService } from '@ever-works/agent/agents';
import { AgentRunRepository } from '@ever-works/agent/database';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { TerminalAttachService } from './terminal-attach.service';
import { TerminalRelayRegistry } from './terminal-relay.registry';

/**
 * Terminal attach + status endpoints (streaming-terminal M3).
 *
 * Nested under the agent-run resource, mirroring the existing
 * `GET /api/agents/:id/runs/:runId` authorization exactly: agent
 * ownership (`AgentsService.getOne`) + user-scoped run lookup + agentId
 * match — cross-user or cross-agent runIds 404 with no existence leak.
 *
 * Role v1: the run's owner attaches as `driver`. The richer matrix
 * (work-member viewers, agent guardrail flag) rides the policy-matrix
 * milestone — fail-closed until then: non-owners simply 404.
 */
@ApiTags('terminal')
@Controller('api/agents/:id/runs/:runId/terminal')
export class TerminalAttachController {
    constructor(
        private readonly agents: AgentsService,
        private readonly runs: AgentRunRepository,
        private readonly attach: TerminalAttachService,
        private readonly registry: TerminalRelayRegistry,
    ) {}

    private async authorizeRun(userId: string, agentId: string, runId: string) {
        await this.agents.getOne(userId, agentId);
        const run = await this.runs.findByIdAndUser(runId, userId);
        if (!run || run.agentId !== agentId) {
            throw new NotFoundException(`AgentRun ${runId} not found.`);
        }
        return run;
    }

    @Post('attach-token')
    @ApiOperation({
        summary:
            'Mint a short-lived signed attach token for this run’s terminal WebSocket. ' +
            'Present it in the FIRST WebSocket message (never in the URL).',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async mintAttachToken(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Param('runId', ParseUUIDPipe) runId: string,
    ): Promise<{ token: string; wsPath: string; role: string; expiresInSec: number }> {
        await this.authorizeRun(auth.userId, agentId, runId);
        const { token, expiresInSec } = this.attach.mint({
            userId: auth.userId,
            runId,
            role: 'driver',
        });
        return { token, wsPath: `/ws/terminal/${runId}`, role: 'driver', expiresInSec };
    }

    @Get()
    @ApiOperation({ summary: 'Live terminal session status for this run (relay view).' })
    @HttpCode(HttpStatus.OK)
    async status(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Param('runId', ParseUUIDPipe) runId: string,
    ) {
        await this.authorizeRun(auth.userId, agentId, runId);
        return this.registry.getStatus(runId);
    }
}
