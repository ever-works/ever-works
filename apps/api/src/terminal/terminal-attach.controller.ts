import {
    ConflictException,
    Controller,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Optional,
    Param,
    ParseUUIDPipe,
    Post,
    ServiceUnavailableException,
    Get,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AgentsService, TerminalSessionLauncher } from '@ever-works/agent/agents';
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
        // Appended LAST + @Optional() so every positional
        // `new TerminalAttachController(...)` in the existing specs keeps
        // compiling, and an install with no job runtime answers 503 on
        // start instead of failing to boot the controller.
        @Optional() private readonly launcher?: TerminalSessionLauncher,
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

    /**
     * Start a terminal session for this run.
     *
     * The explicit user affordance behind the Terminal tab: without it the
     * `terminal-session` job had no producer anywhere in the platform, so a
     * user could mint attach tokens and open a socket onto a channel that
     * would never carry a single frame.
     *
     * The session argv is resolved SERVER-SIDE (operator configuration,
     * Linux-shell default) and is deliberately not accepted from the body —
     * this endpoint opens the user's own worker shell, it is not a generic
     * remote-exec surface.
     *
     * 202 → dispatched. 409 → a session is already live for this run, or
     * the run itself is finished (nothing left to attach a shell to). 404 →
     * the same no-existence-leak answer every other run-scoped route gives.
     */
    @Post('start')
    @ApiOperation({
        summary:
            'Start a terminal session for this run (dispatches the terminal-session job). ' +
            '409 when a session is already live for the run.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async start(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Param('runId', ParseUUIDPipe) runId: string,
    ): Promise<{ started: true; runId: string; state: 'starting' }> {
        await this.authorizeRun(auth.userId, agentId, runId);
        if (!this.launcher) {
            throw new ServiceUnavailableException(
                'Terminal sessions are unavailable on this install — no background job runtime is wired.',
            );
        }

        const outcome = await this.launcher.startForRun({
            userId: auth.userId,
            agentId,
            runId,
            // Asking for a terminal on a run IS the statement that the run
            // wants a long-lived interactive session.
            markPersistent: true,
        });

        // `in` narrowing, not `if (outcome.started)`: this app compiles with
        // `strictNullChecks: false`, under which truthiness narrowing on a
        // `true | false` discriminant does not split the union.
        if (!('reason' in outcome)) {
            return { started: true, runId: outcome.runId, state: 'starting' };
        }
        switch (outcome.reason) {
            case 'run-not-found':
                throw new NotFoundException(`AgentRun ${runId} not found.`);
            case 'session-already-live':
                throw new ConflictException(
                    `AgentRun ${runId} already has a live terminal session — attach to it instead of starting another.`,
                );
            case 'run-not-live':
                throw new ConflictException(
                    `AgentRun ${runId} has finished — a terminal session can only be started for a queued or running run.`,
                );
            case 'dispatcher-unavailable':
                throw new ServiceUnavailableException(
                    'Terminal sessions are unavailable on this install — no background job runtime is wired.',
                );
            default:
                throw new ConflictException(
                    `Terminal session could not be started for AgentRun ${runId}.`,
                );
        }
    }

    @Get()
    @ApiOperation({
        summary:
            'Terminal session status for this run — live relay view merged with ' +
            'the persisted AgentRun terminal columns (M4).',
    })
    @HttpCode(HttpStatus.OK)
    async status(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Param('runId', ParseUUIDPipe) runId: string,
    ) {
        const run = await this.authorizeRun(auth.userId, agentId, runId);
        return {
            // Live relay view (empty/exists:false when no session is
            // resident in this replica's registry).
            ...this.registry.getStatus(runId),
            // Persisted lifecycle (survives replica restarts; the source
            // of truth for dead sessions and the Resume affordance).
            run: {
                persistent: run.persistent ?? false,
                terminalState: run.terminalState ?? null,
                terminalEndedReason: run.terminalEndedReason ?? null,
                terminalProviderId: run.terminalProviderId ?? null,
                // Presence only — the resume id itself stays server-side.
                hasCliSession: Boolean(run.cliSessionId),
                lastHeartbeatAt: run.lastHeartbeatAt?.toISOString() ?? null,
                lastFrameSeq: run.lastFrameSeq ?? null,
            },
        };
    }
}
