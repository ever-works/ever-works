import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
    Req,
    Res,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { fleetMachineError, FleetMachineActionsService } from '@ever-works/agent/fleet';
import {
    isFleetComposeAction,
    isFleetComposeProject,
    isFleetComposeService,
    type FleetComposeDescription,
    type FleetComposeListResult,
    type FleetContainerShellsResult,
    isFleetContainerAction,
    isFleetContainerRef,
    isFleetDockerId,
    isFleetImageAction,
    isFleetImageRef,
    type FleetContainersListResult,
    type FleetImagesListResult,
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
    FleetActionConfirmDto,
    FleetComposeActionDto,
    FleetComposeQueryDto,
    FleetContainerExecDto,
    FleetPullImageDto,
    FleetPruneImagesQueryDto,
    FleetRunContainerDto,
} from './dto/fleet-machine.dto';
import { FleetMachineFactsEnabledGuard } from './fleet-machine-facts-enabled.guard';
import { FleetConfirmationInterceptor } from '../tools/fleet-confirmation.interceptor';

/** The part of Express's response this controller sets: 202 for an act that became an operation. */
interface StatusResponse {
    status(code: number): unknown;
}

function accepted<T extends object>(result: T, res: StatusResponse | undefined): T {
    if (res && 'operationId' in result) res.status(HttpStatus.ACCEPTED);
    return result;
}

const REFUSAL_WHY = 'an Agent acts on Docker through its tools, where a risky act waits for its owner.';

/**
 * Docker on computers (FL-09 P2, plan §5, CONTRACTS §11.2) — containers and
 * images through the computer's Docker CLI (never its socket). Same gates and
 * envelope as `FleetServicesController`; acting needs the `docker` family.
 *
 *  - `GET  …/docker/containers` · `POST …/docker/containers` (run, an operation)
 *  - `POST …/docker/containers/:cid/:action` (start · stop · restart · remove —
 *    remove needs `confirmName` = the container's name)
 *  - `GET  …/docker/images` · `POST …/docker/images` (pull, an operation)
 *  - `POST …/docker/images/:iid/remove` · `DELETE …/docker/images?unused=true` (prune)
 *
 * An act that became an operation answers 202 `{ operationId }`; follow it at
 * `GET /api/fleet/operations/:id`.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetMachineFactsEnabledGuard)
// FL-19 (CONTRACTS §2.2) — one `confirmation_required` answer for every caller: the class from
// the catalogue, the hint that says what to send; token-style fields are ignored.
@UseInterceptors(FleetConfirmationInterceptor)
export class FleetDockerController {
    constructor(private readonly machine: FleetMachineActionsService) {}

    @Get('nodes/:id/docker/containers')
    @ApiOperation({
        summary:
            'Every container on a computer with image, state, ports, Compose project, CPU and memory, and whether Docker is installed and running there. Needs `--manage`.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async containers(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetContainersListResult> {
        return this.machine.listContainers(id, { kind: 'user', userId: auth.userId });
    }

    @Post('nodes/:id/docker/containers')
    @ApiOperation({
        summary:
            'Run a container from an image with a name, ports, environment variables, volumes under the computer’s shared folders, a restart policy and a command. Send `confirm: true` (409 `confirmation_required` carries the exact command line, values masked). Privileged mode, host namespaces and socket mounts are refused. Answers 202 `{ operationId }` while it runs.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async run(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetRunContainerDto,
        @Res({ passthrough: true }) res?: StatusResponse,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<object> {
        refuseMachinePrincipalAction(auth, req, 'run a container on a computer', REFUSAL_WHY);
        return accepted(
            await this.machine.runContainer(
                id,
                { kind: 'user', userId: auth.userId },
                { request: body.request, fields: confirmFieldsOf(body) },
            ),
            res,
        );
    }

    @Post('nodes/:id/docker/containers/:cid/:action')
    @ApiOperation({
        summary:
            'Start, stop, restart or remove one container (by id or name). Send `confirm: true`; remove needs `confirmName` equal to the container’s name, never removes a running container and keeps its volumes.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async containerAction(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('cid') container: string,
        @Param('action') action: string,
        @Body() body: FleetContainerExecDto,
        @Res({ passthrough: true }) res?: StatusResponse,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<object> {
        refuseMachinePrincipalAction(auth, req, 'change a container on a computer', REFUSAL_WHY);
        if (!isFleetContainerRef(container)) {
            throw fleetMachineError('invalid', 'that is not a container id or name', { field: 'cid' });
        }
        // Shell inside (FL-09 P3, FR-35): an owner Session whose process is a shell in the container.
        if (action === 'exec') {
            const shell = body.shell;
            return this.machine.execInContainer(
                id,
                { kind: 'user', userId: auth.userId },
                { container, shell: shell === 'bash' ? 'bash' : 'sh' },
            );
        }
        if (!isFleetContainerAction(action)) {
            throw fleetMachineError('invalid', 'action must be start, stop, restart or remove', {
                field: 'action',
            });
        }
        return accepted(
            await this.machine.containerAction(
                id,
                { kind: 'user', userId: auth.userId },
                { container, action, fields: confirmFieldsOf(body) },
            ),
            res,
        );
    }

    @Get('nodes/:id/docker/containers/:cid/shells')
    @ApiOperation({
        summary: 'Which shells (`bash`, `sh`) a running container has, for “Shell inside”. Needs `--manage`.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async shells(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('cid') container: string,
    ): Promise<FleetContainerShellsResult> {
        if (!isFleetContainerRef(container)) {
            throw fleetMachineError('invalid', 'that is not a container id or name', { field: 'cid' });
        }
        return this.machine.containerShells(id, { kind: 'user', userId: auth.userId }, container);
    }

    @Get('nodes/:id/docker/compose')
    @ApiOperation({
        summary:
            'Every Compose project on a computer (name, status, service count, config files; files missing → only Down), or with `?project=` that project’s services with image, state, health, ports, networks, volumes and `depends_on`. Needs `--manage`.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async compose(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: FleetComposeQueryDto,
    ): Promise<FleetComposeListResult | FleetComposeDescription> {
        const caller = { kind: 'user' as const, userId: auth.userId };
        if (query.project !== undefined) {
            if (!isFleetComposeProject(query.project)) {
                throw fleetMachineError('invalid', 'that is not a Compose project name', { field: 'project' });
            }
            return this.machine.describeComposeProject(id, caller, query.project);
        }
        return this.machine.listComposeProjects(id, caller);
    }

    @Post('nodes/:id/docker/compose/:project/:action')
    @ApiOperation({
        summary:
            'Bring a Compose project (or one service) up, down, restart it or pull its images — an operation (202 `{ operationId }`). Send `confirm: true`. Down never removes named volumes.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async composeAction(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('project') project: string,
        @Param('action') action: string,
        @Body() body: FleetComposeActionDto,
        @Res({ passthrough: true }) res?: StatusResponse,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<object> {
        refuseMachinePrincipalAction(auth, req, 'change a Compose project on a computer', REFUSAL_WHY);
        if (!isFleetComposeProject(project)) {
            throw fleetMachineError('invalid', 'that is not a Compose project name', { field: 'project' });
        }
        if (!isFleetComposeAction(action)) {
            throw fleetMachineError('invalid', 'action must be up, down, restart or pull', { field: 'action' });
        }
        if (body.service !== undefined && !isFleetComposeService(body.service)) {
            throw fleetMachineError('invalid', 'that is not a Compose service name', { field: 'service' });
        }
        return accepted(
            await this.machine.composeAction(
                id,
                { kind: 'user', userId: auth.userId },
                {
                    project,
                    action,
                    ...(body.service ? { service: body.service } : {}),
                    fields: confirmFieldsOf(body),
                },
            ),
            res,
        );
    }

    @Get('nodes/:id/docker/images')
    @ApiOperation({
        summary:
            'Every image on a computer with tags, size, age and how many containers use it, and what “Remove unused” would free. Needs `--manage`.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async images(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetImagesListResult> {
        return this.machine.listImages(id, { kind: 'user', userId: auth.userId });
    }

    @Post('nodes/:id/docker/images')
    @ApiOperation({
        summary: 'Pull an image (`ref`). Send `confirm: true`. Answers 202 `{ operationId }` while it pulls.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async pull(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetPullImageDto,
        @Res({ passthrough: true }) res?: StatusResponse,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<object> {
        refuseMachinePrincipalAction(auth, req, 'pull an image on a computer', REFUSAL_WHY);
        if (!isFleetImageRef(body.ref)) {
            throw fleetMachineError('invalid', 'that is not an image reference', { field: 'ref' });
        }
        return accepted(
            await this.machine.pullImage(
                id,
                { kind: 'user', userId: auth.userId },
                { ref: body.ref, fields: confirmFieldsOf(body) },
            ),
            res,
        );
    }

    @Post('nodes/:id/docker/images/:iid/:action')
    @ApiOperation({
        summary:
            'Remove one image by id (`:action` = `remove`). Send `confirm: true`. An image a container uses answers 409 `busy` naming the container.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async imageAction(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('iid') image: string,
        @Param('action') action: string,
        @Body() body: FleetActionConfirmDto,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<object> {
        refuseMachinePrincipalAction(auth, req, 'remove an image on a computer', REFUSAL_WHY);
        if (!isFleetDockerId(image)) {
            throw fleetMachineError('invalid', 'that is not an image id', { field: 'iid' });
        }
        if (!isFleetImageAction(action)) {
            throw fleetMachineError('invalid', 'action must be remove', { field: 'action' });
        }
        return this.machine.removeImage(
            id,
            { kind: 'user', userId: auth.userId },
            { id: image, fields: confirmFieldsOf(body) },
        );
    }

    @Delete('nodes/:id/docker/images')
    @ApiOperation({
        summary:
            'Remove every unused image (`?unused=true`). Send `confirm: true`. Answers at once with `reclaimedBytes: 0` (and writes no audit row) when every image is in use; otherwise 202 `{ operationId }` while it runs.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async prune(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: FleetPruneImagesQueryDto,
        @Body() body: FleetActionConfirmDto,
        @Res({ passthrough: true }) res?: StatusResponse,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<object> {
        refuseMachinePrincipalAction(auth, req, 'remove images on a computer', REFUSAL_WHY);
        if (query.unused !== 'true') {
            throw fleetMachineError('invalid', 'only unused images can be removed in bulk: unused=true', {
                field: 'unused',
            });
        }
        return accepted(
            await this.machine.pruneImages(
                id,
                { kind: 'user', userId: auth.userId },
                { fields: confirmFieldsOf(body) },
            ),
            res,
        );
    }
}
