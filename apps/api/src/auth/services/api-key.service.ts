import { Injectable, BadRequestException } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { ApiKeyRepository } from '@ever-works/agent/database';

const API_KEY_PREFIX = 'ew_live_';
const MAX_KEYS_PER_USER = 10;

/**
 * Issuance + verification for `ew_live_…` API keys.
 *
 * **Storage model.** Keys are hashed (SHA-256) at issue-time and the
 * plaintext is returned to the caller **once** in the `createKey`
 * response — there is no way to recover it later. UI/CLI surfaces
 * must impress this on the user; a lost key has to be revoked and
 * re-issued, never "retrieved".
 *
 * **`prefix` is a non-secret fingerprint.** We store the first 12
 * characters (`ew_live_` + 4 hex chars) so users can identify keys
 * in their dashboard without seeing the secret. 4 hex chars = 16
 * bits, which is plenty of disambiguation entropy and adds nothing
 * useful to a brute-force attacker against the remaining 240 bits.
 *
 * **`MAX_KEYS_PER_USER` counts ALL rows, including expired ones.**
 * `countByUserId` does not filter on `expiresAt`, so a user who lets
 * 10 keys expire and never revokes them cannot create an 11th
 * without first deleting one. This is intentional (keeps the cap
 * predictable and forces hygiene) but operators occasionally hit
 * surprise "limit reached" errors with only expired keys. Document
 * "revoke expired keys to free a slot" in user-facing help.
 *
 * **Expired keys are not auto-purged.** {@link validateKey} returns
 * `null` for expired rows but leaves them in the database. A periodic
 * cleanup job (or a TypeORM cron-style task) is the long-term answer;
 * for now they're harmless except for the cap above.
 *
 * **`validateKey` does a DB lookup on the SHA-256 digest**, not a
 * string compare on the raw key — so byte-by-byte timing attacks
 * against the secret aren't applicable here. The remaining timing
 * signal is "row exists vs doesn't"; for 256-bit random keys that
 * leak doesn't help an attacker.
 *
 * **`updateLastUsed` is fire-and-forget.** Errors are swallowed; if
 * the DB write fails, `lastUsedAt` silently stops advancing. Keep
 * that in mind when debugging "stale last-used timestamp" reports
 * — check API server logs around the same window.
 */
@Injectable()
export class ApiKeyService {
    constructor(private readonly apiKeyRepository: ApiKeyRepository) {}

    async createKey(userId: string, name: string, expiresAt?: string) {
        const count = await this.apiKeyRepository.countByUserId(userId);
        if (count >= MAX_KEYS_PER_USER) {
            throw new BadRequestException(
                `Maximum of ${MAX_KEYS_PER_USER} API keys allowed per user`,
            );
        }

        if (expiresAt && new Date(expiresAt) <= new Date()) {
            throw new BadRequestException('Expiration date must be in the future');
        }

        const rawBytes = randomBytes(32);
        const rawKey = API_KEY_PREFIX + rawBytes.toString('hex');
        const hashedKey = createHash('sha256').update(rawKey).digest('hex');
        const prefix = rawKey.substring(0, 12);

        const apiKey = await this.apiKeyRepository.create({
            userId,
            name,
            hashedKey,
            prefix,
            expiresAt: expiresAt ? new Date(expiresAt) : null,
        });

        return {
            id: apiKey.id,
            name: apiKey.name,
            key: rawKey,
            prefix: apiKey.prefix,
            expiresAt: apiKey.expiresAt,
            createdAt: apiKey.createdAt,
        };
    }

    async listKeys(userId: string) {
        return this.apiKeyRepository.findByUserId(userId);
    }

    async revokeKey(id: string, userId: string): Promise<boolean> {
        return this.apiKeyRepository.deleteByIdAndUserId(id, userId);
    }

    async validateKey(rawKey: string) {
        const hashedKey = createHash('sha256').update(rawKey).digest('hex');
        const apiKey = await this.apiKeyRepository.findByHashedKey(hashedKey);

        if (!apiKey) {
            return null;
        }

        if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
            return null;
        }

        // Fire-and-forget lastUsedAt update
        this.apiKeyRepository.updateLastUsed(apiKey.id).catch(() => {});

        return apiKey;
    }
}
