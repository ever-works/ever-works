import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    FleetScheduleService,
    FleetSessionScheduleService,
    type FleetScheduleActor,
} from '@ever-works/agent/fleet';
import {
    FLEET_SCHEDULE_HISTORY,
    FLEET_SCHEDULE_WRITES_PER_MINUTE,
    type FleetAgentSessionScheduleView,
    type FleetCommandRunView,
    type FleetScheduleAgentOption,
    type FleetSchedulePauseAllResult,
    type FleetScheduleView,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetCommandsEnabledGuard } from '../commands/fleet-commands-enabled.guard';
import {
    DeleteFleetScheduleDto,
    ListFleetCommandRunsQueryDto,
    UpdateFleetScheduleDto,
} from '../commands/dto/fleet-commands.dto';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { ScopeContextService } from '../../scope';
import {
    ConfirmFleetScheduleDto,
    CreateAgentSessionScheduleDto,
    CreateFleetScheduleDto,
    ListFleetSchedulesQueryDto,
    UndoPauseAllSchedulesDto,
} from './dto/fleet-schedules.dto';

function actorOf(auth: AuthenticatedUser): FleetScheduleActor {
    return { userId: auth.userId };
}

/**
 * Schedules on computers (FL-13 P2, CONTRACTS §11.2 revision 18) — the
 * resource routes of a Command schedule, `/api/fleet/schedules[/:id[/runs|
 * /run|/pause|/resume]]`: the paths FL-19's tool catalogue names for the
 * `fleet_schedules_*` Agent, MCP and CLI tools. They sit beside the P1 paths
 * (a schedule is a Command with a cadence: `POST /commands` with a cadence,
 * `PATCH` / `DELETE /commands/:id`, and the Schedules view's
 * `/api/schedules/node_schedule:<id>/…` controls), all served by
 * `FleetScheduleService` — one writer, one chain: the shape, the write rate,
 * the computer's `schedules` audience, the kill switch, 50 per computer, the
 * confirmation (`confirm: true`, CONTRACTS §2.2), the row, the audit row, the
 * sync. Dark unless `FLEET_COMMANDS_ENABLED`.
 */
@ApiTags('fleet')
@Controller('api/fleet/schedules')
@UseGuards(FleetEnabledGuard, FleetCommandsEnabledGuard)
export class FleetSchedulesController {
    constructor(private readonly schedules: FleetScheduleService) {}

    @Get()
    @ApiOperation({
        summary:
            "My Command schedules on computers (optionally on one computer): name, command, when it runs on the computer's clock, next fire, last run, sync state.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListFleetSchedulesQueryDto,
    ): Promise<{ schedules: FleetScheduleView[] }> {
        return {
            schedules: await this.schedules.listForUser(actorOf(auth), query.nodeId ? { nodeId: query.nodeId } : {}),
        };
    }

    @Post()
    @ApiOperation({
        summary:
            "Schedule a command on ONE of my computers, on that computer's own clock. Without `confirm: true` it answers 409 `confirmation_required` with the shell, the folder and the next three fires.",
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: FLEET_SCHEDULE_WRITES_PER_MINUTE, ttl: 60_000 } })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateFleetScheduleDto,
    ): Promise<FleetScheduleView> {
        return this.schedules.create(actorOf(auth), {
            name: body.name,
            nodeId: body.nodeId,
            command: body.command,
            ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
            cadence: body.cadence,
            ...(body.confirm !== undefined ? { confirm: body.confirm } : {}),
        });
    }

    @Get(':id')
    @ApiOperation({ summary: 'One of my Command schedules.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 240, ttl: 60_000 } })
    async get(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetScheduleView> {
        return this.schedules.get(id, actorOf(auth));
    }

    @Patch(':id')
    @ApiOperation({
        summary:
            'Edit a schedule (name, command, folder, cadence) or move it with `nodeId`; a move or a change of what runs needs `confirm: true`.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_SCHEDULE_WRITES_PER_MINUTE, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateFleetScheduleDto,
    ): Promise<FleetScheduleView> {
        return this.schedules.update(id, actorOf(auth), {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.nodeId !== undefined ? { nodeId: body.nodeId } : {}),
            ...(body.command !== undefined ? { command: body.command } : {}),
            ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
            ...(body.cadence !== undefined ? { cadence: body.cadence } : {}),
            ...(body.confirm !== undefined ? { confirm: body.confirm } : {}),
        });
    }

    @Delete(':id')
    @ApiOperation({
        summary: 'Delete a schedule (`confirm: true`); it stops on the computer and its runs stay readable for 30 days.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_SCHEDULE_WRITES_PER_MINUTE, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: DeleteFleetScheduleDto,
    ): Promise<FleetScheduleView> {
        return this.schedules.remove(id, actorOf(auth), body?.confirm === true);
    }

    @Get(':id/runs')
    @ApiOperation({ summary: "A schedule's last runs, newest first (at most 30), with the fire each belongs to." })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 240, ttl: 60_000 } })
    async runs(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: ListFleetCommandRunsQueryDto,
    ): Promise<FleetCommandRunView[]> {
        return this.schedules.runs(id, actorOf(auth), query.limit ?? FLEET_SCHEDULE_HISTORY);
    }

    @Post(':id/run')
    @ApiOperation({
        summary:
            'Run a schedule now on its computer (`confirm: true`; the next fire does not move). `busy` while a run is going, `unreachable` while the computer is offline.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async run(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: ConfirmFleetScheduleDto,
    ): Promise<{ runId: string; startedAt: string; nextRunAt: string | null; schedule: FleetScheduleView }> {
        const started = await this.schedules.runNow(id, actorOf(auth), body?.confirm === true);
        return { runId: started.runId, startedAt: started.startedAt, nextRunAt: started.nextRunAt, schedule: started.view };
    }

    @Post(':id/pause')
    @ApiOperation({ summary: 'Pause a schedule (class `plain`); its cadence is kept.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_SCHEDULE_WRITES_PER_MINUTE, ttl: 60_000 } })
    async pause(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetScheduleView> {
        return this.schedules.pause(id, actorOf(auth));
    }

    @Post(':id/resume')
    @ApiOperation({ summary: 'Resume a paused schedule (class `plain`); fires missed while paused are not replayed.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_SCHEDULE_WRITES_PER_MINUTE, ttl: 60_000 } })
    async resume(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetScheduleView> {
        return this.schedules.resume(id, actorOf(auth));
    }
}

/**
 * Schedules on computers (FL-13 P2, spec FR-22, U14) — the breaker scope
 * "this computer": `POST /api/fleet/nodes/:id/schedules/pause-all` (class
 * `confirm`: the count and the runs in flight first) and its 15-minute Undo,
 * `POST /api/fleet/nodes/:id/schedules/resume-all { breakerAt }`. Never
 * deletes. Dark unless `FLEET_COMMANDS_ENABLED`.
 */
@ApiTags('fleet')
@Controller('api/fleet/nodes')
@UseGuards(FleetEnabledGuard, FleetCommandsEnabledGuard)
export class FleetNodeSchedulesController {
    constructor(
        private readonly schedules: FleetScheduleService,
        private readonly sessionSchedules: FleetSessionScheduleService,
        private readonly scopeContext: ScopeContextService,
    ) {}

    @Get(':id/schedules/agents')
    @ApiOperation({
        summary:
            "The Agents an Agent-session schedule on this computer may use: pinned to it first, every other one listed with why it cannot be picked (pinned elsewhere, not pinned, no Organization).",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async agents(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ agents: FleetScheduleAgentOption[] }> {
        return { agents: await this.sessionSchedules.listAgentsForNode(this.sessionActor(auth), id) };
    }

    @Post(':id/schedules/agent-session')
    @ApiOperation({
        summary:
            "Schedule an Agent session on this computer (FL-13 P2): a recurring Task of an Agent pinned here; each fire runs as an Agent session on this computer with the sign-in set up there. Without `confirm: true` it answers 409 `confirmation_required` carrying the unattended-credential sentence.",
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: FLEET_SCHEDULE_WRITES_PER_MINUTE, ttl: 60_000 } })
    async createAgentSession(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: CreateAgentSessionScheduleDto,
    ): Promise<FleetAgentSessionScheduleView> {
        return this.sessionSchedules.create(this.sessionActor(auth), id, {
            name: body.name,
            agentId: body.agentId,
            prompt: body.prompt,
            provider: body.provider as 'claude-code' | 'codex',
            ...(body.checkoutId !== undefined ? { checkoutId: body.checkoutId } : {}),
            cadence: body.cadence,
            ...(body.confirm !== undefined ? { confirm: body.confirm } : {}),
        });
    }

    private sessionActor(auth: AuthenticatedUser) {
        const scope = this.scopeContext.getScope();
        return {
            userId: auth.userId,
            tenantId: scope?.tenantId ?? null,
            organizationId: scope?.organizationId ?? null,
        };
    }

    @Post(':id/schedules/pause-all')
    @ApiOperation({
        summary:
            'Pause every schedule on one computer (its owner: all of them; anyone else: their own). Without `confirm: true` it answers 409 with the count and the runs in flight. Undo within 15 minutes with resume-all.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async pauseAll(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: ConfirmFleetScheduleDto,
    ): Promise<FleetSchedulePauseAllResult> {
        return this.schedules.pauseAllOnNode(id, actorOf(auth), body?.confirm === true);
    }

    @Post(':id/schedules/resume-all')
    @ApiOperation({ summary: "Undo a Pause all within 15 minutes: resume exactly the schedules it paused." })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async undoPauseAll(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UndoPauseAllSchedulesDto,
    ): Promise<{ resumed: number }> {
        return this.schedules.undoPauseAllOnNode(id, actorOf(auth), body.breakerAt);
    }
}
