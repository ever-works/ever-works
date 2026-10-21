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
import { FleetVirtualService } from '@ever-works/agent/fleet';
import type { FleetVirtualEnrollTokenResponse, FleetVirtualProgressReport } from '@ever-works/contracts';
import { Public } from '../../auth/decorators/public.decorator';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FLEET_NODE_UNAUTHORIZED_MESSAGE, FleetNodeAuthGuard } from '../guards/fleet-node-auth.guard';
import { FleetVirtualHostJobDto, FleetVirtualProgressDto } from './dto/fleet-virtual.dto';
import { FleetVirtualEnabledGuard } from './fleet-virtual-enabled.guard';

/**
 * Virtual computers (FL-16, plan §5, CONTRACTS R-35) — the two calls a HOST
 * makes while it builds or controls a child, with its own node credential:
 *
 *   POST /api/internal/fleet/virtual/:childId/enroll-token   the guest is ready: mint its token
 *   POST /api/internal/fleet/virtual/:childId/progress       a phase, a state, a failure line
 *
 * Both take the `push-credential` posture exactly (`FleetJobsController`):
 * `@Public()` + `FleetNodeAuthGuard` at the edge, then the service proves the
 * claim — the credential, the recorded holder of a live `vm-*` job whose
 * payload names THIS child on THIS host — and every refusal collapses to one
 * undifferentiated 401. The one differentiated answer is 409 `stale-lease`,
 * reachable only by the recorded holder echoing an old lease generation.
 *
 * The token is returned exactly once and never logged, audited or stored in
 * plaintext (only its sha256 replaces the child row's credential hash).
 */
@ApiTags('fleet')
@Controller('api/internal/fleet/virtual')
@UseGuards(FleetEnabledGuard, FleetVirtualEnabledGuard, FleetNodeAuthGuard)
export class FleetVirtualNodeController {
    constructor(private readonly virtual: FleetVirtualService) {}

    @Public()
    @Post(':childId/enroll-token')
    @ApiOperation({
        summary:
            'Mint the one-time enrolment token of a virtual computer this node is building (public, node-secret-authenticated, for a vm-* job it holds). Returned once; the node writes it to the guest’s private token file.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async enrollToken(
        @Param('childId', ParseUUIDPipe) childId: string,
        @Body() body: FleetVirtualHostJobDto,
    ): Promise<FleetVirtualEnrollTokenResponse> {
        const minted = await this.virtual.mintEnrollToken(childId, {
            nodeId: body.nodeId,
            secret: body.secret,
            jobId: body.jobId,
            leaseGeneration: body.leaseGeneration,
        });
        if (!minted) throw new UnauthorizedException(FLEET_NODE_UNAUTHORIZED_MESSAGE);
        return minted;
    }

    @Public()
    @Post(':childId/progress')
    @ApiOperation({
        summary:
            'Report a virtual computer’s create phase, machine state or first failure line (public, node-secret-authenticated, for a vm-* job this node holds).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async progress(
        @Param('childId', ParseUUIDPipe) childId: string,
        @Body() body: FleetVirtualProgressDto,
    ): Promise<{ ok: true }> {
        const report: Partial<FleetVirtualProgressReport> = {
            nodeId: body.nodeId,
            secret: body.secret,
            jobId: body.jobId,
            leaseGeneration: body.leaseGeneration,
        };
        if (body.phase !== undefined) report.phase = body.phase;
        if (body.state !== undefined) report.state = body.state;
        if (body.error !== undefined) report.error = body.error;
        if (body.image !== undefined) {
            report.image = body.image ? { ref: body.image.ref, digest: body.image.digest ?? null } : null;
        }
        if (body.activated !== undefined) report.activated = body.activated;
        const accepted = await this.virtual.reportProgress(childId, report);
        if (!accepted) throw new UnauthorizedException(FLEET_NODE_UNAUTHORIZED_MESSAGE);
        return { ok: true };
    }
}
