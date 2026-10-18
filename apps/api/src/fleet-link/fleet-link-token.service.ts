import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { FLEET_LINK_TOKEN_TTL_SEC, FLEET_LINK_WS_PATH } from '@ever-works/contracts';
import { TerminalAttachService } from '../terminal/terminal-attach.service';

/**
 * Fleet node link — the node's link token (CONTRACTS §3.1, spec FR-3, FR-5).
 *
 * NOT a second signer: it rides the streaming terminal's HMAC attach signer
 * (fail-closed secret, constant-time check) with its own channel claim
 * `fleet-link`, the node id as the token's subject, the `worker` role, a
 * five-minute lifetime and a `jti`. The gateway CONSUMES a token: the `jti`
 * is recorded by the replay guard and a second presentation is refused, as
 * is a token minted for another node — with the same undifferentiated close
 * as an expired or malformed one.
 */

/** Records a token id once; answers false for one already seen. */
export interface FleetLinkReplayGuard {
    /** True the first time `jti` is seen within `ttlMs`; false after. */
    claim(jti: string, ttlMs: number): Promise<boolean> | boolean;
}

/** In-process replay guard: a map of seen ids, pruned as they expire. */
export class InProcessFleetLinkReplayGuard implements FleetLinkReplayGuard {
    private readonly seen = new Map<string, number>();

    constructor(private readonly now: () => number = () => Date.now()) {}

    claim(jti: string, ttlMs: number): boolean {
        const now = this.now();
        if (this.seen.size > 1_000) {
            for (const [id, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(id);
        }
        const expiresAt = this.seen.get(jti);
        if (expiresAt !== undefined && expiresAt > now) return false;
        this.seen.set(jti, now + ttlMs);
        return true;
    }
}

/**
 * Bound to the relay bus's guard when Valkey is configured (so a token is
 * single-use across replicas); the in-process guard otherwise — with two
 * replicas and no bus, which `FLEET_RELAY_REQUIRE_BUS` makes a boot error, a
 * token could be presented once to each (CONTRACTS R-7, accepted).
 */
export const FLEET_LINK_REPLAY_GUARD = 'FLEET_LINK_REPLAY_GUARD' as const;

export interface FleetLinkTokenGrant {
    token: string;
    wsPath: string;
    expiresInSec: number;
}

@Injectable()
export class FleetLinkTokenService {
    private readonly replay: FleetLinkReplayGuard;

    constructor(
        private readonly signer: TerminalAttachService,
        @Optional() @Inject(FLEET_LINK_REPLAY_GUARD) replay?: FleetLinkReplayGuard,
    ) {
        this.replay = replay ?? new InProcessFleetLinkReplayGuard();
    }

    /** Mint a token for `nodeId`'s link. Throws 503 when no attach secret is configured. */
    mint(nodeId: string): FleetLinkTokenGrant {
        const { token, expiresInSec } = this.signer.mint(
            {
                userId: `node:${nodeId}`,
                runId: nodeId,
                role: 'worker',
                channel: 'fleet-link',
                jti: randomUUID(),
            },
            { ttlSec: FLEET_LINK_TOKEN_TTL_SEC },
        );
        return { token, wsPath: FLEET_LINK_WS_PATH, expiresInSec };
    }

    /**
     * Accept a token presented in a hello for `nodeId`, once. False for
     * ANYTHING else — bad shape or MAC, expired, another family's token,
     * another node's, a token without a `jti`, or one already used. Never throws.
     */
    async consume(token: string, nodeId: string): Promise<boolean> {
        const claims = this.signer.verify(token);
        if (
            !claims ||
            claims.channel !== 'fleet-link' ||
            claims.role !== 'worker' ||
            claims.runId !== nodeId ||
            claims.userId !== `node:${nodeId}` ||
            typeof claims.jti !== 'string'
        ) {
            return false;
        }
        try {
            return await this.replay.claim(claims.jti, Math.max(1, claims.exp - Date.now()));
        } catch {
            // A guard that cannot answer must not let a token through twice.
            return false;
        }
    }
}
