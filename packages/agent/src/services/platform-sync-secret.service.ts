import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { config } from '../config';
import { WorkRepository } from '../database/repositories/work.repository';
import { Work } from '../entities';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const SECRET_LENGTH_BYTES = 32;

/**
 * Manages the per-Work `PLATFORM_SYNC_SECRET` used by the EW-120 Activity
 * Feed pull transport.
 *
 * Each pull-mode Work has its own 32-byte random secret, stored
 * AES-256-GCM-encrypted on `works.platformSyncSecretEncrypted` with the
 * platform-side `PLATFORM_ENCRYPTION_KEY`. The plaintext is pushed into
 * the deployed site's runtime env via the existing GHA-secret push path
 * (`DeployService.setRequiredSecrets`); the platform's
 * `DirectoryWebsiteClient` decrypts on every outbound fetch to sign the
 * request, and the site verifies against the env value.
 *
 * Bootstrap is lazy: `getOrGenerate` is called by `DeployService` on each
 * deploy for pull-mode Works (no-op for push/disabled). First deploy
 * generates and persists; subsequent deploys read the existing value.
 * Concurrent deploys are idempotent via the conditional UPDATE in
 * `WorkRepository.setPlatformSyncSecretIfNull` — losers re-read.
 *
 * Rotation: `rotate()` writes a fresh secret unconditionally. The deployed
 * site only learns the new value at the next deploy; admin UX should warn
 * the operator that a redeploy is required.
 */
@Injectable()
export class PlatformSyncSecretService {
    private readonly logger = new Logger(PlatformSyncSecretService.name);
    private cachedKey: Buffer | null = null;

    constructor(private readonly workRepository: WorkRepository) {}

    /**
     * Lazily provision the per-Work secret. Returns the plaintext hex.
     *
     * Concurrency: two simultaneous calls for the same Work both generate
     * a fresh value, but only one wins the conditional UPDATE; the loser
     * re-reads and returns the persisted value.
     */
    async getOrGenerate(workId: string): Promise<string> {
        const existing = await this.workRepository.findById(workId);
        if (!existing) {
            throw new Error(`Work not found: ${workId}`);
        }
        if (existing.platformSyncSecretEncrypted) {
            return this.decrypt(existing.platformSyncSecretEncrypted);
        }
        const plaintext = randomBytes(SECRET_LENGTH_BYTES).toString('hex');
        const encrypted = this.encrypt(plaintext);
        const won = await this.workRepository.setPlatformSyncSecretIfNull(workId, encrypted);
        if (won) {
            return plaintext;
        }
        // Lost the race — another deploy generated it first. Read back.
        const reread = await this.workRepository.findById(workId);
        if (!reread?.platformSyncSecretEncrypted) {
            throw new Error(
                `Platform sync secret bootstrap race lost but no value found for work ${workId}`,
            );
        }
        return this.decrypt(reread.platformSyncSecretEncrypted);
    }

    /**
     * Rotate the per-Work secret unconditionally. Returns the new plaintext.
     * The next deploy carries the new value to the site's GHA secret;
     * pull-mode requests will keep using the OLD value until that deploy
     * finishes — the caller (admin UX) is responsible for telling the
     * operator to redeploy.
     */
    async rotate(workId: string): Promise<string> {
        const existing = await this.workRepository.findById(workId);
        if (!existing) {
            throw new Error(`Work not found: ${workId}`);
        }
        const plaintext = randomBytes(SECRET_LENGTH_BYTES).toString('hex');
        const encrypted = this.encrypt(plaintext);
        await this.workRepository.update(workId, { platformSyncSecretEncrypted: encrypted });
        this.logger.log(`Rotated platform sync secret for work ${workId} — redeploy required`);
        return plaintext;
    }

    /**
     * Decrypt the secret for a Work that already has one provisioned.
     * Returns `null` if the Work has no secret yet — the caller (the pull
     * client) should degrade gracefully and surface a "not provisioned"
     * banner instead of crashing.
     */
    decryptForWork(work: Pick<Work, 'platformSyncSecretEncrypted'>): string | null {
        if (!work.platformSyncSecretEncrypted) {
            return null;
        }
        return this.decrypt(work.platformSyncSecretEncrypted);
    }

    private getKey(): Buffer {
        if (this.cachedKey) {
            return this.cachedKey;
        }
        const hex = config.platformSync.getEncryptionKey();
        if (!hex) {
            throw new Error(
                'PLATFORM_ENCRYPTION_KEY is not set. Required for encrypting per-Work platform_sync_secret.',
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
            throw new Error('platform_sync_secret envelope is malformed (too short).');
        }
        const iv = buf.subarray(0, IV_LENGTH_BYTES);
        const authTag = buf.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
        const ciphertext = buf.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        try {
            return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        } catch (err) {
            this.logger.error('Failed to decrypt platform_sync_secret', err);
            throw new Error('platform_sync_secret decryption failed (auth tag mismatch).');
        }
    }
}
