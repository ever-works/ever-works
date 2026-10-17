import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IntegrationIdempotencyKey } from '../entities/integration-idempotency-key.entity';
import { isUniqueConstraintError } from '../utils/db-error.utils';
import { IdempotencyConflictError } from './integration-api.errors';

/** How long a stored response is replayed (contract v1 B.1: 24 h). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A claim still `in_progress` after this long belongs to a request that died
 * (process stopped, or its final write failed): the key is free again.
 */
export const IDEMPOTENCY_STALE_CLAIM_MS = 5 * 60 * 1000;

/** `Idempotency-Key` is at most 128 characters (contract v1 B.1). */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** A response to send (fresh or replayed). */
export interface IdempotentResponse {
    readonly status: number;
    readonly body: unknown;
    /** True when this is the stored response of an earlier request. */
    readonly replayed: boolean;
}

/** sha256 hex of `METHOD path\nbody` — the "same request" test of a repeated key. */
export function idempotencyRequestHash(method: string, path: string, body: unknown): string {
    const canonical = body === undefined || body === null ? '' : JSON.stringify(body);
    return createHash('sha256')
        .update(`${method.toUpperCase()} ${path}\n${canonical}`, 'utf8')
        .digest('hex');
}

/**
 * The `Idempotency-Key` store (EW-P1-4, contract v1 B.1): a create sent twice
 * with the same key by the same integration key within 24 h runs once; the
 * repeat gets the stored response, marked `replayed`.
 *
 * - The key is claimed BEFORE the work runs (unique `(integrationKeyId,
 *   idempotencyKey)`), so two racing retries cannot both create: the loser gets
 *   {@link IdempotencyConflictError} (`in_progress`).
 * - The same key with a different request is refused (`request_mismatch`).
 * - A request that fails (throws) releases the key, so a retry can succeed.
 *   Only responses below 500 are stored; a 5xx releases it too.
 * - Expired rows are replaced on first use and purged by {@link purgeExpired}.
 */
@Injectable()
export class IntegrationIdempotencyService {
    private readonly logger = new Logger(IntegrationIdempotencyService.name);

    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    private get repo() {
        return this.dataSource.getRepository(IntegrationIdempotencyKey);
    }

    /**
     * Run `work` once per `(integrationKeyId, idempotencyKey)`. `work` answers
     * the status and body to send; a replay answers the stored ones.
     */
    async run(
        input: {
            readonly integrationKeyId: string;
            readonly idempotencyKey: string;
            readonly requestHash: string;
            readonly now?: Date;
        },
        work: () => Promise<{ status: number; body: unknown }>,
    ): Promise<IdempotentResponse> {
        const now = input.now ?? new Date();
        const claim = await this.claim(
            input.integrationKeyId,
            input.idempotencyKey,
            input.requestHash,
            now,
        );
        if (claim.kind === 'replay') {
            return { status: claim.status, body: claim.body, replayed: true };
        }
        let result: { status: number; body: unknown };
        try {
            result = await work();
        } catch (error) {
            await this.release(claim.id);
            throw error;
        }
        if (result.status >= 500) {
            await this.release(claim.id);
            return { ...result, replayed: false };
        }
        await this.complete(claim.id, result);
        return { ...result, replayed: false };
    }

    /** Delete rows past their replay window. Returns how many were removed. */
    async purgeExpired(now: Date = new Date()): Promise<number> {
        // `expiresAt` is epoch ms behind a transformer, which a find operator
        // would bypass: compare the raw column.
        const escape = (name: string) => this.dataSource.driver.escape(name);
        const result = await this.repo
            .createQueryBuilder()
            .delete()
            .where(`${escape('expiresAt')} < :now`, { now: now.getTime() })
            .execute();
        return result.affected ?? 0;
    }

    private async claim(
        integrationKeyId: string,
        idempotencyKey: string,
        requestHash: string,
        now: Date,
    ): Promise<{ kind: 'new'; id: string } | { kind: 'replay'; status: number; body: unknown }> {
        for (let attempt = 0; attempt < 2; attempt++) {
            const existing = await this.repo.findOne({
                where: { integrationKeyId, idempotencyKey },
            });
            if (existing) {
                if (existing.expiresAt.getTime() <= now.getTime()) {
                    // Past its window: forget it and claim afresh.
                    await this.repo.delete({ id: existing.id });
                    continue;
                }
                if (existing.requestHash !== requestHash) {
                    throw new IdempotencyConflictError('request_mismatch');
                }
                if (existing.state !== 'completed') {
                    const age = now.getTime() - new Date(existing.createdAt).getTime();
                    if (age > IDEMPOTENCY_STALE_CLAIM_MS) {
                        // The first request died without settling its claim.
                        await this.repo.delete({ id: existing.id });
                        continue;
                    }
                    throw new IdempotencyConflictError('in_progress');
                }
                return {
                    kind: 'replay',
                    status: existing.responseStatus ?? 200,
                    body: existing.responseBody ? JSON.parse(existing.responseBody) : null,
                };
            }
            try {
                const row = await this.repo.save(
                    this.repo.create({
                        integrationKeyId,
                        idempotencyKey,
                        requestHash,
                        state: 'in_progress',
                        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
                    }),
                );
                return { kind: 'new', id: row.id };
            } catch (error) {
                // A concurrent request claimed it first: read what it stored.
                if (!isUniqueConstraintError(error)) throw error;
            }
        }
        throw new IdempotencyConflictError('in_progress');
    }

    /**
     * Store the response for replay. The work already succeeded, so a failed
     * write must not fail the request: retry once, then leave the claim — it
     * becomes free again after {@link IDEMPOTENCY_STALE_CLAIM_MS} instead of
     * blocking retries for the whole 24 h window.
     */
    private async complete(id: string, result: { status: number; body: unknown }): Promise<void> {
        const patch = {
            state: 'completed' as const,
            responseStatus: result.status,
            responseBody: JSON.stringify(result.body ?? null),
        };
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await this.repo.update({ id }, patch);
                return;
            } catch (error) {
                if (attempt === 1) {
                    this.logger.warn(
                        `Could not store an Idempotency-Key response (the key frees up after ${IDEMPOTENCY_STALE_CLAIM_MS / 60000} min): ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }
            }
        }
    }

    private async release(id: string): Promise<void> {
        await this.repo.delete({ id }).catch((error) => {
            this.logger.warn(
                `Could not release an Idempotency-Key claim: ${error instanceof Error ? error.message : String(error)}`,
            );
        });
    }
}
