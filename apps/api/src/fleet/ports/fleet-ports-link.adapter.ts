import { Injectable } from '@nestjs/common';
import {
    FleetPortsException,
    type FleetPortsNodePort,
    type FleetPortsNodeRequest,
    type FleetPortsPreviewAttachRequest,
} from '@ever-works/agent/fleet';
import {
    makeFleetLinkError,
    type FleetConsents,
    type FleetPortOpenResult,
} from '@ever-works/contracts';
import { FleetLinkAttachService } from '../../fleet-link/fleet-link-attach.service';
import { FleetLinkException } from '../../fleet-link/fleet-link.errors';
import { FleetLinkService } from '../../fleet-link/fleet-link.service';

/**
 * Servers and ports (FL-10) — `FLEET_PORTS_NODE_PORT` over the node link
 * (FL-02). The agent package's `FleetPortsService` decides; this only carries
 * one request to the machine and its answer back, and mints the viewer token
 * for the preview picture.
 *
 *  - `request` → `FleetLinkService.request` on the shared `machine` channel,
 *    with the verb's action family (`view` for `ports.list`, `ports` for
 *    `ports.open`) and whether it changes the machine — so the link's gate
 *    runs first in its order (flag, existence, kill switch, `manage` against
 *    the live consents, the audience, connected). A `ports` verb never answers
 *    with a long-running operation id; a node that does is one this platform
 *    does not understand.
 *  - `mintPreviewAttach` → FL-02's one minter, `desktop` family, target the
 *    view id, role `driver`, params `{ source: 'browser', profile: 'preview',
 *    viewId }` (CONTRACTS §3.3), narrowed to the `ports` family: the person
 *    who opened the preview is the one who drives it. The family's consent
 *    stays `attend` (the minter re-checks it).
 *
 * The link's refusal comes back as a `FleetPortsException` with the same
 * CONTRACTS §8 error, so the service and the controller read one shape.
 */
@Injectable()
export class FleetPortsLinkAdapter implements FleetPortsNodePort {
    constructor(
        private readonly link: FleetLinkService,
        private readonly attach: FleetLinkAttachService,
    ) {}

    isConnected(nodeId: string): boolean {
        return this.link.isConnected(nodeId);
    }

    liveConsents(nodeId: string): FleetConsents | null {
        return this.link.liveConsents(nodeId);
    }

    async request(input: FleetPortsNodeRequest): Promise<unknown> {
        try {
            const outcome = await this.link.request({
                nodeId: input.nodeId,
                verb: input.verb,
                params: input.params,
                caller: input.caller,
                requirement: {
                    actionFamily: input.actionFamily,
                    stateChanging: input.stateChanging,
                    target: input.target ?? null,
                },
                ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
            });
            if (outcome.operationId !== undefined) {
                throw new FleetPortsException(
                    makeFleetLinkError(
                        'operation_failed',
                        'the computer answered a ports request in a way this platform does not understand',
                    ),
                );
            }
            return outcome.result;
        } catch (error) {
            if (error instanceof FleetLinkException) throw new FleetPortsException(error.linkError);
            throw error;
        }
    }

    async mintPreviewAttach(
        input: FleetPortsPreviewAttachRequest,
    ): Promise<NonNullable<FleetPortOpenResult['attach']>> {
        try {
            const grant = await this.attach.mint({
                nodeId: input.nodeId,
                family: 'desktop',
                target: input.viewId,
                role: 'driver',
                caller: { kind: 'user', userId: input.userId },
                params: { source: 'browser', profile: 'preview', viewId: input.viewId },
                requirement: { actionFamily: 'ports', target: input.viewId },
            });
            return {
                token: grant.token,
                wsPath: grant.wsPath,
                expiresInSec: grant.expiresInSec,
                role: grant.role,
            };
        } catch (error) {
            if (error instanceof FleetLinkException) throw new FleetPortsException(error.linkError);
            throw error;
        }
    }
}
