import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
    Req,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { fleetMachineError, FleetMachineActionsService } from '@ever-works/agent/fleet';
import {
    parseFleetProcessPid,
    type FleetOperationRef,
    type FleetProcessesListResult,
    type FleetProcessSignalResult,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import {
    refuseMachinePrincipalAction,
    type MachinePrincipalRequest,
} from '../../auth/machine-principal';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import {
    confirmFieldsOf,
    FleetProcessSignalDto,
    ListFleetProcessesQueryDto,
} from './dto/fleet-machine.dto';
import { FleetMachineFactsEnabledGuard } from './fleet-machine-facts-enabled.guard';

/**
 * Processes on computers (FL-09 P1, plan §5, CONTRACTS §11.2) — the busiest
 * 300 processes with the GPUs above them, and Stop (SIGTERM) / Kill (SIGKILL).
 * Same gates and envelope as `FleetServicesController`; acting needs the
 * `processes` family. The computer refuses to signal its own node, its
 * session daemon and PID 1 (`invalid`), and another user's process follows
 * the root rule (`root_required` with `sudo kill -TERM <pid>`).
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetMachineFactsEnabledGuard)
export class FleetProcessesController {
    constructor(private readonly machine: FleetMachineActionsService) {}

    @Get('nodes/:id/processes')
    @ApiOperation({
        summary:
            'A computer’s busiest 300 processes by CPU (or memory) with owner, run time and a secret-scanned command line, and its GPUs with utilisation and memory where the vendor tool reports them. Needs `--manage` on the computer.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: ListFleetProcessesQueryDto,
    ): Promise<FleetProcessesListResult> {
        return this.machine.listProcesses(
            id,
            { kind: 'user', userId: auth.userId },
            {
                ...(query.sort ? { sort: query.sort } : {}),
                ...(query.find ? { find: query.find } : {}),
            },
        );
    }

    @Post('nodes/:id/processes/:pid/signal')
    @ApiOperation({
        summary:
            'Send SIGTERM (`TERM`, Stop) or SIGKILL (`KILL`, Kill) to one process. Send `confirm: true` (409 `confirmation_required` otherwise). The computer never signals its own node, its session daemon or PID 1.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async signal(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('pid') rawPid: string,
        @Body() body: FleetProcessSignalDto,
        // Appended LAST so positional callers (specs) keep their meaning.
        @Req() req?: MachinePrincipalRequest,
    ): Promise<FleetProcessSignalResult | FleetOperationRef> {
        refuseMachinePrincipalAction(
            auth,
            req,
            'signal a process on a computer',
            'an Agent signals processes through its tools, where a Kill waits for its owner.',
        );
        const pid = parseFleetProcessPid(rawPid);
        if (pid === null) {
            throw fleetMachineError('invalid', 'pid must be a positive whole number', {
                field: 'pid',
            });
        }
        return this.machine.signalProcess(
            id,
            { kind: 'user', userId: auth.userId },
            { pid, signal: body.signal, fields: confirmFieldsOf(body) },
        );
    }
}
