import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { config } from '../config';
import { WorkRepository } from '../database/repositories/work.repository';
import { Work } from '../entities/work.entity';

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
 * **Why this exists**: Vercel injected these from project env + the Neon
 * Marketplace integration. The k8s deploy path had no equivalent, so a
 * freshly-built site 500'd at first render (`[auth] AUTH_SECRET must be set in
 * production`). This service is the platform-side source of truth.
 *
 * **Persistence + stability**: `AUTH_SECRET` / `COOKIE_SECRET` are generated
 * once and persisted (AES-256-GCM, `PLATFORM_ENCRYPTION_KEY`) so they stay
 * stable across redeploys — rotating either would silently invalidate every
 * live session/cookie. `DATABASE_URL` is set explicitly (e.g. the reused Neon
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
			throw new Error(`Runtime-env secret bootstrap race lost but no value found for work ${workId}`);
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
