import {
    Injectable,
    BadRequestException,
    ConflictException,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import {
    ApiKeyRepository,
    OrganizationMemberRepository,
    TenantRepository,
} from '@ever-works/agent/database';
import type { ApiKey } from '@ever-works/agent/entities';
import {
    API_KEY_ROTATION_DEFAULT_GRACE_HOURS,
    API_KEY_ROTATION_MAX_GRACE_HOURS,
    INTEGRATION_API_KEY_KIND,
    INTEGRATION_KEY_PREFIX,
    PERSONAL_API_KEY_KIND,
    type RotateApiKeyResponse,
} from '@ever-works/contracts';

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
 * **`MAX_KEYS_PER_USER` counts only active (non-expired) rows.**
 * `countByUserId` filters with `(expiresAt IS NULL) OR (expiresAt > NOW())`,
 * so expired keys do NOT consume a slot — a user may create a new key
 * even after letting previous keys expire, provided the active count is
 * below the cap. Revoking (deleting) an active key frees a slot immediately.
 * // Security: corrected misleading comment that claimed expired keys counted
 * // toward the cap; the repository already excludes them, so a future
 * // maintainer will not incorrectly "fix" countByUserId to include all rows.
 *
 * **Expired keys are not auto-purged.** {@link validateKey} returns
 * `null` for expired rows but leaves them in the database. A periodic
 * cleanup job (or a TypeORM cron-style task) is the long-term answer;
 * for now they're harmless (they do not count toward the cap).
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
    private readonly logger = new Logger(ApiKeyService.name);

    constructor(
        private readonly apiKeyRepository: ApiKeyRepository,
        // EW-P2-6 — an integration key created by an Organization admin may act only
        // in the Organizations its creator still administers. Both @Optional(): a
        // graph without them (unit tests) keeps the stored pins, as before.
        @Optional() private readonly tenants?: TenantRepository,
        @Optional() private readonly members?: OrganizationMemberRepository,
    ) {}

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
        const apiKey = await this.findLiveByRawKey(rawKey);

        if (!apiKey) {
            return null;
        }

        // Self-build slice Z (EW-796) — PERSONAL keys only.
        //
        // `api_keys` now holds two kinds of row. A `fleet-run` row is a
        // short-lived credential minted for a model on someone's desktop,
        // and it is only safe because `FleetRunCredentialService.authenticate`
        // gates it on a route allowlist, on the bound job still being held
        // by the bound node, and on an Organization pin the scope guard
        // enforces. THIS method applies none of those checks, so it must
        // never accept such a row — otherwise any caller that reaches
        // `validateKey` (the `ew_live_` guard branch, and the @Public()
        // uploads controller, which forwards ANY `x-api-key` value it is
        // handed) would authenticate a run token as the plain owner with
        // the whole API surface open to it.
        //
        // Discriminating on the stored `kind` rather than on the raw
        // prefix is deliberate: the row is the fact, the prefix is only a
        // routing hint, and a future kind is refused here by default.
        if (apiKey.kind !== PERSONAL_API_KEY_KIND) {
            return null;
        }

        if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
            return null;
        }

        // Fire-and-forget lastUsedAt update
        this.apiKeyRepository.updateLastUsed(apiKey.id).catch(() => {});

        return apiKey;
    }

    // ── EW-P1-2 — integration keys and in-place rotation ────────────────

    /**
     * Validate an `ew_int_…` integration key. Same digest lookup and the same
     * rotation grace as {@link validateKey}, but the inverse kind gate: ONLY
     * `kind = 'integration'` rows answer, so an integration secret can never
     * be accepted as a personal key and vice versa. Pins and scopes are NOT
     * checked here — `AuthSessionGuard` builds the principal from the row and
     * `IntegrationPrincipalGuard` enforces them per request.
     */
    async validateIntegrationKey(rawKey: string): Promise<ApiKey | null> {
        if (!rawKey.startsWith(INTEGRATION_KEY_PREFIX)) return null;
        const apiKey = await this.findLiveByRawKey(rawKey);
        if (!apiKey || apiKey.kind !== INTEGRATION_API_KEY_KIND) return null;
        if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null;
        if (!Array.isArray(apiKey.organizationIds) || apiKey.organizationIds.length === 0) {
            // A key with no pin cannot act anywhere; refuse rather than guess.
            return null;
        }
        this.apiKeyRepository.updateLastUsed(apiKey.id).catch(() => {});
        // EW-P2-6 — the principal is built from these pins: narrow them to what the
        // creator may use NOW (a copy when narrowed; the stored row is untouched).
        const usable = await this.effectivePins(apiKey);
        // A demoted (or removed) admin's key keeps no pin: like a key with no pin, it
        // cannot act anywhere, so it does not authenticate at all.
        if (usable.length === 0) return null;
        if (usable.length === apiKey.organizationIds.length) return apiKey;
        return { ...apiKey, organizationIds: usable } as ApiKey;
    }

    /**
     * EW-P2-6 — the pins an integration key may use right now: all of them when its
     * creator owns the Tenant; otherwise only the ones the creator still administers
     * (roster role `admin`), so demoting or removing an admin takes their keys' pins
     * away at once. Fails closed for a non-owner (a lookup error = no pins). Without
     * the repositories (unit tests) the stored pins, as before.
     */
    async effectivePins(
        key: Pick<ApiKey, 'userId' | 'tenantId' | 'organizationIds'>,
    ): Promise<string[]> {
        const pins = Array.isArray(key.organizationIds) ? [...key.organizationIds] : [];
        if (!this.tenants) return pins;
        if (!key.tenantId) return [];
        try {
            const tenant = await this.tenants.findById(key.tenantId);
            if (tenant?.ownerUserId === key.userId) return pins;
            if (!this.members) return [];
            const administered = new Set(
                await this.members.listAdministeredOrganizationIds(key.userId, key.tenantId),
            );
            return pins.filter((id) => administered.has(id));
        } catch (error) {
            this.logger.warn(
                `Integration key ${String((key as { id?: string }).id ?? '')} pins: ${String(error)}`,
            );
            return [];
        }
    }

    /**
     * Rotate a key IN PLACE (`POST /api/auth/api-keys/:id/rotate`, session
     * only): a fresh secret replaces `hashedKey`, and the previous digest is
     * kept in `previousHashedKey`, accepted until `previousKeyGraceUntil`
     * (default 24 h, `graceHours` 0..168). The row keeps its id, so whatever
     * points at the key — webhook subscriptions, audit rows, an integration's
     * stored key id — stays valid, and the integration swaps secrets with no
     * downtime. A second rotation inside the grace window retires the oldest
     * secret immediately: at most two secrets are live for one key.
     *
     * Personal (`ew_live_`) and integration (`ew_int_`) keys rotate; fleet-run
     * tokens are re-minted by the fleet, never rotated by hand (404).
     */
    async rotateKey(
        id: string,
        userId: string,
        graceHours: number = API_KEY_ROTATION_DEFAULT_GRACE_HOURS,
    ): Promise<RotateApiKeyResponse & { kind: string }> {
        if (
            !Number.isFinite(graceHours) ||
            graceHours < 0 ||
            graceHours > API_KEY_ROTATION_MAX_GRACE_HOURS
        ) {
            throw new BadRequestException(
                `graceHours must be between 0 and ${API_KEY_ROTATION_MAX_GRACE_HOURS}.`,
            );
        }
        const apiKey = await this.apiKeyRepository.findByIdAndUserId(id, userId);
        if (
            !apiKey ||
            !apiKey.isActive ||
            (apiKey.kind !== PERSONAL_API_KEY_KIND && apiKey.kind !== INTEGRATION_API_KEY_KIND)
        ) {
            throw new NotFoundException('API key not found');
        }
        if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
            throw new BadRequestException(
                'An expired API key cannot be rotated; create a new one.',
            );
        }

        const prefix =
            apiKey.kind === INTEGRATION_API_KEY_KIND ? INTEGRATION_KEY_PREFIX : API_KEY_PREFIX;
        const rawKey = prefix + randomBytes(32).toString('hex');
        const now = new Date();
        const previousKeyGraceUntil = new Date(now.getTime() + graceHours * 3_600_000);
        const applied = await this.apiKeyRepository.applyRotation(apiKey.id, apiKey.hashedKey, {
            hashedKey: sha256(rawKey),
            prefix: rawKey.substring(0, 12),
            previousHashedKey: apiKey.hashedKey,
            previousKeyGraceUntil,
            rotatedAt: now,
        });
        if (!applied) {
            // Another rotation (or a revoke) landed between our read and write.
            // Never hand out a secret that is not the one stored.
            throw new ConflictException('The API key was changed by another request; try again.');
        }

        return {
            id: apiKey.id,
            name: apiKey.name,
            kind: apiKey.kind,
            key: rawKey,
            prefix: rawKey.substring(0, 12),
            rotatedAt: now.toISOString(),
            previousKeyGraceUntil: previousKeyGraceUntil.toISOString(),
        };
    }

    /**
     * The active row a raw secret belongs to: its current secret, or — within
     * the rotation grace period — its previous one. Kind is NOT checked here.
     */
    private async findLiveByRawKey(rawKey: string): Promise<ApiKey | null> {
        const hashedKey = sha256(rawKey);
        const current = await this.apiKeyRepository.findByHashedKey(hashedKey);
        if (current) return current;
        const rotated = await this.apiKeyRepository.findByPreviousHashedKey(hashedKey);
        if (
            rotated?.previousKeyGraceUntil &&
            new Date(rotated.previousKeyGraceUntil).getTime() > Date.now()
        ) {
            return rotated;
        }
        return null;
    }
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}
