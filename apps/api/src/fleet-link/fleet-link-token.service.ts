import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import type { Repository } from 'typeorm';
import { FLEET_LINK_TOKEN_TTL_SEC, FLEET_LINK_WS_PATH } from '@ever-works/contracts';
import type { CacheEntry } from '@ever-works/agent/entities';
import { FleetNodeRepository } from '@ever-works/agent/fleet';
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
 *
 * Works-security (run-token scope, 2026-10-18): "single use" now holds across
 * API replicas (the replay guard is the shared `cache_entries` table), and a
 * token is bound to the credential generation it was minted under, so a
 * credential rotation kills every link token minted before it.
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
 * Works-security (run-token scope, 2026-10-18) — the SHARED replay guard: a
 * token id is claimed by INSERTing a primary-keyed row into `cache_entries`
 * (the table `DistributedTaskLockService` already uses as its cross-replica
 * mutex), so a second presentation is refused on EVERY API replica, not only
 * the one that saw the first. An expired claim for the same key is swept on
 * the way in.
 *
 * The relay bus this module once expected (Valkey, `FLEET_RELAY_REQUIRE_BUS`)
 * was never built, so `FLEET_LINK_REPLAY_GUARD` was never bound and every
 * replica kept its own in-process map: with N replicas one token opened N
 * links. The database every replica already shares is the store.
 */
export class CacheEntryFleetLinkReplayGuard implements FleetLinkReplayGuard {
    constructor(
        private readonly entries: Pick<Repository<CacheEntry>, 'insert' | 'createQueryBuilder'>,
        private readonly now: () => number = () => Date.now(),
    ) {}

    async claim(jti: string, ttlMs: number): Promise<boolean> {
        const key = `fleet-link-jti:${jti}`;
        const now = this.now();
        // A claim older than its token can no longer matter: drop it so the
        // key space stays bounded (and a recycled id is judged afresh).
        await this.entries
            .createQueryBuilder()
            .delete()
            .where('key = :key', { key })
            .andWhere('expiresAt < :now', { now })
            .execute();
        try {
            await this.entries.insert({ key, value: '1', expiresAt: now + Math.max(1, ttlMs) });
            return true;
        } catch (error) {
            // A duplicate key proves another replica (or an earlier
            // presentation) claimed it. Anything else rethrows, and
            // `consume` turns a guard that cannot answer into a refusal.
            if (isUniqueViolation(error)) return false;
            throw error;
        }
    }
}

/** Postgres `23505`, SQLite / MySQL duplicate key: the only "already claimed". */
function isUniqueViolation(error: unknown): boolean {
    const err = error as {
        code?: unknown;
        message?: unknown;
        driverError?: { code?: unknown; message?: unknown };
    };
    const codes = [err?.code, err?.driverError?.code].map((code) => String(code ?? ''));
    const duplicateCodes = [
        '23505',
        'ER_DUP_ENTRY',
        'SQLITE_CONSTRAINT_PRIMARYKEY',
        'SQLITE_CONSTRAINT_UNIQUE',
    ];
    if (codes.some((code) => duplicateCodes.includes(code))) return true;
    const message = `${String(err?.message ?? '')} ${String(err?.driverError?.message ?? '')}`;
    return (
        message.includes('UNIQUE constraint failed') ||
        message.includes('duplicate key value violates unique constraint') ||
        message.includes('Duplicate entry')
    );
}

/**
 * The replay guard binding. `FleetLinkApiModule` binds it to
 * {@link CacheEntryFleetLinkReplayGuard} (shared across replicas); the
 * in-process guard is only the fallback for a graph without one (unit tests).
 */
export const FLEET_LINK_REPLAY_GUARD = 'FLEET_LINK_REPLAY_GUARD' as const;

/**
 * Works-security (run-token scope) — the credential GENERATION a link token
 * is bound to: a one-way fingerprint of the node's current credential hash.
 * Rotating the credential (self-service or the owner's rotate) replaces the
 * hash, so every link token minted before the rotation stops matching — it no
 * longer lives on for the rest of its five minutes. Carries nothing secret:
 * the stored value is already a SHA-256 of the secret, hashed again here.
 */
export function fleetLinkCredentialGeneration(credentialHash: string | null | undefined): string {
    return createHash('sha256')
        .update(`fleet-link-credential:${credentialHash ?? ''}`)
        .digest('hex')
        .slice(0, 32);
}

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
        // Appended LAST + @Optional(): the credential-generation check. Bound
        // in production (the fleet module exports the repository); a graph
        // without it mints and consumes exactly as before.
        @Optional() private readonly nodes?: FleetNodeRepository,
    ) {
        this.replay = replay ?? new InProcessFleetLinkReplayGuard();
    }

    /**
     * Mint a token for `nodeId`'s link. Throws 503 when no attach secret is
     * configured. `credentialHash` (the node's current credential hash) binds
     * the token to that credential generation — see {@link mintForNode}.
     */
    mint(nodeId: string, credentialHash?: string | null): FleetLinkTokenGrant {
        const claims: Parameters<TerminalAttachService['mint']>[0] = {
            userId: `node:${nodeId}`,
            runId: nodeId,
            role: 'worker',
            channel: 'fleet-link',
            jti: randomUUID(),
        };
        if (credentialHash !== undefined) {
            claims.cred = fleetLinkCredentialGeneration(credentialHash);
        }
        const { token, expiresInSec } = this.signer.mint(claims, { ttlSec: FLEET_LINK_TOKEN_TTL_SEC });
        return { token, wsPath: FLEET_LINK_WS_PATH, expiresInSec };
    }

    /**
     * Mint a token bound to the node's CURRENT credential generation (works-
     * security, run-token scope): a rotation between mint and hello refuses
     * it. Without the node repository bound it is {@link mint} unchanged.
     */
    async mintForNode(nodeId: string): Promise<FleetLinkTokenGrant> {
        if (!this.nodes) return this.mint(nodeId);
        const node = await this.nodes.findById(nodeId);
        return this.mint(nodeId, node?.enrollmentTokenHash ?? null);
    }

    /**
     * Accept a token presented in a hello for `nodeId`, once. False for
     * ANYTHING else — bad shape or MAC, expired, another family's token,
     * another node's, a token without a `jti`, one already used, or (with the
     * node repository bound) one minted under a credential the node no longer
     * holds, including a token that names no generation at all. Never throws.
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
            if (this.nodes) {
                const node = await this.nodes.findById(nodeId);
                const current = fleetLinkCredentialGeneration(node?.enrollmentTokenHash ?? null);
                if (!node || typeof claims.cred !== 'string' || claims.cred !== current) {
                    return false;
                }
            }
            return await this.replay.claim(claims.jti, Math.max(1, claims.exp - Date.now()));
        } catch {
            // A guard that cannot answer must not let a token through twice.
            return false;
        }
    }
}
