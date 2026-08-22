import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Put,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FleetAgentNodeAffinityService } from '@ever-works/agent/fleet';
import type { FleetAgentNodeAffinity } from '@ever-works/agent/fleet';
import type { FleetAgentNodeAffinityView } from '@ever-works/contracts';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope/scope-context.service';
import { SetFleetAgentAffinityDto } from './dto/fleet-agent-affinity.dto';
import { FleetEnabledGuard } from './guards/fleet-enabled.guard';

@ApiTags('fleet')
@Controller('api/fleet/agents')
@UseGuards(FleetEnabledGuard)
export class FleetAgentAffinityController {
    constructor(
        private readonly affinities: FleetAgentNodeAffinityService,
        private readonly scope: ScopeContextService,
    ) {}

    @Get(':agentId/node-affinity')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Read this Organization Agent's selected Fleet node." })
    async get(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('agentId', ParseUUIDPipe) agentId: string,
    ): Promise<FleetAgentNodeAffinityView | null> {
        const affinity = await this.affinities.getAffinity({
            userId: auth.userId,
            organizationId: this.scope.getOrganizationId(),
            agentId,
        });
        return affinity ? toView(affinity) : null;
    }

    @Put(':agentId/node-affinity')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Select the user-owned Fleet node for this Organization Agent.' })
    async set(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('agentId', ParseUUIDPipe) agentId: string,
        @Body() body: SetFleetAgentAffinityDto,
    ): Promise<FleetAgentNodeAffinityView> {
        return toView(
            await this.affinities.setAffinity({
                userId: auth.userId,
                organizationId: this.scope.getOrganizationId(),
                agentId,
                nodeId: body.nodeId,
            }),
        );
    }
}

function toView(affinity: FleetAgentNodeAffinity): FleetAgentNodeAffinityView {
    return {
        agentId: affinity.agentId,
        nodeId: affinity.nodeId,
        organizationId: affinity.organizationId,
        createdAt: affinity.createdAt?.toISOString() ?? null,
        updatedAt: affinity.updatedAt?.toISOString() ?? null,
    };
}
