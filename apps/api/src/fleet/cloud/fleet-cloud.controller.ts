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
    Req,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { fleetMachineError, FleetCloudService } from '@ever-works/agent/fleet';
import type {
    FleetCloudCreateResponse,
    FleetCloudListView,
    FleetCloudOperationResponse,
    FleetCloudOptionsView,
    FleetCloudProvidersView,
    FleetCloudUsageView,
    FleetNodeView,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import { refuseMachinePrincipalAction, type MachinePrincipalRequest } from '../../auth/machine-principal';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { cloudConfirmFields, FleetCloudCreateDto, FleetCloudDestroyDto, FleetCloudPowerDto } from './dto/fleet-cloud.dto';
import { FleetCloudEnabledGuard } from './fleet-cloud-enabled.guard';

const REFUSAL_WHY = 'an Agent creates, powers and destroys cloud computers through its tools, where each act waits for its owner.';

/** A plugin id as the manifest validator allows it (lower-case words joined by `-`). */
function pluginParam(plugin: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(plugin)) {
        throw fleetMachineError('invalid', 'the provider id is not a plugin id', { field: 'plugin' });
    }
    return plugin;
}

/**
 * Cloud computers (FL-17, plan §5, CONTRACTS §11.2) — Nodes Ever Works creates
 * at a cloud provider through a `machine-provider` plugin. Dark unless
 * `FLEET_CLOUD_ENABLED`. Every refusal is the CONTRACTS §8 envelope with a
 * hint; confirmations are the §2.2 request fields (409 `confirmation_required`
 * carries the dialog's summary — the price sentence for a create).
 *
 *  - `GET    …/providers` — the machine providers enabled for the caller
 *  - `GET    …/providers/:plugin/options` — regions, sizes with list prices, software
 *  - `GET    …/cloud` — the caller's cloud computers, usage and providers
 *  - `GET    …/cloud/usage` — the usage block (estimates)
 *  - `POST   …/cloud` — create (`acknowledgedPriceCents`, `confirm: true`); 202
 *  - `GET    …/cloud/:id` · `…/cloud/:id/usage`
 *  - `POST   …/cloud/:id/power` — `on` · `off` (`confirm: true`); 202
 *  - `POST   …/cloud/:id/destroy` (and `DELETE …/cloud/:id`) — `confirmName`; 202
 *  - `POST   …/cloud/:id/retry-enrollment`
 *
 * "Remove from Fleet" (`DELETE /api/fleet/nodes/:id`) is refused for a cloud
 * computer whose machine may still bill (CONTRACTS R-36) — that guard lives in
 * `FleetService`, so it holds on every route.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetCloudEnabledGuard)
export class FleetCloudController {
    constructor(private readonly cloud: FleetCloudService) {}

    @Get('providers')
    @ApiOperation({
        summary:
            'The machine providers (cloud computer plugins) enabled for the caller, whether each has a token saved, its account label when known and whether sign-in is offered.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async providers(@CurrentUser() auth: AuthenticatedUser): Promise<FleetCloudProvidersView> {
        return this.cloud.listProviders({ kind: 'user', userId: auth.userId });
    }

    @Get('providers/:plugin/options')
    @ApiOperation({
        summary:
            'Regions, sizes with the provider’s current monthly and hourly list prices, software presets and the connected account for one machine provider (cached 10 minutes).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async options(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('plugin') plugin: string,
    ): Promise<FleetCloudOptionsView> {
        return this.cloud.options({ kind: 'user', userId: auth.userId }, pluginParam(plugin));
    }

    @Get('cloud')
    @ApiOperation({
        summary:
            'The caller’s cloud computers (with the Cloud block: provider, region, size, power, cost so far), the usage totals and the connected providers.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async list(@CurrentUser() auth: AuthenticatedUser): Promise<FleetCloudListView & FleetCloudProvidersView> {
        return this.cloud.list({ kind: 'user', userId: auth.userId });
    }

    // Declared before `cloud/:id` so `usage` is never read as an id.
    @Get('cloud/usage')
    @ApiOperation({
        summary:
            'What the caller’s cloud computers cost: per hour now, this month so far and projected — estimates from the providers’ list prices; never counted against model-spend budgets.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async usage(@CurrentUser() auth: AuthenticatedUser): Promise<FleetCloudUsageView> {
        return this.cloud.usage({ kind: 'user', userId: auth.userId });
    }

    @Post('cloud')
    @ApiOperation({
        summary:
            'Create a cloud computer at a provider on the owner’s account. Writes the Fleet registration first, then asks the provider; the machine enrols itself with a one-time token. Needs `acknowledgedPriceCents` (refused when the price changed) and `confirm: true` (409 carries the price sentence). Answers 202.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: FleetCloudCreateDto,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<FleetCloudCreateResponse> {
        refuseMachinePrincipalAction(auth, req, 'create a cloud computer', REFUSAL_WHY);
        // `vpnAuthKey` is deliberately not forwarded in this phase (the overlay-VPN
        // preset arrives in P3) and is never echoed: the response type has no field for it.
        return this.cloud.create(
            { kind: 'user', userId: auth.userId },
            {
                providerPluginId: body.providerPluginId,
                name: body.name,
                regionId: body.regionId,
                sizeId: body.sizeId,
                software: body.software,
                acknowledgedPriceCents: body.acknowledgedPriceCents,
                organizationId: body.organizationId ?? null,
                fields: cloudConfirmFields(body),
            },
        );
    }

    @Get('cloud/:id')
    @ApiOperation({ summary: 'One cloud computer with its Cloud block.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async get(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetNodeView> {
        return this.cloud.get({ kind: 'user', userId: auth.userId }, id);
    }

    @Get('cloud/:id/usage')
    @ApiOperation({ summary: 'What one cloud computer has cost (estimates from list prices).' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async usageOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetCloudUsageView> {
        return this.cloud.usage({ kind: 'user', userId: auth.userId }, id);
    }

    @Post('cloud/:id/power')
    @ApiOperation({
        summary:
            'Power a cloud computer on or off (`confirm: true`; the 409 says whether the provider bills it while off). Power on is refused while the Fleet is stopped; power off is not. Answers 202.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async power(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetCloudPowerDto,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<FleetCloudOperationResponse> {
        refuseMachinePrincipalAction(auth, req, 'power a cloud computer', REFUSAL_WHY);
        return this.cloud.power({ kind: 'user', userId: auth.userId }, id, body.action, cloudConfirmFields(body));
    }

    @Post('cloud/:id/destroy')
    @ApiOperation({
        summary:
            'Destroy a cloud computer: the machine and its disk at the provider, then its Fleet registration (job history is kept). Send `confirmName` = its name (the 409 states the cost so far). Refused `busy` while a Run or a session is live on it. Answers 202 with the cost so far.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async destroy(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetCloudDestroyDto,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<FleetCloudOperationResponse> {
        refuseMachinePrincipalAction(auth, req, 'destroy a cloud computer', REFUSAL_WHY);
        return this.cloud.destroy({ kind: 'user', userId: auth.userId }, id, cloudConfirmFields(body));
    }

    @Delete('cloud/:id')
    @ApiOperation({ summary: 'The same as `POST /api/fleet/cloud/:id/destroy` (FL-19 catalogue alias).' })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async destroyAlias(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetCloudDestroyDto,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<FleetCloudOperationResponse> {
        return this.destroy(auth, id, body ?? {}, req);
    }

    @Post('cloud/:id/retry-enrollment')
    @ApiOperation({
        summary:
            'Retry the enrolment of a cloud computer that never came online. Refused `unsupported_on_node` when its provider cannot replace the first-boot script (destroy and create again).',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    async retryEnrollment(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Req() req?: MachinePrincipalRequest,
    ): Promise<FleetCloudOperationResponse> {
        refuseMachinePrincipalAction(auth, req, 'retry a cloud computer’s enrolment', REFUSAL_WHY);
        return this.cloud.retryEnrollment({ kind: 'user', userId: auth.userId }, id);
    }
}
