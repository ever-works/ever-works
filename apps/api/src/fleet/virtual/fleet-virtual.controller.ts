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
import { fleetMachineError, FleetVirtualService, type FleetVirtualChildrenView } from '@ever-works/agent/fleet';
import type {
    FleetVirtualCreateResponse,
    FleetVirtualOperationResponse,
    FleetVirtualOptionsView,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import { refuseMachinePrincipalAction, type MachinePrincipalRequest } from '../../auth/machine-principal';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import {
    FleetVirtualCreateDto,
    FleetVirtualDestroyDto,
    FleetVirtualOptionsQueryDto,
    FleetVirtualPowerDto,
    virtualConfirmFields,
} from './dto/fleet-virtual.dto';
import { FleetVirtualEnabledGuard } from './fleet-virtual-enabled.guard';

const REFUSAL_WHY = 'an Agent creates and changes virtual computers through its tools, where each act waits for its owner.';

/** `:id` is a host's uuid, or `auto` on create / options ("Choose for me"). */
function hostParam(id: string): string {
    if (id === 'auto') return id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw fleetMachineError('invalid', 'the computer id must be a uuid or auto', { field: 'id' });
    }
    return id;
}

/**
 * Virtual computers (FL-16, plan §5, CONTRACTS §11.2) — Containers (and, from
 * phase 2, Windows VMs) created ON a computer of the Fleet. Dark unless
 * `FLEET_VIRTUAL_ENABLED`. Every refusal is the CONTRACTS §8 envelope with a
 * hint; confirmations are the §2.2 request fields (409 `confirmation_required`
 * carries the dialog's summary).
 *
 *  - `GET  …/nodes/:id/virtual` — the host's children (any `view` audience)
 *  - `GET  …/nodes/:id/virtual/options` — the host picker, judged for `?system=`
 *  - `POST …/nodes/:id/virtual` — create (`:id` may be `auto`); `confirm: true`
 *  - `POST …/nodes/:id/virtual/:childId/power` — `start` · `stop` (`confirm`)
 *  - `POST …/nodes/:id/virtual/:childId/destroy` — `confirmName` = the child's name
 *  - `POST …/nodes/:id/virtual/:childId/retry-enrollment` — re-issue the guest's token
 *
 * A create / power / destroy answers 202 with the durable job that does it
 * (`operationId` = the job id); the child's row carries the phase.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetVirtualEnabledGuard)
export class FleetVirtualController {
    constructor(private readonly virtual: FleetVirtualService) {}

    @Get('virtual')
    @ApiOperation({
        summary: 'Every virtual computer the caller may see, grouped by the computer that hosts it.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async all(@CurrentUser() auth: AuthenticatedUser): Promise<{ hosts: FleetVirtualChildrenView[] }> {
        return { hosts: await this.virtual.listAllChildren({ kind: 'user', userId: auth.userId }) };
    }

    @Get('nodes/:id/virtual')
    @ApiOperation({
        summary:
            'The virtual computers a computer hosts (Containers, Windows VMs) with their system, size, create phase and state, and the host’s memory net of what they reserve.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async children(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetVirtualChildrenView> {
        return this.virtual.listChildren({ kind: 'user', userId: auth.userId }, id);
    }

    @Get('nodes/:id/virtual/options')
    @ApiOperation({
        summary:
            'The host picker for a new virtual computer: every computer the caller may use with free memory, free disk, KVM and why it cannot host the chosen system; the systems, sizes and limits; and "Choose for me".',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async options(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Query() query: FleetVirtualOptionsQueryDto,
    ): Promise<FleetVirtualOptionsView> {
        hostParam(id);
        return this.virtual.options({ kind: 'user', userId: auth.userId }, query.system);
    }

    @Post('nodes/:id/virtual')
    @ApiOperation({
        summary:
            'Create a virtual computer on a computer (`:id`, or `auto` to pick the host with the most free memory). Writes its Fleet registration first, then a durable job on the host; the new computer enrols itself. Send `confirm: true` (409 `confirmation_required` carries the host, CPUs, memory and disk). Answers 202.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() body: FleetVirtualCreateDto,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<FleetVirtualCreateResponse> {
        refuseMachinePrincipalAction(auth, req, 'create a virtual computer', REFUSAL_WHY);
        return this.virtual.create({ kind: 'user', userId: auth.userId }, hostParam(id), {
            name: body.name,
            systemId: body.systemId,
            cpus: body.cpus,
            memoryGiB: body.memoryGiB,
            diskGiB: body.diskGiB ?? null,
            fields: virtualConfirmFields(body),
        });
    }

    @Post('nodes/:id/virtual/:childId/power')
    @ApiOperation({
        summary:
            'Start or stop a virtual computer. Stop needs `confirm: true`: a Container stops within 10 seconds, Windows is asked to shut down and gets 2 minutes. Answers 202.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async power(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('childId', ParseUUIDPipe) childId: string,
        @Body() body: FleetVirtualPowerDto,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<FleetVirtualOperationResponse> {
        refuseMachinePrincipalAction(auth, req, 'start or stop a virtual computer', REFUSAL_WHY);
        return this.virtual.power({ kind: 'user', userId: auth.userId }, id, childId, body.action, virtualConfirmFields(body));
    }

    @Post('nodes/:id/virtual/:childId/destroy')
    @ApiOperation({
        summary:
            'Destroy a virtual computer: its machine and disk under the host’s node data folder, then its Fleet registration (job history is kept). Send `confirmName` = its name. Refused `busy` while a Run or a session is live on it. Answers 202.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async destroy(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('childId', ParseUUIDPipe) childId: string,
        @Body() body: FleetVirtualDestroyDto,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<FleetVirtualOperationResponse> {
        refuseMachinePrincipalAction(auth, req, 'destroy a virtual computer', REFUSAL_WHY);
        return this.virtual.destroy({ kind: 'user', userId: auth.userId }, id, childId, virtualConfirmFields(body));
    }

    @Post('nodes/:id/virtual/:childId/retry-enrollment')
    @ApiOperation({
        summary:
            'Hand a virtual computer that was built but never enrolled a fresh one-time token (nothing is rebuilt). Answers 202.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    async retryEnrollment(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('childId', ParseUUIDPipe) childId: string,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<FleetVirtualOperationResponse> {
        refuseMachinePrincipalAction(auth, req, 'retry a virtual computer’s enrolment', REFUSAL_WHY);
        return this.virtual.retryEnrollment({ kind: 'user', userId: auth.userId }, id, childId);
    }
}
