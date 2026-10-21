import { Injectable } from '@nestjs/common';
import { FleetSessionService, type FleetSessionActor } from '@ever-works/agent/fleet';
import {
    fleetSessionConsentFor,
    type FleetSessionAttachRole,
    type FleetSessionAttachTokenResponse,
} from '@ever-works/contracts';
import { FleetLinkAttachService } from '../../fleet-link/fleet-link-attach.service';
import { FleetSessionPresenceService } from './fleet-session-presence.service';

/**
 * Sessions on computers (FL-04 P1b, CONTRACTS §3.4, §11.2) — the attach token
 * behind `POST /api/fleet/sessions/:id/attach-token`.
 *
 * The session service decides whether the person may attach in this role
 * (existence and the `sessions` audience, the kill switch for drivers, an
 * ended session, the link, the five-viewer cap over this replica's
 * presence); FL-02's one minter (`FleetLinkAttachService.mint`) then
 * re-checks the link's own gate and signs a 60-second, single-use token bound
 * to `/ws/fleet/session/<id>`, the role and the channel params the node opens
 * with (`{ sessionId, kind }`; the gateway adds the role as `mode`). The token
 * rides this JSON answer only, never a URL.
 */
@Injectable()
export class FleetSessionAttachService {
    constructor(
        private readonly sessions: FleetSessionService,
        private readonly attach: FleetLinkAttachService,
        private readonly presence: FleetSessionPresenceService,
    ) {}

    async mint(
        sessionId: string,
        actor: FleetSessionActor,
        role: FleetSessionAttachRole,
    ): Promise<FleetSessionAttachTokenResponse> {
        const { session, node } = await this.sessions.authorizeAttach(
            sessionId,
            actor,
            role,
            this.presence.attachedIds(sessionId),
        );
        const grant = await this.attach.mint({
            nodeId: node.id,
            family: 'session',
            target: session.id,
            role,
            caller: { kind: 'user', userId: actor.userId },
            params: { sessionId: session.daemonSessionId, kind: session.kind },
            requirement: {
                consent: fleetSessionConsentFor(session.kind),
                actionFamily: 'sessions',
                target: session.id,
            },
        });
        return {
            token: grant.token,
            role: grant.role,
            expiresInSec: grant.expiresInSec,
            wsPath: grant.wsPath,
        };
    }
}
