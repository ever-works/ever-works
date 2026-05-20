import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Webhook signing-secret encryption helper.
 *
 * AES-256-GCM envelope encryption, mirroring `PluginSecretEncService`
 * but keyed on `PLATFORM_ENCRYPTION_KEY` so webhooks share the same
 * KMS surface as the rest of the platform's at-rest secrets.
 *
 * Storage shape: `enc::v1::base64(IV(12) || authTag(16) || ciphertext)`.
 * Legacy plaintext values (no prefix) are returned as-is from decrypt
 * — the read path treats them as plaintext until the next write
 * re-encrypts.
 *
 * Security notes:
 *  - The key MUST be 32 bytes. We accept hex (64 chars), base64 (44
 *    chars), or raw utf-8 (32 chars) and surface a clear error
 *    otherwise.
 *  - With no key set we passthrough — fine for dev / tests, never in
 *    production. The controller surface refuses to create a
 *    subscription when this happens in production (see WebhooksService).
 *  - The IV is random per-record so the same plaintext encrypts to a
 *    different ciphertext each call.
 */
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const ENVELOPE_PREFIX = 'enc::v1::';

@Injectable()
export class WebhookSecretService {
    private readonly logger = new Logger(WebhookSecretService.name);
    private cachedKey: Buffer | null = null;

    isEnabled(): boolean {
        return Boolean(this.tryGetKey());
    }

    /**
     * Generate a fresh webhook signing secret. Returns the raw secret
     * (caller must NOT log this) plus the encrypted envelope ready
     * for at-rest storage.
     *
     * The raw secret is base64url of 32 random bytes (~43 chars,
     * URL-safe). The webhook delivery worker computes HMAC-SHA256 of
     * the JSON payload using this secret and sends it as
     * `X-Ever-Works-Signature-256: sha256=<hex>`.
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
        if (!envelope || !envelope.startsWith(ENVELOPE_PREFIX)) {
            return envelope ?? '';
        }
        const key = this.tryGetKey();
        if (!key) {
            this.logger.warn(
                'Tried to decrypt webhook secret but PLATFORM_ENCRYPTION_KEY is not set',
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
            this.logger.error('Webhook secret decrypt failed', err as Error);
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
        // Try hex (64), base64 (44, with optional '='), then utf-8 (32).
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
