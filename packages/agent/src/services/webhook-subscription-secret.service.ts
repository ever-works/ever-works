import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope helper for the outbound webhook subscription
 * signing secret (the per-subscription HMAC key returned ONCE to the
 * customer on create / rotate, then encrypted at rest).
 *
 * Distinct from {@link WebhookSecretService} in this same `services/`
 * folder, which manages the per-Work GitHub-incoming `WEBHOOK_SECRET`
 * baked into a deployed site's runtime env. Different concern, different
 * lifecycle — and crucially, this one is needed by the Trigger.dev
 * webhook-delivery task that lives in `packages/tasks` (which cannot
 * import from `apps/api`), hence why the helper lives in `packages/agent`.
 *
 * Storage shape: `enc::v1::base64(IV(12) || authTag(16) || ciphertext)`,
 * matching what the `apps/api` controller has been writing since the
 * webhook subscriptions surface shipped (commit `60741b9d`). Legacy
 * plaintext values (no `enc::v1::` prefix) decrypt to themselves — that
 * keeps the dev / test path working when `PLATFORM_ENCRYPTION_KEY` is
 * unset.
 *
 * Security notes:
 *  - The key MUST be 32 bytes. Hex (64 chars), base64 (44), and raw utf-8
 *    (32) are all accepted; anything else is a clear error.
 *  - The IV is random per-record so the same plaintext encrypts to a
 *    different ciphertext each call.
 *  - We never log the decrypted secret. The webhook-delivery service
 *    receives the plaintext, signs the body with it, and discards it.
 */
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const ENVELOPE_PREFIX = 'enc::v1::';

@Injectable()
export class WebhookSubscriptionSecretService {
    private readonly logger = new Logger(WebhookSubscriptionSecretService.name);
    private cachedKey: Buffer | null = null;

    isEnabled(): boolean {
        return Boolean(this.tryGetKey());
    }

    /**
     * Generate a fresh subscription signing secret. The raw value goes
     * back to the customer ONCE; the encrypted envelope is what we
     * persist on `webhook_subscriptions.secretEncrypted`.
     */
    generateSecret(): { raw: string; encrypted: string } {
        const raw = randomBytes(32).toString('base64url');
        const encrypted = this.encrypt(raw);
        return { raw, encrypted };
    }

    encrypt(value: string): string {
        const key = this.tryGetKey();
        if (!key) {
            return value; // dev/test passthrough
        }
        const iv = randomBytes(IV_LENGTH_BYTES);
        const cipher = createCipheriv(ALGORITHM, key, iv);
        const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        const authTag = cipher.getAuthTag();
        const envelope = Buffer.concat([iv, authTag, ciphertext]).toString('base64');
        return `${ENVELOPE_PREFIX}${envelope}`;
    }

    decrypt(envelope: string): string {
        if (!envelope) return '';
        if (!envelope.startsWith(ENVELOPE_PREFIX)) {
            // Legacy plaintext value — return as-is so dev fixtures keep working.
            return envelope;
        }
        const key = this.tryGetKey();
        if (!key) {
            this.logger.warn(
                'Tried to decrypt webhook subscription secret but PLATFORM_ENCRYPTION_KEY is not set',
            );
            return '';
        }
        try {
            const buf = Buffer.from(envelope.slice(ENVELOPE_PREFIX.length), 'base64');
            const iv = buf.subarray(0, IV_LENGTH_BYTES);
            const authTag = buf.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
            const ciphertext = buf.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
            const decipher = createDecipheriv(ALGORITHM, key, iv);
            decipher.setAuthTag(authTag);
            const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            return plaintext.toString('utf8');
        } catch (err) {
            this.logger.error('Webhook subscription secret decrypt failed', err as Error);
            return '';
        }
    }

    private tryGetKey(): Buffer | null {
        if (this.cachedKey) return this.cachedKey;
        const raw = process.env.PLATFORM_ENCRYPTION_KEY;
        if (!raw) return null;
        const buf = this.decodeKey(raw);
        if (!buf) {
            this.logger.error(
                `PLATFORM_ENCRYPTION_KEY is set but not 32 bytes (got ${raw.length} chars)`,
            );
            return null;
        }
        this.cachedKey = buf;
        return buf;
    }

    private decodeKey(raw: string): Buffer | null {
        if (/^[0-9a-f]{64}$/i.test(raw)) {
            return Buffer.from(raw, 'hex');
        }
        if (/^[A-Za-z0-9+/]{43}=?$/.test(raw)) {
            const decoded = Buffer.from(raw, 'base64');
            if (decoded.length === KEY_LENGTH_BYTES) return decoded;
        }
        const utf = Buffer.from(raw, 'utf8');
        if (utf.length === KEY_LENGTH_BYTES) return utf;
        return null;
    }
}
