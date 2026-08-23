import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { config } from '../config';
import { WorkRepository } from '../database/repositories/work.repository';
import { Work } from '../entities/work.entity';
import {
    WORK_RUNTIME_ENV_ALLOWED_KEYS,
    WORK_RUNTIME_ENV_MAX_VALUE_LENGTH,
    isWorkRuntimeEnvKey,
    isWorkRuntimeEnvSecretKey,
    maskWorkRuntimeEnvValue,
    type WorkRuntimeEnvKey,
    type WorkRuntimeEnvVarState,
} from './work-runtime-env.constants';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const SECRET_LENGTH_BYTES = 32;

/**
 * Provisions the per-Work **application runtime env** that a k8s-deployed
 * directory site needs to boot in production — `AUTH_SECRET`, `COOKIE_SECRET`,
 * and `DATABASE_URL`. `DeployService` reads these on a k8s deploy and pushes
 * them so `deploy_k8s.yaml` materializes a `${slug}-runtime-env` Secret the
 * Deployment mounts via `envFrom`.
 *
 * **Why this exists**: Vercel injected these from project env + the external Postgres
 * Marketplace integration. The k8s deploy path had no equivalent, so a
 * freshly-built site 500'd at first render (`[auth] AUTH_SECRET must be set in
 * production`). This service is the platform-side source of truth.
 *
 * **Persistence + stability**: `AUTH_SECRET` / `COOKIE_SECRET` are generated
 * once and persisted (AES-256-GCM, `PLATFORM_ENCRYPTION_KEY`) so they stay
 * stable across redeploys — rotating either would silently invalidate every
 * live session/cookie. `DATABASE_URL` is set explicitly (e.g. the reused external Postgres
 * connection string) rather than generated. This mirrors `WebhookSecretService`
 * / `PlatformSyncSecretService` exactly, including the race-safe conditional
 * UPDATE (`set*IfNull`) so concurrent deploys converge on one value.
 */
@Injectable()
export class WorkRuntimeEnvService {
    private readonly logger = new Logger(WorkRuntimeEnvService.name);
    private cachedKey: Buffer | null = null;

    constructor(private readonly workRepository: WorkRepository) {}

    /** Lazily provision the per-Work `AUTH_SECRET` (base64). Stable across deploys. */
    async getOrGenerateAuthSecret(workId: string): Promise<string> {
        return this.getOrGenerate(
            workId,
            (w) => w.deployAuthSecretEncrypted,
            (id, enc) => this.workRepository.setDeployAuthSecretIfNull(id, enc),
        );
    }

    /** Lazily provision the per-Work `COOKIE_SECRET` (base64). Stable across deploys. */
    async getOrGenerateCookieSecret(workId: string): Promise<string> {
        return this.getOrGenerate(
            workId,
            (w) => w.deployCookieSecretEncrypted,
            (id, enc) => this.workRepository.setDeployCookieSecretIfNull(id, enc),
        );
    }

    /** The per-Work `DATABASE_URL`, or null when none is configured yet. */
    async getDatabaseUrl(workId: string): Promise<string | null> {
        const work = await this.workRepository.findById(workId);
        if (!work?.deployDatabaseUrlEncrypted) {
            return null;
        }
        return this.decrypt(work.deployDatabaseUrlEncrypted);
    }

    /** Set (or replace) the per-Work `DATABASE_URL`. */
    async setDatabaseUrl(workId: string, databaseUrl: string): Promise<void> {
        const existing = await this.workRepository.findById(workId);
        if (!existing) {
            throw new Error(`Work not found: ${workId}`);
        }
        await this.workRepository.update(workId, {
            deployDatabaseUrlEncrypted: this.encrypt(databaseUrl),
        });
    }

    /**
     * Race-safe first-write of the per-Work `DATABASE_URL` (for the shared-DB
     * auto-provision path). Persists `databaseUrl` only if none is set yet, and
     * returns the URL that actually ended up stored (this one, or the winner of
     * a concurrent provision). Mirrors the `getOrGenerate` secret pattern.
     */
    async setDatabaseUrlIfNull(workId: string, databaseUrl: string): Promise<string> {
        const won = await this.workRepository.setDeployDatabaseUrlIfNull(
            workId,
            this.encrypt(databaseUrl),
        );
        if (won) {
            return databaseUrl;
        }
        const existing = await this.getDatabaseUrl(workId);
        if (!existing) {
            throw new Error(
                `DATABASE_URL bootstrap race lost but no value found for work ${workId}`,
            );
        }
        return existing;
    }

    /** The Work's DB mode (`'shared'` | `'custom'`), or null if never set. */
    async getDatabaseMode(workId: string): Promise<'shared' | 'custom' | null> {
        const work = await this.workRepository.findById(workId);
        return work?.deployDatabaseMode ?? null;
    }

    /** Set the Work's DB mode. */
    async setDatabaseMode(workId: string, mode: 'shared' | 'custom'): Promise<void> {
        await this.workRepository.setDeployDatabaseMode(workId, mode);
    }

    // ------------------------------------------------------------------
    // Operator-managed, allow-listed per-Work env (Stripe keys & co.)
    // ------------------------------------------------------------------

    /** The keys a dashboard user may set via `setRuntimeEnvVars`, in display order. */
    getAllowedEnvKeys(): readonly WorkRuntimeEnvKey[] {
        return WORK_RUNTIME_ENV_ALLOWED_KEYS;
    }

    /**
     * The decrypted per-Work env map (allow-listed keys only). Empty when the
     * Work has none configured. Used by `DeployService` to merge the values
     * into the k8s runtime-env Secret / push them as GitHub Actions secrets.
     *
     * Defensive on read: keys that are no longer allow-listed (e.g. after the
     * list shrinks) or whose stored value is not a string are dropped rather
     * than delivered, so the allow-list stays the single source of truth.
     */
    async getRuntimeEnvVars(workId: string): Promise<Record<string, string>> {
        const work = await this.workRepository.findById(workId);
        return this.decodeRuntimeEnvVars(work?.deployRuntimeEnvEncrypted);
    }

    /**
     * Merge-update the per-Work env map and persist it encrypted.
     *
     * Semantics: every provided key overwrites the stored value; `null`,
     * `undefined` or an empty/whitespace-only string REMOVES the key; keys not
     * mentioned are left untouched. Values are trimmed and capped at
     * `WORK_RUNTIME_ENV_MAX_VALUE_LENGTH`. Any key outside
     * `WORK_RUNTIME_ENV_ALLOWED_KEYS` rejects the whole call with a 400 —
     * nothing is written in that case, so a typo cannot half-apply.
     *
     * Returns the resulting (plaintext) map. Read-modify-write without a row
     * lock: concurrent PUTs for the same Work are last-writer-wins, which is
     * acceptable for an operator-driven settings form.
     */
    async setRuntimeEnvVars(
        workId: string,
        vars: Record<string, string | null | undefined>,
    ): Promise<Record<string, string>> {
        const existing = await this.workRepository.findById(workId);
        if (!existing) {
            throw new Error(`Work not found: ${workId}`);
        }
        const entries = Object.entries(vars ?? {});
        const unknown = entries.map(([key]) => key).filter((key) => !isWorkRuntimeEnvKey(key));
        if (unknown.length > 0) {
            throw new BadRequestException(
                `Unsupported runtime env key(s): ${unknown.join(', ')}. Allowed keys: ${WORK_RUNTIME_ENV_ALLOWED_KEYS.join(', ')}.`,
            );
        }

        const next = this.decodeRuntimeEnvVars(existing.deployRuntimeEnvEncrypted);
        for (const [key, raw] of entries) {
            if (raw === null || raw === undefined) {
                delete next[key];
                continue;
            }
            if (typeof raw !== 'string') {
                throw new BadRequestException(`${key} must be a string (or null to remove it).`);
            }
            const value = raw.trim();
            if (!value) {
                delete next[key];
                continue;
            }
            if (value.length > WORK_RUNTIME_ENV_MAX_VALUE_LENGTH) {
                throw new BadRequestException(
                    `${key} exceeds the maximum length of ${WORK_RUNTIME_ENV_MAX_VALUE_LENGTH} characters.`,
                );
            }
            // eslint-disable-next-line no-control-regex
            if (/[\u0000-\u001f\u007f]/.test(value)) {
                throw new BadRequestException(`${key} must not contain control characters.`);
            }
            next[key] = value;
        }

        // Persist in allow-list order so the stored JSON is deterministic.
        const ordered: Record<string, string> = {};
        for (const key of WORK_RUNTIME_ENV_ALLOWED_KEYS) {
            if (next[key] !== undefined) ordered[key] = next[key];
        }
        await this.workRepository.update(workId, {
            deployRuntimeEnvEncrypted:
                Object.keys(ordered).length > 0 ? this.encrypt(JSON.stringify(ordered)) : null,
        });
        return ordered;
    }

    /**
     * Masked, API-safe view of the per-Work env: one entry per allow-listed
     * key (so the dashboard can render the whole form), never a plaintext
     * value. Secrets collapse to `***`; non-secret values keep a short prefix.
     */
    async describeRuntimeEnvVars(workId: string): Promise<WorkRuntimeEnvVarState[]> {
        const vars = await this.getRuntimeEnvVars(workId);
        return WORK_RUNTIME_ENV_ALLOWED_KEYS.map((key) => {
            const value = vars[key];
            return {
                key,
                set: value !== undefined,
                masked: value !== undefined ? maskWorkRuntimeEnvValue(key, value) : null,
                secret: isWorkRuntimeEnvSecretKey(key),
            };
        });
    }

    /** Decrypt + parse the stored JSON map, keeping only allow-listed string values. */
    private decodeRuntimeEnvVars(envelope: string | null | undefined): Record<string, string> {
        if (!envelope) {
            return {};
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(this.decrypt(envelope));
        } catch (err) {
            this.logger.error('Failed to decode per-Work runtime env map', err);
            throw new Error('deploy runtime-env map is malformed.');
        }
        const out: Record<string, string> = {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (isWorkRuntimeEnvKey(key) && typeof value === 'string' && value.length > 0) {
                    out[key] = value;
                }
            }
        }
        return out;
    }

    /**
     * Shared race-safe getOrGenerate for a base64 secret stored in an encrypted
     * Work column. First deploy generates + persists; concurrent deploys re-read.
     */
    private async getOrGenerate(
        workId: string,
        read: (work: Work) => string | null | undefined,
        setIfNull: (workId: string, encrypted: string) => Promise<boolean>,
    ): Promise<string> {
        const existing = await this.workRepository.findById(workId);
        if (!existing) {
            throw new Error(`Work not found: ${workId}`);
        }
        const current = read(existing);
        if (current) {
            return this.decrypt(current);
        }
        const plaintext = randomBytes(SECRET_LENGTH_BYTES).toString('base64');
        const encrypted = this.encrypt(plaintext);
        const won = await setIfNull(workId, encrypted);
        if (won) {
            return plaintext;
        }
        // Lost the race — another deploy generated it first. Read back.
        const reread = await this.workRepository.findById(workId);
        const rereadValue = reread ? read(reread) : undefined;
        if (!rereadValue) {
            throw new Error(
                `Runtime-env secret bootstrap race lost but no value found for work ${workId}`,
            );
        }
        return this.decrypt(rereadValue);
    }

    private getKey(): Buffer {
        if (this.cachedKey) {
            return this.cachedKey;
        }
        const hex = config.platformSync.getEncryptionKey();
        if (!hex) {
            throw new Error(
                'PLATFORM_ENCRYPTION_KEY is not set. Required for encrypting per-Work deploy runtime env.',
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
            throw new Error('deploy runtime-env envelope is malformed (too short).');
        }
        const iv = buf.subarray(0, IV_LENGTH_BYTES);
        const authTag = buf.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
        const ciphertext = buf.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        try {
            return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        } catch (err) {
            this.logger.error('Failed to decrypt deploy runtime-env', err);
            throw new Error('deploy runtime-env decryption failed (auth tag mismatch).');
        }
    }
}
