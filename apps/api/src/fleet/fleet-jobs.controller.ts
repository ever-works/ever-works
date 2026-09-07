import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    UnauthorizedException,
    UnprocessableEntityException,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type {
    FleetJobCompleteResponse,
    FleetJobEnvFilesResponse,
    FleetJobHeartbeatResponse,
    FleetJobLeaseResponse,
    FleetJobMcpCredentialResponse,
    FleetJobMcpCredentialRevokeResponse,
    FleetJobPushCredentialResponse,
} from '@ever-works/contracts';
import { FleetJobService, FleetRunCredentialService } from '@ever-works/agent/fleet';
import { Public } from '../auth/decorators/public.decorator';
import {
    CompleteFleetJobDto,
    FleetJobEnvFilesDto,
    FleetJobHeartbeatDto,
    FleetJobNodeCredentialDto,
    FleetJobPushCredentialDto,
    LeaseFleetJobsDto,
} from './dto/fleet-job.dto';
import {
    FleetPushCredentialError,
    FleetPushCredentialService,
} from './fleet-push-credential.service';
import { FleetRunSecretsError, FleetRunSecretsService } from './fleet-run-secrets.service';
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
 *   POST /api/fleet/jobs/:id/env-files  fetch the run's seed .env contents
 *
 * The fourth route (run secrets, self-build slice Y) takes the SAME
 * posture, deliberately: it is the only place a decrypted secret leaves
 * the platform for a node, so it proves the claim with the same four
 * checks `complete` uses (credential, recorded holder, active status,
 * current lease generation) rather than inventing a second scheme. Its
 * REQUEST carries only registry row ids and file paths; the response body
 * is the one value-bearing shape in the whole channel, and nothing about
 * it is persisted, logged or echoed into the job.
 *
 * A resolution refusal (`FleetRunSecretsError` — unknown/disabled row, a
 * path the row no longer carries, a decrypt failure, the instance kill
 * switch) answers 422 with a STABLE machine token, never a partial file
 * list: a run that starts with half its environment fails as if the code
 * were broken, which is the failure this route exists to remove.
 *
 *   POST /api/fleet/jobs/:id/mcp-credential          mint a run-scoped token
 *   POST /api/fleet/jobs/:id/mcp-credential/revoke   drop it early
 *   POST /api/fleet/jobs/:id/push-credential         mint a scoped write token
 *
 * The push credential (self-build slice AM) takes the env-files posture
 * exactly: the same four checks, a 422 with a stable token on refusal, and
 * no partial answer. It is the second place a secret leaves the platform
 * for a node, and the first place one leaves that can WRITE — so it is
 * scoped from platform state alone (this job's repositories,
 * `contents: write`, under the hour) and there is no degraded path back to
 * the machine's own credential helper.
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
        private readonly runSecrets: FleetRunSecretsService,
        private readonly runCredentials: FleetRunCredentialService,
        // Self-build slice AM (EW-810). Appended LAST so the positional
        // constructions in the existing controller specs keep compiling.
        private readonly pushCredentials: FleetPushCredentialService,
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

    /**
     * Self-build slice AM (EW-810) — the run's commit attribution and,
     * when its plan pushes, a SCOPED write credential for the repositories
     * this job touches.
     *
     * The gap it closes: before this route a node's `git push` was
     * authenticated by the machine's own Git credential helper — a
     * long-lived PAT with write access to every repository that OS user
     * can reach, which the platform could neither scope, rotate, revoke
     * nor observe. What comes back here is a GitHub App installation token
     * narrowed to this job's repositories and to `contents: write`,
     * expiring within the hour, revoked by the node the moment the run
     * ends.
     *
     * Same posture as `env-files`, and the SAME four checks: credential,
     * recorded holder, active status, current lease generation. Handing a
     * machine a write credential for the owner's repositories is at least
     * as consequential as handing it their decrypted `.env`.
     *
     * The request carries NO scope of any kind — no repository, no
     * installation, no branch. Everything the token is narrowed by comes
     * from platform state, because a caller that could name its own scope
     * would have defeated the narrowing.
     *
     * A refusal (no App configured, no installation covering every
     * repository this run writes to, a GitHub failure) answers 422 with a
     * STABLE machine token. There is deliberately no degraded answer: a
     * node that cannot get a scoped credential must fail the run, because
     * the only other way it could push is the ambient helper this route
     * exists to replace.
     */
    @Public()
    @Post(':id/push-credential')
    @ApiOperation({
        summary:
            "Mint a repository-scoped push credential and the commit attribution for a job this node holds (public, node-secret-authenticated). Scoped from platform state to this job's repositories with contents:write only, expiring within the hour. Returned once; never recoverable.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async pushCredential(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetJobPushCredentialDto,
    ): Promise<FleetJobPushCredentialResponse> {
        let response: FleetJobPushCredentialResponse | null;
        try {
            response = await this.pushCredentials.mint({
                nodeId: body.nodeId,
                secret: body.secret,
                jobId: id,
                leaseGeneration: body.leaseGeneration,
            });
        } catch (error) {
            // The stable token, and only the stable token. The refusal has
            // already been logged server-side with the job id; the node
            // gets a reason it can report, never an installation id or a
            // GitHub response body.
            if (error instanceof FleetPushCredentialError) {
                throw new UnprocessableEntityException({ reason: error.reason });
            }
            // `FleetJobStaleLeaseError` propagates untouched, as 409
            // `{ reason: 'stale-lease' }` — same as heartbeat and complete.
            throw error;
        }
        if (!response) {
            throw new UnauthorizedException('Invalid node credential');
        }
        return response;
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

    @Public()
    @Post(':id/env-files')
    @ApiOperation({
        summary:
            'Fetch the decrypted seed .env files this run needs (public, node-secret-authenticated). Request carries repository registry row ids and repository-relative PATHS; the response carries their contents, which the node writes 0600 inside the checkout, keeps out of Git, and deletes when the run ends. Only the recorded holder of an active job, echoing the current leaseGeneration, is served. A reference that cannot be resolved fails the delivery whole, with a stable reason.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async envFiles(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetJobEnvFilesDto,
    ): Promise<FleetJobEnvFilesResponse> {
        let response: FleetJobEnvFilesResponse | null;
        try {
            response = await this.runSecrets.resolve({
                nodeId: body.nodeId,
                secret: body.secret,
                jobId: id,
                leaseGeneration: body.leaseGeneration,
                refs: body.refs,
            });
        } catch (error) {
            // The stable token, and only the stable token. A refusal here
            // has already been logged server-side with the job id; the node
            // gets a reason it can report, never a crypto or row detail.
            if (error instanceof FleetRunSecretsError) {
                throw new UnprocessableEntityException({ reason: error.reason });
            }
            // `FleetJobStaleLeaseError` propagates untouched, as 409
            // `{ reason: 'stale-lease' }` — same as heartbeat and complete.
            throw error;
        }
        if (!response) {
            throw new UnauthorizedException('Invalid node credential');
        }
        return response;
    }
}
