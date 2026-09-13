import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Optional,
    Param,
    PayloadTooLargeException,
    Post,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { isUUID } from 'class-validator';
import {
    decodedComputerBase64Bytes,
    isComputerFrameBatchWithinCaps,
    isComputerNodeToServerFrame,
    normalizeComputerFrame,
    type ComputerCloseReason,
    type ComputerEndFrame,
} from '@ever-works/contracts';
import {
    ComputerSession,
    ComputerSessionService,
    NodeAgentProfileService,
} from '@ever-works/agent/computer';
import { Public } from '../auth/decorators/public.decorator';
import { FleetJobNodeCredentialDto } from '../fleet/dto/fleet-job.dto';
import { CurrentFleetNode } from '../fleet/decorators/fleet-node.decorator';
import { FleetEnabledGuard } from '../fleet/guards/fleet-enabled.guard';
import {
    FLEET_NODE_UNAUTHORIZED_MESSAGE,
    FleetNodeAuthGuard,
    type AuthenticatedFleetNode,
} from '../fleet/guards/fleet-node-auth.guard';
import { ComputerAttachService } from './computer-attach.service';
import { ComputerRelayRegistry } from './computer-relay.registry';
import {
    COMPUTER_PUBLISH_MAX_ITEMS,
    ComputerProfileReportDto,
    ComputerSessionHeartbeatDto,
    PublishComputerFramesDto,
} from './dto/computer.dto';
import { COMPUTER_WS_PATH_PREFIX } from './computer-ws.service';

/**
 * Agent computers — the machine-facing endpoints (outbound only: the node
 * calls these; nothing ever connects into a user's machine).
 *
 *   POST /api/internal/computer/:sessionId/frames        publish pictures
 *   POST /api/internal/computer/:sessionId/heartbeat     lifecycle report
 *   POST /api/internal/computer/:sessionId/worker-token  the machine's own WS leg
 *   POST /api/internal/computer/:sessionId/profile       the Agent profile's usage
 *
 * Authenticated by the node secret through the fleet's own
 * `FleetNodeAuthGuard` — reused, not re-implemented — so a disabled or
 * still-enrolling machine is refused at the edge. A session belonging to a
 * DIFFERENT machine gets that guard's exact 401 as well: a node credential
 * can never publish into, or even confirm the existence of, another
 * machine's live view.
 *
 * Batch caps are enforced on the raw body BEFORE a single frame is decoded.
 */
@ApiExcludeController()
@Controller('api/internal/computer')
@UseGuards(FleetEnabledGuard, FleetNodeAuthGuard)
export class ComputerInternalController {
    constructor(
        private readonly sessions: ComputerSessionService,
        private readonly relay: ComputerRelayRegistry,
        private readonly attach: ComputerAttachService,
        @Optional() private readonly profiles?: NodeAgentProfileService,
    ) {}

    @Public()
    @Post(':sessionId/frames')
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 1200, ttl: 60_000 } })
    async publishFrames(
        @CurrentFleetNode() node: AuthenticatedFleetNode,
        @Param('sessionId') sessionId: string,
        @Body() body: PublishComputerFramesDto,
    ): Promise<{
        accepted: number;
        dropped: number;
        ended: boolean;
        closeReason: ComputerCloseReason | null;
    }> {
        const items = Array.isArray(body?.frames) ? body.frames : [];
        if (items.length > COMPUTER_PUBLISH_MAX_ITEMS || !isComputerFrameBatchWithinCaps(items)) {
            throw new PayloadTooLargeException('Frame batch exceeds the live-view publish caps');
        }
        const row = await this.requireOpenSession(node, sessionId);
        if (row.status === 'ended' || (await this.sessions.endIfStopped(row))) {
            return this.endedAnswer(node, sessionId, row, items.length);
        }

        let accepted = 0;
        let dropped = 0;
        let pictures = 0;
        let pictureBytes = 0;
        let end: ComputerEndFrame | null = null;
        for (const item of items) {
            const frame = normalizeComputerFrame(item);
            // Nothing after the machine's own end frame is relayed, exactly as
            // the relay itself refuses anything after a pinned end.
            if (!frame || !isComputerNodeToServerFrame(frame) || end) {
                dropped += 1;
                continue;
            }
            if (frame.kind === 'end') {
                // NOT relayed here. The end is persisted first and pinned on
                // the relay only after that write succeeded: pinned first, a
                // failed write would leave the relay refusing the machine's
                // retry of the same end frame, and the session could never be
                // recorded as ended. Until the pin, a retry is simply the same
                // request again.
                end = frame;
                if (this.relay.getStatus(sessionId).ended) dropped += 1;
                else accepted += 1;
                continue;
            }
            if (!this.relay.publish(sessionId, frame)) {
                dropped += 1;
                continue;
            }
            accepted += 1;
            if (frame.kind === 'frame') {
                pictures += 1;
                pictureBytes += decodedComputerBase64Bytes(frame.data);
            }
        }
        await this.sessions.recordPublished(row, { frames: pictures, bytes: pictureBytes });
        if (end) {
            // Idempotent: the close is a compare-and-set, so a retry after a
            // partial failure records the end once and never a second time.
            await this.sessions.recordNodeReport(row, { status: 'ended', closeReason: end.reason });
            const current = (await this.sessions.findForNode(sessionId, node.id)) ?? row;
            const closeReason = (current.closeReason ?? end.reason) as ComputerCloseReason;
            // Usually already pinned by the session's `ended` event with this
            // same reason; this makes the relay agree with the record even
            // where nothing listens for that event. A no-op on an ended relay.
            this.relay.end(sessionId, closeReason);
            return { accepted, dropped, ended: true, closeReason };
        }
        return { accepted, dropped, ended: false, closeReason: null };
    }

    @Public()
    @Post(':sessionId/heartbeat')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 240, ttl: 60_000 } })
    async heartbeat(
        @CurrentFleetNode() node: AuthenticatedFleetNode,
        @Param('sessionId') sessionId: string,
        @Body() body: ComputerSessionHeartbeatDto,
    ): Promise<{ ok: true; ended: boolean; closeReason: ComputerCloseReason | null }> {
        const row = await this.requireOpenSession(node, sessionId);
        if (row.status !== 'ended' && !(await this.sessions.endIfStopped(row))) {
            await this.sessions.recordNodeReport(row, {
                status: body.status,
                closeReason: body.closeReason,
            });
        }
        const current = (await this.sessions.findForNode(sessionId, node.id)) ?? row;
        return {
            ok: true,
            ended: current.status === 'ended',
            closeReason: current.closeReason ?? null,
        };
    }

    /**
     * The machine's own inbound leg: a `worker` token for this session, used
     * on the SAME live-view gateway browsers use. Brokered by session id and
     * the node credential; never handed to a browser.
     */
    @Public()
    @Post(':sessionId/worker-token')
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async mintWorkerToken(
        @CurrentFleetNode() node: AuthenticatedFleetNode,
        @Param('sessionId') sessionId: string,
        // Validated so the credential body has the one shape every node route accepts.
        @Body() _credential: FleetJobNodeCredentialDto,
    ): Promise<{ token: string; wsPath: string; expiresInSec: number }> {
        const row = await this.requireOpenSession(node, sessionId);
        // A stopped fleet ends the view here and mints nothing — the same
        // check every other machine-facing route makes before it acts.
        if (row.status === 'ended' || (await this.sessions.endIfStopped(row))) {
            throw new UnauthorizedException(FLEET_NODE_UNAUTHORIZED_MESSAGE);
        }
        const { token, expiresInSec } = this.attach.mint({
            userId: `node:${node.id}`,
            sessionId,
            role: 'worker',
        });
        return { token, wsPath: `${COMPUTER_WS_PATH_PREFIX}${sessionId}`, expiresInSec };
    }

    @Public()
    @Post(':sessionId/profile')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async reportProfile(
        @CurrentFleetNode() node: AuthenticatedFleetNode,
        @Param('sessionId') sessionId: string,
        @Body() body: ComputerProfileReportDto,
    ): Promise<{ accepted: boolean }> {
        const row = await this.requireSession(node, sessionId);
        if (!this.profiles) return { accepted: false };
        const accepted = await this.profiles.recordSelfReport({
            nodeId: node.id,
            agentId: row.agentId,
            profileKey: body.profileKey,
            signedInSiteCount: body.signedInSiteCount,
            diskBytes: body.diskBytes,
        });
        return { accepted };
    }

    /** This machine's session, or the guard's own undifferentiated 401. */
    private async requireSession(
        node: AuthenticatedFleetNode,
        sessionId: string,
    ): Promise<ComputerSession> {
        if (!node || typeof sessionId !== 'string' || !isUUID(sessionId)) {
            throw new UnauthorizedException(FLEET_NODE_UNAUTHORIZED_MESSAGE);
        }
        const row = await this.sessions.findForNode(sessionId, node.id);
        if (!row) {
            throw new UnauthorizedException(FLEET_NODE_UNAUTHORIZED_MESSAGE);
        }
        return row;
    }

    /**
     * {@link requireSession}, then expired if it is past its time — owner-
     * independent, so a view no machine claimed within its claim timeout is
     * ended as `abandoned` here rather than being made live by a machine that
     * leased its job late.
     */
    private async requireOpenSession(
        node: AuthenticatedFleetNode,
        sessionId: string,
    ): Promise<ComputerSession> {
        const row = await this.requireSession(node, sessionId);
        return row.status === 'ended' ? row : this.sessions.expireIfDue(row);
    }

    private async endedAnswer(
        node: AuthenticatedFleetNode,
        sessionId: string,
        row: ComputerSession,
        dropped: number,
    ) {
        const current = (await this.sessions.findForNode(sessionId, node.id)) ?? row;
        return {
            accepted: 0,
            dropped,
            ended: true,
            closeReason: (current.closeReason ?? null) as ComputerCloseReason | null,
        };
    }
}
