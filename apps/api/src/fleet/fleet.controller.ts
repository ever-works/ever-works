import {
    BadRequestException,
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
    UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { CreateEnrollmentTokenResult } from '@ever-works/agent/fleet';
import { FleetJobService, FleetService } from '@ever-works/agent/fleet';
import type {
    FleetEnrollResponse,
    FleetHeartbeatResponse,
    FleetNodeView,
} from '@ever-works/contracts';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import {
    CreateFleetEnrollmentTokenDto,
    EnrollFleetNodeDto,
    FleetHeartbeatDto,
    UpdateFleetNodeDto,
} from './dto/fleet.dto';

/**
 * Fleet (Wave 12, slice 1) — thin HTTP surface over the agent-side
 * `FleetService`.
 *
 * Owner-scoped (session/API-key auth via the global guard):
 *   GET    /api/fleet/nodes                   list mine (incl. live
 *                                             own-cluster nodes)
 *   POST   /api/fleet/nodes/enrollment-token  issue one-time token
 *   PATCH  /api/fleet/nodes/:id               rename / disable / enable
 *   DELETE /api/fleet/nodes/:id               remove registration
 *
 * Public, self-authenticating (called by the node apps — throttled,
 * fail-closed: any invalid credential path is one undifferentiated
 * 401, mirroring the terminal internal endpoints' posture):
 *   POST   /api/fleet/enroll                  consume token → secret
 *   POST   /api/fleet/heartbeat               node secret → last-seen
 */
@ApiTags('fleet')
@Controller('api/fleet')
export class FleetController {
    constructor(
        private readonly service: FleetService,
        private readonly jobs: FleetJobService,
    ) {}

    @Get('nodes')
    @ApiOperation({
        summary:
            'List my fleet nodes (enrolled machines + live nodes of my own configured clusters), each with its current execution load',
    })
    @HttpCode(HttpStatus.OK)
    async list(@CurrentUser() auth: AuthenticatedUser): Promise<FleetNodeView[]> {
        const nodes = await this.service.listForUser(auth.userId);
        // Per-node load (Desktop PRD §4.1 "current load (running Tasks)")
        // is composed at the edge rather than inside `FleetService`, so
        // the registry stays independent of the job runtime. Strictly
        // best-effort: a load-lookup failure must never take down the
        // node list, which is the page's whole reason to exist.
        let load: Record<string, { activeJobCount: number }> = {};
        try {
            load = await this.jobs.loadByNodeForUser(auth.userId);
        } catch {
            load = {};
        }
        return nodes.map((node) => ({
            ...node,
            // Cluster-sourced rows are never leased onto, so they stay null.
            load: node.persisted ? (load[node.id] ?? null) : null,
        })) as FleetNodeView[];
    }

    @Post('nodes/enrollment-token')
    @ApiOperation({
        summary:
            'Issue a one-time enrollment token for a new node (single-use, 15-minute expiry; the token is returned exactly once)',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async createEnrollmentToken(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateFleetEnrollmentTokenDto,
    ): Promise<CreateEnrollmentTokenResult> {
        return this.service.createEnrollmentToken(auth.userId, body);
    }

    @Patch('nodes/:id')
    @ApiOperation({ summary: 'Rename and/or disable/enable a fleet node' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateFleetNodeDto,
    ): Promise<FleetNodeView> {
        if (typeof body.name !== 'string' && typeof body.disabled !== 'boolean') {
            throw new BadRequestException('Provide name and/or disabled');
        }
        let view: FleetNodeView | null = null;
        if (typeof body.name === 'string') {
            view = await this.service.renameForUser(auth.userId, id, body.name);
        }
        if (typeof body.disabled === 'boolean') {
            view = await this.service.setDisabledForUser(auth.userId, id, body.disabled);
        }
        return view as FleetNodeView;
    }

    @Delete('nodes/:id')
    @ApiOperation({ summary: 'Delete a fleet node registration' })
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<void> {
        await this.service.deleteForUser(auth.userId, id);
    }

    @Public()
    @Post('enroll')
    @ApiOperation({
        summary:
            'Enroll a node with a one-time token (public, token-authenticated, single-use). Returns the node id + heartbeat secret exactly once.',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async enroll(@Body() body: EnrollFleetNodeDto): Promise<FleetEnrollResponse> {
        const result = await this.service.enroll(body.token, {
            platform: body.platform,
            version: body.version,
            capabilities: body.capabilities,
        });
        if (!result) {
            // One undifferentiated message — never say WHICH check failed.
            throw new UnauthorizedException('Invalid or expired enrollment token');
        }
        return result;
    }

    @Public()
    @Post('heartbeat')
    @ApiOperation({
        summary:
            'Node heartbeat (public, node-secret-authenticated). Server-stamps last-seen and optionally refreshes the self-description.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 240, ttl: 60_000 } })
    async heartbeat(@Body() body: FleetHeartbeatDto): Promise<FleetHeartbeatResponse> {
        const result = await this.service.heartbeat(body.nodeId, body.secret, {
            platform: body.platform,
            version: body.version,
            capabilities: body.capabilities,
        });
        if (!result) {
            throw new UnauthorizedException('Invalid node credential');
        }
        return { ok: true, node: result.node };
    }
}
