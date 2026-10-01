import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, In, LessThan, Like, MoreThan, QueryFailedError } from 'typeorm';
import { AuthVerification } from '@ever-works/agent/entities';

/**
 * The single-use namespaces the Ever ID flow keeps (APW-12 plan §3.3).
 *
 * - `txn` — a sign-in transaction's `state`: a callback completes at most once
 *   (FR-19, S21, ACC-12-09).
 * - `pending` — a pending sign-up / account-exists / connect value (FR-23, FR-26).
 * - `logout-jti` — a back-channel logout token's `jti`, 600 s (FR-33, ACC-12-24).
 * - `session-jti` — a device-exchange access token's `jti`, 600 s (FR-40, ACC-12-29).
 */
export type EverIdReplayKind = 'txn' | 'pending' | 'logout-jti' | 'session-jti';

/** How long the "signed out by Ever ID" marker outlives the session it ended (plan §5.4). */
export const EVER_ID_SIGNED_OUT_MARKER_TTL_SECONDS = 300;

/** At most this many expired rows are removed per insert (plan §3.3). */
const CLEANUP_BATCH = 100;
const IDENTIFIER_PREFIX = 'ever-id:';
const SIGNED_OUT_IDENTIFIER = `${IDENTIFIER_PREFIX}signedOut`;

/**
 * APW-12 (Ever ID) — replay protection and the "signed out by Ever ID" marker,
 * both on the EXISTING `verification` table (plan §3.3, §5.4). No new table.
 *
 * A row is `{ identifier: 'ever-id:<kind>', value: sha256('<kind>|' + key) }`.
 * The unique index on `value` is what makes every value single-use across
 * replicas: of two concurrent inserts of the same value exactly one wins
 * (NFR-7). Only digests are stored — never a `state`, a `jti` or a token.
 *
 * Expired rows are swept opportunistically, at most 100 per insert, in TWO
 * statements (select the ids, then delete them): the platform supports
 * Postgres, SQLite, MySQL and MariaDB, and the last two reject both `LIMIT`
 * inside an `IN` subquery and a subquery over the table being deleted from.
 */
@Injectable()
export class EverIdReplayService {
    private readonly logger = new Logger(EverIdReplayService.name);

    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /**
     * Use `key` once in `kind`'s namespace for `ttlSeconds`. `true` for the first
     * use, `false` for every later one (including a concurrent second consumer).
     */
    async consumeOnce(kind: EverIdReplayKind, key: string, ttlSeconds: number): Promise<boolean> {
        await this.sweepExpired();
        try {
            await this.repository().insert({
                id: randomUUID(),
                identifier: `${IDENTIFIER_PREFIX}${kind}`,
                value: digest(kind, key),
                expiresAt: new Date(Date.now() + ttlSeconds * 1000),
            });
            return true;
        } catch (error) {
            if (error instanceof QueryFailedError) return false;
            throw error;
        }
    }

    /**
     * Whether `key` was already used in `kind`'s namespace and is still inside its
     * window. Read-only — it never records a use.
     */
    async wasUsed(kind: EverIdReplayKind, key: string): Promise<boolean> {
        return this.repository().exists({
            where: { value: digest(kind, key), expiresAt: MoreThan(new Date()) },
        });
    }

    /**
     * Mark sessions as "ended by an Ever ID sign-out notice", keyed by their
     * stored `tokenHash`, so the next request with that bearer is answered
     * `401 everIdSignedOut` instead of a plain 401 (S6, plan §5.4). The marker
     * holds a digest of the hash only and expires after 300 s.
     */
    async markSignedOut(tokenHashes: readonly string[]): Promise<void> {
        const unique = [...new Set(tokenHashes.filter((hash) => typeof hash === 'string' && hash))];
        for (const tokenHash of unique) {
            try {
                await this.repository().insert({
                    id: randomUUID(),
                    identifier: SIGNED_OUT_IDENTIFIER,
                    value: digest('signedOut', tokenHash),
                    expiresAt: new Date(Date.now() + EVER_ID_SIGNED_OUT_MARKER_TTL_SECONDS * 1000),
                });
            } catch (error) {
                // Already marked (a second notice for the same session) — fine.
                if (!(error instanceof QueryFailedError)) throw error;
            }
        }
    }

    /** Whether the session with this stored `tokenHash` was ended by a sign-out notice. */
    async isSignedOut(tokenHash: string): Promise<boolean> {
        if (!tokenHash) return false;
        return this.repository().exists({
            where: {
                identifier: SIGNED_OUT_IDENTIFIER,
                value: digest('signedOut', tokenHash),
                expiresAt: MoreThan(new Date()),
            },
        });
    }

    private async sweepExpired(): Promise<void> {
        try {
            const expired = await this.repository().find({
                select: { id: true },
                where: {
                    identifier: Like(`${IDENTIFIER_PREFIX}%`),
                    expiresAt: LessThan(new Date()),
                },
                order: { expiresAt: 'ASC' },
                take: CLEANUP_BATCH,
            });
            if (expired.length === 0) return;
            await this.repository().delete({ id: In(expired.map((row) => row.id)) });
        } catch (error) {
            // Housekeeping only: a failed sweep must never fail a sign-in.
            this.logger.debug(
                `Ever ID replay sweep skipped: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private repository() {
        return this.dataSource.getRepository(AuthVerification);
    }
}

function digest(kind: string, key: string): string {
    return createHash('sha256').update(`${kind}|${key}`, 'utf8').digest('hex');
}
