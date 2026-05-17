import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * C-08 — AES-256-GCM envelope encryption for plugin `secretSettings`.
 *
 * Mirrors the proven `PlatformSyncSecretService` pattern: random 12-byte IV
 * per record, 16-byte GCM auth tag, key sourced from
 * `PLUGIN_SECRET_ENCRYPTION_KEY` (32-byte hex). When the key isn't set, the
 * service falls back to passthrough — useful for dev / preview / tests
 * that don't want to manage a key. **The key is REQUIRED in production**
 * (enforced by `assertKeyAvailableInProd` at boot in production builds).
 *
 * Storage shape (base64 of `IV || auth_tag || ciphertext`) is fronted by a
 * stable prefix `enc::v1::` so a reader can distinguish encrypted records
 * from legacy plaintext rows. **Migration strategy (Q-5(a)):** when a value
 * is read, if it lacks the prefix it's treated as plaintext and decrypted
 * trivially; the *next write* re-encrypts. Eventually the operator can run
 * the one-shot migration in this same directory to back-fill any rows that
 * never got written after the cutover.
 */
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const ENVELOPE_PREFIX = 'enc::v1::';

@Injectable()
export class PluginSecretEncService {
    private readonly logger = new Logger(PluginSecretEncService.name);
    private cachedKey: Buffer | null = null;
    private warnedAboutMissingKey = false;

    /** True if `PLUGIN_SECRET_ENCRYPTION_KEY` is configured at boot. */
    isEnabled(): boolean {
        return Boolean(this.tryGetKey());
    }

    /**
     * Validation hook — call at boot in production builds. Throws if the
     * key is missing in production so the service fails fast instead of
     * silently degrading to plaintext.
     */
    assertKeyAvailableInProd(): void {
        if (process.env.NODE_ENV === 'production' && !this.tryGetKey()) {
            throw new Error(
                'PLUGIN_SECRET_ENCRYPTION_KEY is required in production for at-rest encryption of plugin secret settings. ' +
                    'Generate with: `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"` and add to the deployment env.',
            );
        }
    }

    /**
     * Encrypt a single secret-setting value. Returns the same value
     * unchanged when no key is configured (dev/preview convenience).
     * Non-string inputs (numbers, booleans, objects) are JSON-stringified
     * first — the caller is expected to re-parse on read.
     */
    encryptValue(value: unknown): string {
        const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
        const key = this.tryGetKey();
        if (!key) {
            return plaintext;
        }
        const iv = randomBytes(IV_LENGTH_BYTES);
        const cipher = createCipheriv(ALGORITHM, key, iv);
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const authTag = cipher.getAuthTag();
        const envelope = Buffer.concat([iv, authTag, ciphertext]).toString('base64');
        return `${ENVELOPE_PREFIX}${envelope}`;
    }

    /**
     * Decrypt a single envelope. Returns the input unchanged when:
     *   - it lacks the prefix (legacy plaintext — will get re-encrypted on
     *     next write).
     *   - no key is configured.
     *   - decryption fails (logs + returns the raw envelope so the caller
     *     can decide whether to surface an error).
     */
    decryptValue(envelope: string): string {
        if (typeof envelope !== 'string' || !envelope.startsWith(ENVELOPE_PREFIX)) {
            return envelope;
        }
        const key = this.tryGetKey();
        if (!key) {
            // Encrypted record but no key configured — the operator dropped
            // the env var. Loud failure: surfacing the envelope as-is would
            // leak ciphertext into the rendered settings UI. Better to
            // throw and force ops to fix.
            throw new Error(
                'PLUGIN_SECRET_ENCRYPTION_KEY is missing but encrypted secrets are present. ' +
                    'Restore the key or run a decrypt-and-re-store migration before clearing it.',
            );
        }
        const buf = Buffer.from(envelope.slice(ENVELOPE_PREFIX.length), 'base64');
        if (buf.length < IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES + 1) {
            this.logger.warn('Malformed plugin-secret envelope — too short');
            return envelope;
        }
        const iv = buf.subarray(0, IV_LENGTH_BYTES);
        const authTag = buf.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
        const ciphertext = buf.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        try {
            return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        } catch (err) {
            this.logger.error('Plugin-secret decrypt failed (auth tag mismatch)', err);
            throw new Error('Plugin secret decryption failed (auth tag mismatch).');
        }
    }

    /**
     * Bulk-encrypt every value in a `secretSettings` JSON blob. Mutates
     * a copy; the input is not modified. Returns a record whose values
     * are all envelope-encrypted (or plaintext if no key configured).
     */
    encryptRecord(record: Record<string, unknown> | null | undefined): Record<string, string> {
        if (!record) return {};
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(record)) {
            if (v === null || v === undefined || v === '') {
                continue;
            }
            out[k] = this.encryptValue(v);
        }
        return out;
    }

    /**
     * Bulk-decrypt a `secretSettings` JSON blob. Values that lack the
     * envelope prefix are returned unchanged (legacy plaintext rows).
     */
    decryptRecord(record: Record<string, unknown> | null | undefined): Record<string, string> {
        if (!record) return {};
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(record)) {
            if (v === null || v === undefined) continue;
            if (typeof v !== 'string') {
                out[k] = String(v);
                continue;
            }
            out[k] = this.decryptValue(v);
        }
        return out;
    }

    private tryGetKey(): Buffer | null {
        if (this.cachedKey) return this.cachedKey;
        const hex = process.env.PLUGIN_SECRET_ENCRYPTION_KEY?.trim();
        if (!hex) {
            if (!this.warnedAboutMissingKey && process.env.NODE_ENV !== 'test') {
                this.logger.warn(
                    'PLUGIN_SECRET_ENCRYPTION_KEY is not configured — plugin secret settings will be stored as plaintext. Set this env var in production deploys.',
                );
                this.warnedAboutMissingKey = true;
            }
            return null;
        }
        if (!/^[0-9a-fA-F]+$/.test(hex)) {
            throw new Error('PLUGIN_SECRET_ENCRYPTION_KEY must be a hex string.');
        }
        const key = Buffer.from(hex, 'hex');
        if (key.length !== KEY_LENGTH_BYTES) {
            throw new Error(
                `PLUGIN_SECRET_ENCRYPTION_KEY must decode to ${KEY_LENGTH_BYTES} bytes (got ${key.length}).`,
            );
        }
        this.cachedKey = key;
        return key;
    }
}
