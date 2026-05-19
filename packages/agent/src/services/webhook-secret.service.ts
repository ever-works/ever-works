import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { config } from '../config';
import { WorkRepository } from '../database/repositories/work.repository';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const SECRET_LENGTH_BYTES = 32;

/**
 * Manages the per-Work `WEBHOOK_SECRET` baked into a deployed website's
 * runtime env by `DeployService.setRequiredSecrets`.
 *
 * The minimal template's `@ever-works/astro-integration` reads
 * `process.env.WEBHOOK_SECRET` at build time and registers an authenticated
 * `/api/webhook` endpoint that verifies incoming GitHub push notifications
 * via X-Hub-Signature-256. The classic template ignores the env var.
 *
 * **Why persistent**: rotating `WEBHOOK_SECRET` on every deploy would
 * silently invalidate the GitHub-side webhook registration (which is
 * configured with the OLD secret) — every incoming payload would fail
 * verification until the workflow round-tripped the GH Webhooks API to
 * update the registered secret. Treating it as a stable per-Work value
 * mirrors how `PlatformSyncSecretService` handles the EW-120 pull-mode
 * HMAC secret: lazily provisioned on first deploy, encrypted-at-rest with
 * `PLATFORM_ENCRYPTION_KEY`, and only regenerated when explicitly rotated.
 *
 * Bootstrap is lazy: `getOrGenerate` is called by `DeployService` on every
 * deploy. First deploy generates and persists; subsequent deploys read the
 * existing value back. Concurrent deploys are race-safe via the conditional
 * UPDATE in `WorkRepository.setWebhookSecretIfNull` — losers re-read.
 *
 * Rotation: `rotate()` writes a fresh secret unconditionally. The deployed
 * site only learns the new value at the next deploy; admin UX should warn
 * the operator that BOTH a redeploy AND a GitHub-side webhook-secret
 * update are required.
 */
@Injectable()
export class WebhookSecretService {
    private readonly logger = new Logger(WebhookSecretService.name);
    private cachedKey: Buffer | null = null;

    constructor(private readonly workRepository: WorkRepository) {}

    /**
     * Lazily provision the per-Work webhook secret. Returns the plaintext hex.
     *
     * Concurrency: two simultaneous calls for the same Work both generate a
     * fresh value, but only one wins the conditional UPDATE; the loser
     * re-reads and returns the persisted value.
     */
    async getOrGenerate(workId: string): Promise<string> {
        const existing = await this.workRepository.findById(workId);
        if (!existing) {
            throw new Error(`Work not found: ${workId}`);
        }
        if (existing.webhookSecretEncrypted) {
            return this.decrypt(existing.webhookSecretEncrypted);
        }
        const plaintext = randomBytes(SECRET_LENGTH_BYTES).toString('hex');
        const encrypted = this.encrypt(plaintext);
        const won = await this.workRepository.setWebhookSecretIfNull(workId, encrypted);
        if (won) {
            return plaintext;
        }
        // Lost the race — another deploy generated it first. Read back.
        const reread = await this.workRepository.findById(workId);
        if (!reread?.webhookSecretEncrypted) {
            throw new Error(
                `Webhook secret bootstrap race lost but no value found for work ${workId}`,
            );
        }
        return this.decrypt(reread.webhookSecretEncrypted);
    }

    /**
     * Rotate the per-Work webhook secret unconditionally. Returns the new
     * plaintext. The next deploy carries the new value to the site's
     * runtime env; until the operator also updates the GitHub-side webhook
     * registration with the new secret, incoming payloads will fail
     * X-Hub-Signature-256 verification. Admin UX must call this out.
     */
    async rotate(workId: string): Promise<string> {
        const existing = await this.workRepository.findById(workId);
        if (!existing) {
            throw new Error(`Work not found: ${workId}`);
        }
        const plaintext = randomBytes(SECRET_LENGTH_BYTES).toString('hex');
        const encrypted = this.encrypt(plaintext);
        await this.workRepository.update(workId, { webhookSecretEncrypted: encrypted });
        this.logger.log(
            `Rotated webhook secret for work ${workId} — redeploy AND GitHub-side webhook update required`,
        );
        return plaintext;
    }

    private getKey(): Buffer {
        if (this.cachedKey) {
            return this.cachedKey;
        }
        const hex = config.platformSync.getEncryptionKey();
        if (!hex) {
            throw new Error(
                'PLATFORM_ENCRYPTION_KEY is not set. Required for encrypting per-Work webhook_secret.',
            );
        }
        if (!/^[0-9a-fA-F]+$/.test(hex)) {
            throw new Error('PLATFORM_ENCRYPTION_KEY must be a hex string.');
        }
        const key = Buffer.from(hex, 'hex');
        if (key.length !== KEY_LENGTH_BYTES) {
            throw new Error(
                `PLATFORM_ENCRYPTION_KEY must decode to ${KEY_LENGTH_BYTES} bytes (got ${key.length}).`,
            );
        }
        this.cachedKey = key;
        return key;
    }

    private encrypt(plaintext: string): string {
        const key = this.getKey();
        const iv = randomBytes(IV_LENGTH_BYTES);
        const cipher = createCipheriv(ALGORITHM, key, iv);
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const authTag = cipher.getAuthTag();
        return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
    }

    private decrypt(envelope: string): string {
        const key = this.getKey();
        const buf = Buffer.from(envelope, 'base64');
        if (buf.length < IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES + 1) {
            throw new Error('webhook_secret envelope is malformed (too short).');
        }
        const iv = buf.subarray(0, IV_LENGTH_BYTES);
        const authTag = buf.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
        const ciphertext = buf.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        try {
            return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        } catch (err) {
            this.logger.error('Failed to decrypt webhook_secret', err);
            throw new Error('webhook_secret decryption failed (auth tag mismatch).');
        }
    }
}
