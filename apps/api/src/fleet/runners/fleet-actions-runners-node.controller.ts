import {
    Body,
    Controller,
    Header,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FleetActionsRunnersService } from '@ever-works/agent/fleet';
import type { FleetActionsRunnerProgressReport, FleetActionsRunnerTokenResponse } from '@ever-works/contracts';
import { Public } from '../../auth/decorators/public.decorator';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FLEET_NODE_UNAUTHORIZED_MESSAGE, FleetNodeAuthGuard } from '../guards/fleet-node-auth.guard';
import { FleetActionsRunnerProgressDto, FleetActionsRunnerTokenDto } from './dto/fleet-actions-runners.dto';
import { FleetActionsRunnersEnabledGuard } from './fleet-actions-runners-enabled.guard';

/**
 * Actions runners on computers (FL-18, plan §6.4, spec FR-7, FR-11) — the two
 * calls a NODE makes while it installs or controls a runner, with its own node
 * credential:
 *
 *   POST /api/internal/fleet/runners/:runnerId/token      ready to register (or remove): mint the one-time token
 *   POST /api/internal/fleet/runners/:runnerId/progress   a phase, a state, a failure line, the version
 *
 * Both take the `push-credential` posture exactly (`FleetJobsController`,
 * FL-16's virtual node controller): `@Public()` + `FleetNodeAuthGuard` at the
 * edge, then the service proves the claim — the credential, the recorded holder
 * of a live `runner-*` job whose payload names THIS runner on THIS node — and
 * every refusal collapses to one undifferentiated 401. The differentiated
 * answers are 409 `stale-lease` (only the recorded holder echoing an old lease
 * generation) and the CONTRACTS §8 envelope for `kill_switch`, a name GitHub
 * already lists for another machine (`invalid`) and GitHub's own refusals.
 *
 * The token is returned exactly once (`Cache-Control: no-store`) and never
 * logged, audited or stored.
 */
@ApiTags('fleet')
@Controller('api/internal/fleet/runners')
@UseGuards(FleetEnabledGuard, FleetActionsRunnersEnabledGuard, FleetNodeAuthGuard)
export class FleetActionsRunnersNodeController {
    constructor(private readonly runners: FleetActionsRunnersService) {}

    @Public()
    @Post(':runnerId/token')
    @ApiOperation({
        summary:
            'Mint the one-time registration (or remove) token of an Actions runner this node is installing (public, node-secret-authenticated, for a runner-* job it holds). Returned once; the node gives it to the runner through its environment input.',
    })
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 40, ttl: 60_000 } })
    async token(
        @Param('runnerId', ParseUUIDPipe) runnerId: string,
        @Body() body: FleetActionsRunnerTokenDto,
    ): Promise<FleetActionsRunnerTokenResponse> {
        const minted = await this.runners.mintRunnerToken(runnerId, {
            nodeId: body.nodeId,
            secret: body.secret,
            jobId: body.jobId,
            leaseGeneration: body.leaseGeneration,
            kind: body.kind,
        });
        if (!minted) throw new UnauthorizedException(FLEET_NODE_UNAUTHORIZED_MESSAGE);
        return minted;
    }

    @Public()
    @Post(':runnerId/progress')
    @ApiOperation({
        summary:
            'Report an Actions runner’s install phase, its service state, the first failure line, its version or its GitHub id (public, node-secret-authenticated, for a runner-* job this node holds).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 240, ttl: 60_000 } })
    async progress(
        @Param('runnerId', ParseUUIDPipe) runnerId: string,
        @Body() body: FleetActionsRunnerProgressDto,
    ): Promise<{ ok: true }> {
        const report: Partial<FleetActionsRunnerProgressReport> = {
            nodeId: body.nodeId,
            secret: body.secret,
            jobId: body.jobId,
            leaseGeneration: body.leaseGeneration,
        };
        if (body.phase !== undefined) report.phase = body.phase;
        if (body.state !== undefined) report.state = body.state;
        if (body.error !== undefined) report.error = body.error;
        if (body.runnerVersion !== undefined) report.runnerVersion = body.runnerVersion;
        if (body.serviceUnit !== undefined) report.serviceUnit = body.serviceUnit;
        if (body.githubRunnerId !== undefined) report.githubRunnerId = body.githubRunnerId;
        const accepted = await this.runners.reportProgress(runnerId, report);
        if (!accepted) throw new UnauthorizedException(FLEET_NODE_UNAUTHORIZED_MESSAGE);
        return { ok: true };
    }
}
