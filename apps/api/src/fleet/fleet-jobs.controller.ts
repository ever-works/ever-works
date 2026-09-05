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
    FleetJobMcpCredentialResponse,
    FleetJobMcpCredentialRevokeResponse,
} from '@ever-works/contracts';
import { FleetJobService, FleetRunCredentialService } from '@ever-works/agent/fleet';
import { Public } from '../auth/decorators/public.decorator';
import {
    CompleteFleetJobDto,
    FleetJobHeartbeatDto,
    FleetJobNodeCredentialDto,
    LeaseFleetJobsDto,
} from './dto/fleet-job.dto';
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
 *   POST /api/fleet/jobs/:id/mcp-credential          mint a run-scoped token
 *   POST /api/fleet/jobs/:id/mcp-credential/revoke   drop it early
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
    constructor(
        private readonly service: FleetJobService,
        private readonly runCredentials: FleetRunCredentialService,
    ) {}

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

    /**
     * Self-build slice Z (EW-796) — mint the run-scoped credential the
     * node's loopback MCP proxy authenticates with.
     *
     * Authorised by exactly one fact: this node currently HOLDS the lease
     * on this job. Everything else — a foreign node with a perfectly valid
     * secret, a finished job, a job with a cancel pending, a job whose
     * plan never enabled the bridge — returns the same undifferentiated
     * 401 the rest of this controller uses, so a node cannot probe which
     * jobs exist or what state they are in.
     *
     * The minted token expires with the lease it was minted under (plus a
     * small grace). A long model step therefore RE-MINTS as its lease is
     * renewed, which is why the throttle is sized like the heartbeat's
     * rather than like complete's.
     *
     * The response carries the raw token exactly once. It is never
     * readable again, never written to disk by either side, and never
     * echoed by any other endpoint.
     */
    @Public()
    @Post(':id/mcp-credential')
    @ApiOperation({
        summary:
            'Mint a run-scoped MCP credential for a job this node holds (public, node-secret-authenticated). Bound to the job, run, owner and Organization, expiring with the lease. Returned once; never recoverable.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 240, ttl: 60_000 } })
    async mintMcpCredential(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetJobNodeCredentialDto,
    ): Promise<FleetJobMcpCredentialResponse> {
        const credential = await this.runCredentials.mint({
            nodeId: body.nodeId,
            secret: body.secret,
            jobId: id,
        });
        if (!credential) {
            throw new UnauthorizedException('Invalid node credential');
        }
        return credential;
    }

    /**
     * Early revoke, called by the node the moment the model step ends.
     *
     * Not the ONLY revoke — the API-side completion listener revokes again
     * whatever happens, including for a node that crashed and never got
     * here — but it shortens the window from "until the job settles" to
     * "until the model stopped running", which is most of the value.
     */
    @Public()
    @Post(':id/mcp-credential/revoke')
    @ApiOperation({
        summary:
            'Revoke the run-scoped MCP credentials of a job this node holds (public, node-secret-authenticated). Idempotent; the platform also revokes at completion.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 240, ttl: 60_000 } })
    async revokeMcpCredential(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetJobNodeCredentialDto,
    ): Promise<FleetJobMcpCredentialRevokeResponse> {
        const revoked = await this.runCredentials.revokeForNode({
            nodeId: body.nodeId,
            secret: body.secret,
            jobId: id,
        });
        if (revoked === null) {
            throw new UnauthorizedException('Invalid node credential');
        }
        return { ok: true, revoked };
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
