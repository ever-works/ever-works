import {
    Body,
    Controller,
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
import type {
    FleetJobCompleteResponse,
    FleetJobHeartbeatResponse,
    FleetJobLeaseResponse,
} from '@ever-works/contracts';
import { FleetJobService } from '@ever-works/agent/fleet';
import { Public } from '../auth/decorators/public.decorator';
import { CompleteFleetJobDto, FleetJobHeartbeatDto, LeaseFleetJobsDto } from './dto/fleet-job.dto';
import { FleetEnabledGuard } from './guards/fleet-enabled.guard';
import { FleetNodeAuthGuard } from './guards/fleet-node-auth.guard';

/**
 * Fleet job lease protocol (Desktop PRD §6.2 / M4) — the endpoints an
 * enrolled node calls to actually DO work.
 *
 * All three are `@Public()` and self-authenticating with the SAME node
 * secret minted at enrollment: the credential is in the body, checked
 * constant-time against the stored sha256, and every invalid path
 * (unknown node, disabled node, still-enrolling node, wrong secret,
 * someone else's job, terminal job) collapses to ONE undifferentiated
 * 401. That is deliberate — a differentiated error here would let an
 * attacker with a random uuid enumerate which nodes and jobs exist.
 *
 * The ONE differentiated answer is `409 { reason: 'stale-lease' }`
 * (suspend-safe leases, self-build finding R7), and it is reachable only
 * by an authenticated node that IS the recorded holder of an active job
 * but echoes a `leaseGeneration` that is no longer current — its claim
 * lapsed while the machine slept and was re-issued. Nothing a foreign,
 * unknown or superseded node sends can produce it, so it reveals nothing
 * the 401 posture was protecting. The service throws it; nothing here
 * catches it.
 *
 *   POST /api/fleet/jobs/lease          atomic CAS claim, capability-filtered
 *   POST /api/fleet/jobs/:id/heartbeat  extend the claim (leased → running)
 *   POST /api/fleet/jobs/:id/complete   report success or failure
 *
 * Throttles are sized for polling: a node with a 5-second idle poll
 * needs ~12 lease calls/minute, and job heartbeats fire at a third of
 * the lease TTL, so the limits accommodate a busy multi-node fleet
 * without letting one credential hammer the API.
 *
 * Separate controller from `FleetController` on purpose: registry
 * management (owner-scoped, session-authenticated) and the work channel
 * (node-authenticated, public) are two different trust boundaries and
 * should not share a class.
 *
 * **Guards.** `FleetEnabledGuard` gates the whole surface on
 * `FLEET_ENABLED` (404 when off — a disabled deployment does not admit
 * the channel exists). `FleetNodeAuthGuard` then authenticates the node
 * credential BEFORE any handler runs, so the trust boundary is
 * declarative at the edge instead of implicit inside each service call.
 * The service still re-verifies: the guard is the edge contract, the
 * service is the invariant, and neither is allowed to be the only check.
 */
@ApiTags('fleet')
@Controller('api/fleet/jobs')
@UseGuards(FleetEnabledGuard, FleetNodeAuthGuard)
export class FleetJobsController {
    constructor(private readonly service: FleetJobService) {}

    @Public()
    @Post('lease')
    @ApiOperation({
        summary:
            'Lease queued fleet jobs (public, node-secret-authenticated). Atomic CAS claim filtered by capability tags; two nodes racing the same job produce exactly one winner. Returns an empty array when the fleet has nothing queued for this node.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 240, ttl: 60_000 } })
    async lease(@Body() body: LeaseFleetJobsDto): Promise<FleetJobLeaseResponse> {
        const jobs = await this.service.lease({
            nodeId: body.nodeId,
            secret: body.secret,
            ...(body.max !== undefined ? { max: body.max } : {}),
            ...(body.leaseTtlSec !== undefined ? { leaseTtlSec: body.leaseTtlSec } : {}),
            ...(body.capabilities !== undefined ? { capabilities: body.capabilities } : {}),
        });
        if (jobs === null) {
            // One undifferentiated message — never say WHICH check failed.
            throw new UnauthorizedException('Invalid node credential');
        }
        return { jobs };
    }

    @Public()
    @Post(':id/heartbeat')
    @ApiOperation({
        summary:
            'Extend the lease on a job this node holds (public, node-secret-authenticated). The first beat also acknowledges the claim, moving the job from leased to running. Carries the leaseGeneration returned with the lease; a stale generation is refused with 409 stale-lease.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 600, ttl: 60_000 } })
    async heartbeat(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetJobHeartbeatDto,
    ): Promise<FleetJobHeartbeatResponse> {
        const job = await this.service.heartbeatJob(
            body.nodeId,
            body.secret,
            id,
            body.leaseTtlSec,
            body.leaseGeneration,
        );
        if (!job) {
            throw new UnauthorizedException('Invalid node credential');
        }
        return { ok: true, job };
    }

    @Public()
    @Post(':id/complete')
    @ApiOperation({
        summary:
            'Report the terminal outcome of a job this node holds (public, node-secret-authenticated). A reported failure is recorded as failed and NOT auto-retried — only lapsed leases (no verdict at all) go back to the pool. Carries the leaseGeneration returned with the lease; a stale generation is refused with 409 stale-lease and writes nothing.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 240, ttl: 60_000 } })
    async complete(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: CompleteFleetJobDto,
    ): Promise<FleetJobCompleteResponse> {
        const job = await this.service.completeJob({
            nodeId: body.nodeId,
            secret: body.secret,
            jobId: id,
            success: body.success,
            result: body.result ?? null,
            error: body.error ?? null,
            leaseGeneration: body.leaseGeneration,
        });
        if (!job) {
            throw new UnauthorizedException('Invalid node credential');
        }
        return { ok: true, job };
    }
}
