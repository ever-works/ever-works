import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { FleetNodeRepository } from '@ever-works/agent/fleet';
import { config } from '@ever-works/agent/config';
import {
    FLEET_LINK_VIEWER_MAX_PARAMS_BYTES,
    FLEET_LINK_VIEWER_TOKEN_RATE_LIMIT,
    FLEET_LINK_VIEWER_TOKEN_TTL_SEC,
    fleetLinkViewerKey,
    fleetLinkViewerPath,
    isFleetLinkActionFamily,
    isFleetLinkConsentRequirement,
    isFleetLinkFamily,
    isFleetLinkViewerRole,
    isFleetLinkViewerTarget,
    type FleetLinkFamily,
    type FleetLinkViewerRole,
} from '@ever-works/contracts';
import { TerminalAttachService } from '../terminal/terminal-attach.service';
import { FleetLinkAuthorizer } from './fleet-link.authorizer';
import { describeAgo, fleetLinkError } from './fleet-link.errors';
import { FleetLinkService, nodeFacts } from './fleet-link.service';
import {
    FLEET_LINK_REPLAY_GUARD,
    fleetLinkClaimTtlMs,
    InProcessFleetLinkReplayGuard,
    type FleetLinkReplayGuard,
} from './fleet-link-token.service';
import type { FleetLinkCaller, FleetLinkRequirement } from './fleet-link.types';

/**
 * Viewer tokens for a node-link channel (FL-02, spec FR-32, CONTRACTS §11.2).
 *
 * The ONE minter: every epic that shows a channel in a browser — sessions
 * (FL-04), the desktop (FL-07), logs (FL-08) — calls {@link mint} from its own
 * attach-token route; there is no generic route here. A token:
 *
 *  - is minted only after the same authorisation a channel open gets
 *    (existence → kill switch → consent → family audience), for a person,
 *    for a computer whose link is up on some API replica;
 *  - binds one family + target (the socket path), one role (`viewer` or
 *    `driver`), the node, and the open params; lives 60 seconds; opens one
 *    socket once — its `jti` is claimed on the relay bus, so a second
 *    presentation fails on every replica;
 *  - rides the existing attach signer under its own channel claim
 *    (`fleet-link-viewer`), so no terminal, computer or link token opens a
 *    viewer socket and a viewer token opens nothing else.
 *
 * A person may be minted {@link FLEET_LINK_VIEWER_TOKEN_RATE_LIMIT} a minute
 * (counted on this replica).
 */

export interface FleetLinkViewerGrant {
    token: string;
    /** `/ws/fleet/<family>/<target>` on the API origin. */
    wsPath: string;
    expiresInSec: number;
    role: FleetLinkViewerRole;
}

/** What a presented token says, once it has been checked and used. */
export interface FleetLinkViewerClaims {
    userId: string;
    nodeId: string;
    family: FleetLinkFamily;
    target: string;
    role: FleetLinkViewerRole;
    params: Record<string, unknown>;
    /** The requirement the token was minted under — the open uses it again. */
    requirement: Partial<FleetLinkRequirement>;
}

export interface FleetLinkViewerMintInput {
    nodeId: string;
    family: FleetLinkFamily;
    /** What the path names: a session id, a live view, the node for logs … */
    target: string;
    role: FleetLinkViewerRole;
    caller: FleetLinkCaller;
    /** The params the channel opens with (≤ 512 bytes as JSON). */
    params?: Record<string, unknown>;
    /** Narrow the family's requirement (as `FleetLinkService.openChannel` takes it). */
    requirement?: Partial<FleetLinkRequirement>;
}

const RATE_WINDOW_MS = 60_000;

/** The longest `requirement.target` a viewer token carries; a longer one is refused at mint, never cut. */
export const FLEET_LINK_VIEWER_MAX_TARGET_LENGTH = 256;

@Injectable()
export class FleetLinkAttachService {
    private readonly replay: FleetLinkReplayGuard;
    private readonly minted = new Map<string, number[]>();

    constructor(
        private readonly signer: TerminalAttachService,
        private readonly nodes: FleetNodeRepository,
        private readonly authorizer: FleetLinkAuthorizer,
        private readonly links: FleetLinkService,
        @Optional() @Inject(FLEET_LINK_REPLAY_GUARD) replay?: FleetLinkReplayGuard,
    ) {
        this.replay = replay ?? new InProcessFleetLinkReplayGuard();
    }

    /** The requirement a role opens with: a read-only viewer changes nothing. */
    static requirementFor(
        role: FleetLinkViewerRole,
        narrow: Partial<FleetLinkRequirement> = {},
    ): Partial<FleetLinkRequirement> {
        return role === 'viewer' ? { ...narrow, stateChanging: false } : narrow;
    }

    async mint(input: FleetLinkViewerMintInput): Promise<FleetLinkViewerGrant> {
        if (!config.fleet.isNodeLinkEnabled()) {
            throw fleetLinkError('unreachable', 'this deployment does not accept node links yet');
        }
        if (!isFleetLinkFamily(input.family))
            throw fleetLinkError('invalid', 'family', { family: input.family });
        if (!isFleetLinkViewerTarget(input.target))
            throw fleetLinkError('invalid', 'target', { target: input.target });
        if (!isFleetLinkViewerRole(input.role))
            throw fleetLinkError('invalid', 'role', { role: input.role });
        if (input.caller.kind !== 'user') {
            throw fleetLinkError('invalid', 'viewer tokens are minted for a person');
        }
        const params = input.params ?? {};
        // Bytes, not UTF-16 units: the token carries them base64url-encoded.
        if (
            Buffer.byteLength(JSON.stringify(params), 'utf8') > FLEET_LINK_VIEWER_MAX_PARAMS_BYTES
        ) {
            throw fleetLinkError('invalid', 'params', {
                maxBytes: FLEET_LINK_VIEWER_MAX_PARAMS_BYTES,
            });
        }
        // The token must carry the target it was authorised for, whole: a
        // cut one would open (and audit) a different target than the mint
        // checked.
        const target = input.requirement?.target;
        if (
            target !== undefined &&
            target !== null &&
            (typeof target !== 'string' || target.length > FLEET_LINK_VIEWER_MAX_TARGET_LENGTH)
        ) {
            throw fleetLinkError('invalid', 'requirement.target', {
                maxLength: FLEET_LINK_VIEWER_MAX_TARGET_LENGTH,
            });
        }
        this.admit(input.caller.userId);
        const node =
            typeof input.nodeId === 'string' && input.nodeId.length > 0
                ? await this.nodes.findById(input.nodeId)
                : null;
        if (!node) throw fleetLinkError('not_found', 'no such computer');
        const facts = nodeFacts(node);
        const requirement = FleetLinkAttachService.requirementFor(input.role, input.requirement);
        await this.authorizer.authorize({
            node: facts,
            caller: input.caller,
            family: input.family,
            requirement,
        });
        if (!this.links.isConnected(node.id)) {
            const ago = describeAgo(facts.lastHeartbeatAt);
            throw fleetLinkError(
                'unreachable',
                ago
                    ? `${node.name} is not connected; last seen ${ago} ago`
                    : `${node.name} is not connected`,
                { nodeId: node.id },
            );
        }
        const { token, expiresInSec } = this.signer.mint(
            {
                userId: input.caller.userId,
                runId: fleetLinkViewerKey(input.family, input.target),
                role: input.role,
                channel: 'fleet-link-viewer',
                jti: randomUUID(),
                linkNodeId: node.id,
                linkParams: params,
                // The open re-authorises under the SAME narrowed requirement.
                linkRequirement: requirementClaim(requirement),
            },
            { ttlSec: FLEET_LINK_VIEWER_TOKEN_TTL_SEC },
        );
        return {
            token,
            wsPath: fleetLinkViewerPath(input.family, input.target)!,
            expiresInSec,
            role: input.role,
        };
    }

    /**
     * Check a token presented on `/ws/fleet/<family>/<target>` and use it up.
     * Null for ANYTHING else — bad MAC, expired, another family's token,
     * another path's, one already used, a replay guard that cannot answer.
     */
    async verify(
        token: unknown,
        path: { family: FleetLinkFamily; target: string },
    ): Promise<FleetLinkViewerClaims | null> {
        if (typeof token !== 'string') return null;
        const claims = this.signer.verify(token);
        if (
            !claims ||
            claims.channel !== 'fleet-link-viewer' ||
            !isFleetLinkViewerRole(claims.role) ||
            claims.runId !== fleetLinkViewerKey(path.family, path.target) ||
            typeof claims.linkNodeId !== 'string' ||
            claims.linkNodeId.length === 0 ||
            typeof claims.jti !== 'string' ||
            claims.userId.length === 0
        ) {
            return null;
        }
        try {
            const fresh = await this.replay.claim(
                `viewer:${claims.jti}`,
                fleetLinkClaimTtlMs(claims.exp),
            );
            if (!fresh) return null;
        } catch {
            return null;
        }
        const params =
            claims.linkParams &&
            typeof claims.linkParams === 'object' &&
            !Array.isArray(claims.linkParams)
                ? claims.linkParams
                : {};
        return {
            userId: claims.userId,
            nodeId: claims.linkNodeId,
            family: path.family,
            target: path.target,
            role: claims.role,
            params,
            requirement: requirementFromClaim(claims.linkRequirement),
        };
    }

    private admit(userId: string): void {
        const now = Date.now();
        const recent = (this.minted.get(userId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
        if (recent.length >= FLEET_LINK_VIEWER_TOKEN_RATE_LIMIT) {
            throw fleetLinkError(
                'limit_exceeded',
                `${FLEET_LINK_VIEWER_TOKEN_RATE_LIMIT} viewer tokens a minute; wait a moment`,
                { limit: FLEET_LINK_VIEWER_TOKEN_RATE_LIMIT },
            );
        }
        recent.push(now);
        this.minted.set(userId, recent);
        if (this.minted.size > 10_000) {
            for (const [id, times] of this.minted) {
                if (times.every((at) => now - at >= RATE_WINDOW_MS)) this.minted.delete(id);
            }
        }
    }
}

/** The requirement as a token claim: only its known fields (`mint` already refused a target over the cap). */
function requirementClaim(requirement: Partial<FleetLinkRequirement>): Record<string, unknown> {
    const claim: Record<string, unknown> = {};
    if (requirement.consent !== undefined) claim.consent = requirement.consent;
    if (requirement.actionFamily !== undefined) claim.actionFamily = requirement.actionFamily;
    if (requirement.stateChanging !== undefined) claim.stateChanging = requirement.stateChanging;
    if (typeof requirement.target === 'string') claim.target = requirement.target;
    return claim;
}

/** A requirement claim read back; a field this build does not recognise is dropped (the family default applies). */
function requirementFromClaim(value: unknown): Partial<FleetLinkRequirement> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const claim = value as Record<string, unknown>;
    const requirement: Partial<FleetLinkRequirement> = {};
    if (isFleetLinkConsentRequirement(claim.consent)) requirement.consent = claim.consent;
    if (isFleetLinkActionFamily(claim.actionFamily)) requirement.actionFamily = claim.actionFamily;
    if (typeof claim.stateChanging === 'boolean') requirement.stateChanging = claim.stateChanging;
    if (
        typeof claim.target === 'string' &&
        claim.target.length <= FLEET_LINK_VIEWER_MAX_TARGET_LENGTH
    )
        requirement.target = claim.target;
    return requirement;
}
