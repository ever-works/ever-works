import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Optional,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    Res,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    fleetCommandError,
    FleetCommandService,
    FleetScheduleService,
    type FleetCommandActor,
} from '@ever-works/agent/fleet';
import {
    FLEET_COMMAND_RECENT,
    FLEET_COMMAND_RUNS_PER_MINUTE,
    FLEET_SCHEDULE_HISTORY,
    FLEET_SCHEDULE_WRITES_PER_MINUTE,
    type FleetCommandLastRunResponse,
    type FleetCommandListResponse,
    type FleetCommandRunView,
    type FleetCommandView,
    type FleetScheduleView,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import {
    DeleteFleetScheduleDto,
    ListFleetCommandRunsQueryDto,
    ListFleetCommandsQueryDto,
    RunFleetCommandDto,
    UpdateFleetScheduleDto,
} from './dto/fleet-commands.dto';
import { FleetCommandsEnabledGuard } from './fleet-commands-enabled.guard';
import { FleetCommandLinkAdapter } from './fleet-command-link.adapter';
import { FleetConfirmationInterceptor } from '../tools/fleet-confirmation.interceptor';

function actorOf(auth: AuthenticatedUser): FleetCommandActor {
    return { userId: auth.userId };
}

/**
 * Commands on computers (FL-12, plan §5, CONTRACTS §11.2) — the REST surface
 * over `FleetCommandService`, the one writer of `fleet_commands` and
 * `fleet_command_runs`.
 *
 * Gates, in order: `FleetEnabledGuard` (the whole fleet), then
 * `FleetCommandsEnabledGuard` (`FLEET_COMMANDS_ENABLED`, default off; 404),
 * then the global auth guard (no route here is public), then the service's
 * chain: the request's shape, every computer's existence and `commands`
 * audience (an id the person may not see is the 404 of an unknown one), the
 * kill switch and the limits, the confirmation (`confirm: true`, CONTRACTS
 * §2.2), then the machines through the node link. Every refusal is the
 * CONTRACTS §8 envelope with its status, thrown by the service and passed
 * through untouched. A Command is the person's own: another person's id reads
 * as unknown (spec §8b default).
 *
 * Output is read by polling `GET /commands/:id` while a run is live (lane-log
 * decision 1); the viewer socket of plan §5 is not built. P2 adds the full
 * output download (`GET /commands/:id/runs/:runId/output`, streamed from the
 * computer over a `command` channel — lane-log decision 14) and a computer's
 * last run (`GET /nodes/:id/commands/last`).
 *
 * Schedules on computers (FL-13, plan §5): a Command WITH a cadence is a
 * schedule, served on the same paths by `FleetScheduleService` — `POST
 * /commands` with `cadence` + `name` (201), `PATCH /commands/:id` (edit or
 * move), `DELETE /commands/:id` (soft delete, `confirm`), and `GET
 * /commands/:id` · `/commands/:id/runs` answer a schedule's view and its
 * last 30 runs. Run now, Pause and Resume ride the Schedules routes
 * (`/api/schedules/node_schedule:<id>/…`), one control path for every source.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetCommandsEnabledGuard)
// FL-19 (CONTRACTS §2.2) — one `confirmation_required` answer for every caller: the class from
// the catalogue, the hint that says what to send; token-style fields are ignored.
@UseInterceptors(FleetConfirmationInterceptor)
export class FleetCommandsController {
    constructor(
        private readonly commands: FleetCommandService,
        private readonly link: FleetCommandLinkAdapter,
        // Schedules on computers (FL-13), from the global `FleetSchedulesApiModule`.
        // Appended LAST + @Optional(): unbound, a cadence is refused as before.
        @Optional() private readonly schedules?: FleetScheduleService,
    ) {}

    @Post('commands')
    @ApiOperation({
        summary:
            "Run one command on one or more of my computers, in the machine owner's login shell with no input. Without `confirm: true` it answers 409 `confirmation_required` with one line per computer (shell, user, folder, or why it cannot run). Answers 202 with one run per computer; poll the Command for output.",
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: FLEET_COMMAND_RUNS_PER_MINUTE * 3, ttl: 60_000 } })
    async run(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: RunFleetCommandDto,
        @Res({ passthrough: true }) res: Response,
    ): Promise<FleetCommandView | FleetScheduleView> {
        if (body.cadence !== undefined && body.cadence !== null && this.schedules) {
            // A Command with a cadence is a Schedule on ONE computer (FL-13).
            const created = await this.schedules.create(actorOf(auth), {
                name: body.name ?? '',
                ...(body.nodeId !== undefined
                    ? { nodeId: body.nodeId }
                    : { nodeIds: body.nodeIds }),
                command: body.command,
                ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
                cadence: body.cadence,
                ...(body.confirm !== undefined ? { confirm: body.confirm } : {}),
            });
            res.status(HttpStatus.CREATED);
            return created;
        }
        return this.commands.run(actorOf(auth), {
            command: body.command,
            nodeIds: body.nodeIds,
            ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
            ...(body.timeoutSec !== undefined ? { timeoutSec: body.timeoutSec } : {}),
            ...(body.confirm !== undefined ? { confirm: body.confirm } : {}),
            ...(body.cadence !== undefined ? { cadence: body.cadence } : {}),
        });
    }

    @Get('commands')
    @ApiOperation({
        summary:
            'My most recent one-off Commands, newest first, each with its runs (Recent: the last 8).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListFleetCommandsQueryDto,
    ): Promise<FleetCommandListResponse> {
        return this.commands.listRecent(actorOf(auth), query.limit ?? FLEET_COMMAND_RECENT);
    }

    @Get('commands/:id')
    @ApiOperation({
        summary:
            "One of my Commands with every computer's run: status, exit code, and the first and last 64 KiB of its output.",
    })
    @HttpCode(HttpStatus.OK)
    // Polled once a second per open card set while a run is live.
    @Throttle({ long: { limit: 240, ttl: 60_000 } })
    async get(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetCommandView | FleetScheduleView> {
        if (this.schedules && (await this.schedules.isOwnSchedule(id, actorOf(auth)))) {
            return this.schedules.get(id, actorOf(auth));
        }
        return this.commands.get(id, actorOf(auth));
    }

    @Patch('commands/:id')
    @ApiOperation({
        summary:
            "Edit one of my Command schedules (FL-13): name, command, folder, cadence, or `nodeId` to move it to another computer. A move or a change of what runs needs `confirm: true` (409 `confirmation_required` otherwise). The computer's copy is re-synced.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_SCHEDULE_WRITES_PER_MINUTE, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateFleetScheduleDto,
    ): Promise<FleetScheduleView> {
        return this.requireSchedules().update(id, actorOf(auth), {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.nodeId !== undefined ? { nodeId: body.nodeId } : {}),
            ...(body.command !== undefined ? { command: body.command } : {}),
            ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
            ...(body.cadence !== undefined ? { cadence: body.cadence } : {}),
            ...(body.confirm !== undefined ? { confirm: body.confirm } : {}),
        });
    }

    @Delete('commands/:id')
    @ApiOperation({
        summary:
            'Delete one of my Command schedules (FL-13). Needs `confirm: true` (409 `confirmation_required` with its name and run count otherwise). It stops on the computer; its run history stays readable for 30 days.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_SCHEDULE_WRITES_PER_MINUTE, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: DeleteFleetScheduleDto,
    ): Promise<FleetScheduleView> {
        return this.requireSchedules().remove(id, actorOf(auth), body?.confirm === true);
    }

    @Get('commands/:id/runs')
    @ApiOperation({ summary: "One of my Commands' runs, one per computer." })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 240, ttl: 60_000 } })
    async runs(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: ListFleetCommandRunsQueryDto,
    ): Promise<FleetCommandRunView[]> {
        if (this.schedules && (await this.schedules.isOwnSchedule(id, actorOf(auth)))) {
            // A schedule's history (FL-13, FR-20): newest first, at most 30.
            return this.schedules.runs(id, actorOf(auth), query.limit ?? FLEET_SCHEDULE_HISTORY);
        }
        return this.commands.runs(id, actorOf(auth));
    }

    @Get('commands/:id/runs/:runId/output')
    @ApiOperation({
        summary:
            "Download one computer's FULL output of one of my Commands (up to 10 MiB), read from the computer, which keeps its last 30 runs. Needs the computer online (`unreachable` names when it was last seen).",
    })
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async output(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('runId', ParseUUIDPipe) runId: string,
        @Res() res: Response,
    ): Promise<void> {
        const actor = actorOf(auth);
        const { run, nodeName } = await this.commands.authorizeFullOutput(id, runId, actor);
        // The file name is built from the platform's own ids and the computer's
        // stored name, filtered to a safe alphabet — never from the request.
        const safeName = nodeName.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'computer';
        let started = false;
        const start = (bytes: number | null) => {
            if (started) return;
            started = true;
            res.status(200);
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${safeName}-${run.id.slice(0, 8)}.log"`,
            );
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Cache-Control', 'no-store');
            if (bytes !== null && bytes > 0) res.setHeader('X-Output-Bytes', String(bytes));
        };
        try {
            await this.link.readOutput(
                {
                    nodeId: run.nodeId,
                    commandId: id,
                    runId: run.id,
                    caller: { kind: 'user', userId: auth.userId },
                },
                {
                    bytes: (total) => start(total),
                    data: (chunk) => {
                        start(null);
                        res.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
                    },
                },
            );
            start(null);
            res.end();
        } catch (error) {
            // Before the first byte the refusal is the CONTRACTS §8 envelope (the
            // exception filter renders it); after it, the download just ends short.
            if (!started) throw error;
            res.end();
        }
    }

    @Get('nodes/:id/commands/last')
    @ApiOperation({
        summary:
            'The latest run of my own Commands on one computer, for its Overview ("Last command"), or `{ last: null }`.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async lastForNode(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetCommandLastRunResponse> {
        return { last: await this.commands.lastRunForNode(id, actorOf(auth)) };
    }

    private requireSchedules(): FleetScheduleService {
        if (!this.schedules) throw fleetCommandError('not_found', 'no such schedule');
        return this.schedules;
    }

    @Post('commands/:id/cancel')
    @ApiOperation({
        summary:
            'Stop a running Command on every computer it still runs on. Each machine ends the process tree; the run ends as cancelled.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async cancel(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetCommandView> {
        return this.commands.cancel(id, actorOf(auth));
    }
}
