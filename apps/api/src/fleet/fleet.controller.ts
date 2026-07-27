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
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type {
    CreateEnrollmentTokenResult,
    FleetEnrollmentTokenView,
} from '@ever-works/agent/fleet';
import { FleetJobService, FleetService } from '@ever-works/agent/fleet';
import type {
    FleetEnrollResponse,
    FleetHeartbeatResponse,
    FleetNodeView,
} from '@ever-works/contracts';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { FleetNodeDetailView, FleetNodeDrainResult } from './fleet-admin.types';
import {
    CreateFleetEnrollmentTokenDto,
    DrainFleetNodeDto,
    EnrollFleetNodeDto,
    FleetHeartbeatDto,
    UpdateFleetNodeDto,
} from './dto/fleet.dto';
import { FleetEnabledGuard } from './guards/fleet-enabled.guard';

/** How much of a node's job history the detail drawer reads. */
const NODE_HISTORY_LIMIT = 25;

/**
 * Fleet (Wave 12, slice 1) — thin HTTP surface over the agent-side
 * `FleetService`.
 *
 * Owner-scoped (session/API-key auth via the global guard):
 *   GET    /api/fleet/nodes                   list mine (incl. live
 *                                             own-cluster nodes)
 *   GET    /api/fleet/nodes/:id               node detail + job/failure
 *                                             history
 *   POST   /api/fleet/nodes/enrollment-token  issue one-time token
 *   PATCH  /api/fleet/nodes/:id               rename / disable / enable /
 *                                             edit capability tags
 *   POST   /api/fleet/nodes/:id/rotate        re-key: new one-time token,
 *                                             old secret dies immediately
 *   POST   /api/fleet/nodes/:id/drain         drain: disable AND requeue
 *                                             the node's in-flight claims
 *   DELETE /api/fleet/nodes/:id               remove registration
 *   GET    /api/fleet/enrollment-tokens       outstanding (unused) tokens
 *   DELETE /api/fleet/enrollment-tokens/:id   revoke one BEFORE it is used
 *
 * Public, self-authenticating (called by the node apps — throttled,
 * fail-closed: any invalid credential path is one undifferentiated
 * 401, mirroring the terminal internal endpoints' posture):
 *   POST   /api/fleet/enroll                  consume token → secret
 *   POST   /api/fleet/heartbeat               node secret → last-seen
 *
 * **Scoping.** EVERY owner-scoped route resolves its target through
 * `FleetService`'s owner-scoped lookups, which answer 404 for another
 * account's node id — indistinguishable from one that does not exist.
 * No route accepts an owner/organization id from the caller; the scope
 * comes from the session. That is what stops a node id (a value that
 * travels: it is printed in UIs, logs and job payloads) from being a
 * cross-account read primitive.
 *
 * `FleetEnabledGuard` gates the class on `FLEET_ENABLED`, so the
 * registry and the node work channel go dark together.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard)
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

    @Get('nodes/:id')
    @ApiOperation({
        summary:
            'One fleet node with its recent job history and the failed subset of it (owner-scoped; another account’s node id answers 404, exactly like an unknown one)',
    })
    @HttpCode(HttpStatus.OK)
    async detail(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetNodeDetailView> {
        // Ownership is settled FIRST and by the registry: if this throws
        // 404 nothing else runs, so the job history can never be read
        // for a node the caller does not own.
        const node = await this.service.getForUser(auth.userId, id);

        let recentJobs: Awaited<ReturnType<FleetJobService['historyForNode']>> = [];
        let historyUnavailable = false;
        try {
            recentJobs = await this.jobs.historyForNode(auth.userId, id, NODE_HISTORY_LIMIT);
        } catch {
            // Same degradation contract as `list`: a job-runtime hiccup
            // must not make an existing node look missing.
            historyUnavailable = true;
        }

        return {
            node,
            recentJobs,
            failures: recentJobs.filter((job) => job.status === 'failed'),
            historyUnavailable,
        };
    }

    @Get('enrollment-tokens')
    @ApiOperation({
        summary:
            'Outstanding (minted but never used) enrollment tokens for my fleet. Lists the token metadata only — the plaintext token was returned exactly once at mint time and is not recoverable.',
    })
    @HttpCode(HttpStatus.OK)
    async listOutstandingTokens(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<FleetEnrollmentTokenView[]> {
        return this.service.listOutstandingTokensForUser(auth.userId);
    }

    @Delete('enrollment-tokens/:id')
    @ApiOperation({
        summary:
            'Revoke an outstanding enrollment token BEFORE it is used. Only unused tokens qualify — for an already-enrolled node use rotate (re-key) or delete (remove the machine).',
    })
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async revokeEnrollmentToken(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<void> {
        await this.service.revokeEnrollmentTokenForUser(auth.userId, id);
    }

    @Post('nodes/:id/rotate')
    @ApiOperation({
        summary:
            'Rotate a node credential: mints a fresh one-time enrollment token (returned exactly once) and invalidates the old node secret immediately, so the machine must re-enroll.',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async rotate(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<CreateEnrollmentTokenResult> {
        return this.service.rotateCredentialForUser(auth.userId, id);
    }

    @Post('nodes/:id/drain')
    @ApiOperation({
        summary:
            'Drain a node: disable it AND return its in-flight claims to the queue so the work is picked up elsewhere immediately instead of waiting out each lease. `drain: false` returns it to service.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async drain(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: DrainFleetNodeDto,
    ): Promise<FleetNodeDrainResult> {
        // Order matters: disable FIRST. The node stops being able to
        // lease the instant its status flips, so a claim requeued after
        // that cannot be re-claimed by the machine being drained.
        const node = await this.service.setDisabledForUser(auth.userId, id, body.drain);
        const releasedJobs = body.drain ? await this.jobs.releaseClaimsForNode(auth.userId, id) : 0;
        return { node, releasedJobs };
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
    @ApiOperation({
        summary: 'Rename, disable/enable, and/or hand-edit the capability tags of a fleet node',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateFleetNodeDto,
    ): Promise<FleetNodeView> {
        if (
            typeof body.name !== 'string' &&
            typeof body.disabled !== 'boolean' &&
            !Array.isArray(body.capabilities)
        ) {
            throw new BadRequestException('Provide name, disabled and/or capabilities');
        }
        let view: FleetNodeView | null = null;
        if (typeof body.name === 'string') {
            view = await this.service.renameForUser(auth.userId, id, body.name);
        }
        if (Array.isArray(body.capabilities)) {
            // Writing tags pins them by default: an admin edit the
            // machine silently reverts on its next heartbeat would not
            // be an edit. `capabilitiesPinned: false` opts back out.
            view = await this.service.setCapabilitiesForUser(
                auth.userId,
                id,
                body.capabilities,
                body.capabilitiesPinned ?? true,
            );
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
