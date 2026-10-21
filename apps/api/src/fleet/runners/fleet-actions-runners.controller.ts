import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FleetActionsRunnersService } from '@ever-works/agent/fleet';
import type {
    FleetActionsRunnerInstallResponse,
    FleetActionsRunnerOperationResponse,
    FleetActionsRunnerOptionsView,
    FleetActionsRunnersListView,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import { refuseMachinePrincipalAction, type MachinePrincipalRequest } from '../../auth/machine-principal';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetActionsRunnerControlDto, FleetActionsRunnerInstallDto, runnerConfirmFields } from './dto/fleet-actions-runners.dto';
import { FleetActionsRunnersEnabledGuard } from './fleet-actions-runners-enabled.guard';

const REFUSAL_WHY = 'an Agent installs and controls Actions runners through its tools, where each act waits for its owner.';

/**
 * Actions runners on computers (FL-18, plan §5, CONTRACTS §11.2) — GitHub
 * Actions self-hosted runners on computers of the Fleet. Dark unless
 * `FLEET_ACTIONS_RUNNERS_ENABLED`. Every refusal is the CONTRACTS §8 envelope
 * with a hint; confirmations are the §2.2 request fields (409
 * `confirmation_required` carries the dialog's summary).
 *
 *  - `GET  …/nodes/:id/runners` — the computer's runners (any `view` audience)
 *  - `GET  …/nodes/:id/runners/options` — the Install dialog
 *  - `POST …/nodes/:id/runners` — install (`confirm: true`); 202
 *  - `POST …/nodes/:id/runners/:runnerId/:action` — `start` · `stop` · `restart` (`confirm`) ·
 *    `remove` (`confirmName`); 202
 *  - `GET  …/runners` — every runner the caller may see, per computer
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetActionsRunnersEnabledGuard)
export class FleetActionsRunnersController {
    constructor(private readonly runners: FleetActionsRunnersService) {}

    @Get('runners')
    @ApiOperation({ summary: 'Every Actions runner the caller may see, grouped by the computer it runs on.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async all(@CurrentUser() auth: AuthenticatedUser): Promise<{ computers: FleetActionsRunnersListView[] }> {
        return { computers: await this.runners.listAll({ kind: 'user', userId: auth.userId }) };
    }

    @Get('nodes/:id/runners')
    @ApiOperation({
        summary:
            'The GitHub Actions self-hosted runners on a computer: repository or organisation, labels, state (installing · idle · working · offline · stopped · failed · unknown), its source and the last check.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetActionsRunnersListView> {
        return this.runners.list({ kind: 'user', userId: auth.userId }, id);
    }

    @Get('nodes/:id/runners/options')
    @ApiOperation({
        summary:
            'The Install runners dialog: whether this computer can host runners (and why not), the repositories and organisations your GitHub App covers, the modes, the labels GitHub adds and the default names.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async options(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetActionsRunnerOptionsView> {
        return this.runners.options({ kind: 'user', userId: auth.userId }, id);
    }

    @Post('nodes/:id/runners')
    @ApiOperation({
        summary:
            'Install 1–16 Actions runners on a computer for a repository or organisation your GitHub App covers. Writes the runner rows first, then one durable job on the computer that downloads GitHub’s runner build, verifies its checksum, registers and starts it as a service. Send `confirm: true` (409 `confirmation_required` carries the target, count, mode and computer). Answers 202.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async install(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetActionsRunnerInstallDto,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<FleetActionsRunnerInstallResponse> {
        refuseMachinePrincipalAction(auth, req, 'install Actions runners', REFUSAL_WHY);
        return this.runners.install({ kind: 'user', userId: auth.userId }, id, {
            target: { scope: body.target.scope, target: body.target.target },
            count: body.count,
            ...(body.names ? { names: body.names } : {}),
            ...(body.labels ? { labels: body.labels } : {}),
            ...(body.mode ? { mode: body.mode } : {}),
            fields: runnerConfirmFields(body),
        });
    }

    // Declared before `:action` so the static segment wins; the same act as `…/:action` with
    // `remove`, named on its own for the tool catalogue and MCP (`fleet_runners_remove`).
    @Post('nodes/:id/runners/:runnerId/remove')
    @ApiOperation({
        summary:
            'Remove one Actions runner: deregister it at GitHub, uninstall its service and delete its folder on the computer. Send `confirmName` = the runner’s name; refused `busy` while it runs a job. Answers 202.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('runnerId', ParseUUIDPipe) runnerId: string,
        @Body() body: FleetActionsRunnerControlDto,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<FleetActionsRunnerOperationResponse> {
        refuseMachinePrincipalAction(auth, req, 'remove an Actions runner', REFUSAL_WHY);
        return this.runners.control({ kind: 'user', userId: auth.userId }, id, runnerId, 'remove', runnerConfirmFields(body));
    }

    @Post('nodes/:id/runners/:runnerId/:action')
    @ApiOperation({
        summary:
            'Start, stop, restart or remove one Actions runner. Stop and restart need `confirm: true`; remove needs `confirmName` = the runner’s name and is refused `busy` while it runs a job. Answers 202.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async control(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('runnerId', ParseUUIDPipe) runnerId: string,
        @Param('action') action: string,
        @Body() body: FleetActionsRunnerControlDto,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<FleetActionsRunnerOperationResponse> {
        refuseMachinePrincipalAction(auth, req, 'control an Actions runner', REFUSAL_WHY);
        return this.runners.control({ kind: 'user', userId: auth.userId }, id, runnerId, action, runnerConfirmFields(body));
    }
}
