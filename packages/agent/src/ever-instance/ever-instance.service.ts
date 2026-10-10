import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createPrivateKey, randomUUID } from 'crypto';
import type { Repository } from 'typeorm';
import {
    generateStatsKey,
    statsKeyId,
    statsSignerFromSeed,
    type StatsSigner,
} from '@ever-co/connect-sdk';
import { EVER_INSTANCE_ROW_ID, EverInstance } from '../entities/ever-instance.entity';
import { PluginSecretEncService } from '../plugins/services/plugin-secret-enc.service';

/** Emitted after the operator reset the instance identity (no payload beyond the new reset count). */
export const EVER_INSTANCE_RESET_EVENT = 'ever-instance.reset';

/** The prefix of a value wrapped with `PLUGIN_SECRET_ENCRYPTION_KEY` (`PluginSecretEncService`). */
const WRAPPED_PREFIX = 'enc::v1::';

/**
 * The stored statistics key cannot be read: `PLUGIN_SECRET_ENCRYPTION_KEY`
 * was removed or changed after the key was wrapped with it, or the stored
 * value is damaged. Nothing can be signed until the key comes back or the
 * operator resets the identity. The message names the condition only.
 */
export class EverInstanceKeyUnreadableError extends Error {
    constructor() {
        super('The statistics key of this installation cannot be read');
        this.name = 'EverInstanceKeyUnreadableError';
    }
}

/** A statistics key as the identity row stores it. */
export interface StoredStatsKey {
    /** base64url (no padding) of the 32-byte public key. */
    statsPublicKey: string;
    /** The PKCS#8 DER private key, base64, wrapped with `PLUGIN_SECRET_ENCRYPTION_KEY` when set. */
    statsPrivateKeyEncrypted: string;
    /** base64url of the first 8 bytes of SHA-256 over the public key bytes. */
    statsKeyId: string;
}

/**
 * A new statistics key from the Ever Platform SDK (`generateStatsKey`), in the
 * form the identity row stores it: the public key and its key id as the SDK
 * derives them, and the private key as PKCS#8 DER (base64), wrapped by
 * `secrets`.
 */
export function newStoredStatsKey(secrets: PluginSecretEncService): StoredStatsKey {
    const { seed, signer } = generateStatsKey();
    const pkcs8 = createPrivateKey({
        key: {
            kty: 'OKP',
            crv: 'Ed25519',
            d: Buffer.from(seed).toString('base64url'),
            x: signer.publicKey,
        },
        format: 'jwk',
    }).export({ format: 'der', type: 'pkcs8' }) as Buffer;
    return {
        statsPublicKey: signer.publicKey,
        statsPrivateKeyEncrypted: secrets.encryptValue(pkcs8.toString('base64')),
        statsKeyId: statsKeyId(signer.publicKey),
    };
}

/**
 * The installation's identity for the anonymous usage statistics module: the
 * one `ever_instance` row, its opaque `instanceId` and the statistics-only
 * Ed25519 key that signs every report.
 *
 * - `ensure()` creates the row on first boot with `INSERT … ON CONFLICT DO
 *   NOTHING` (`orIgnore`), so N replicas booting at once on one database end
 *   up with ONE identity, whichever insert won.
 * - `statsSigner()` answers the Ever Platform SDK's `StatsSigner` for the
 *   stored key (`statsSignerFromSeed`), which signs exactly the bytes it is
 *   given. The private key is unwrapped in memory only.
 * - `reset()` gives the installation a new `instanceId` and a new statistics
 *   key, so future reports cannot be joined to past ones.
 *
 * No route, no timer, no network code. Key material is never logged: the
 * only things this class logs are the fact that an identity was created or
 * reset.
 */
@Injectable()
export class EverInstanceService {
    private readonly logger = new Logger(EverInstanceService.name);
    private readonly secrets: PluginSecretEncService;
    private cachedSigner: { keyId: string; signer: StatsSigner } | null = null;

    constructor(
        @InjectRepository(EverInstance) private readonly repository: Repository<EverInstance>,
        @Optional() secrets?: PluginSecretEncService,
        @Optional() private readonly events?: EventEmitter2,
    ) {
        // Stateless apart from a lazily read key; the same envelope as plugin
        // secret settings (`enc::v1::`, AES-256-GCM, `PLUGIN_SECRET_ENCRYPTION_KEY`).
        this.secrets = secrets ?? new PluginSecretEncService();
    }

    /** The identity row, or `null` before the first `ensure()`. */
    async get(): Promise<EverInstance | null> {
        return this.repository.findOne({ where: { id: EVER_INSTANCE_ROW_ID } });
    }

    /** The identity row, created on first use. Safe to call concurrently from many replicas. */
    async ensure(): Promise<EverInstance> {
        const existing = await this.get();
        if (existing) return existing;

        const key = newStoredStatsKey(this.secrets);
        const result = await this.repository
            .createQueryBuilder()
            .insert()
            .into(EverInstance)
            .values({
                id: EVER_INSTANCE_ROW_ID,
                instanceId: randomUUID(),
                ...key,
                statsEnabledUi: true,
                resetCount: 0,
            })
            .orIgnore()
            .execute();

        const row = await this.get();
        if (!row) {
            throw new Error('ever_instance row could not be created');
        }
        if ((result.identifiers?.length ?? 0) > 0 && row.statsKeyId === key.statsKeyId) {
            this.logger.log('Created the anonymous usage statistics identity of this installation');
        }
        return row;
    }

    /**
     * The SDK's `StatsSigner` for the stored statistics key: it signs exactly
     * the bytes it is given. Throws {@link EverInstanceKeyUnreadableError} when
     * the stored key cannot be read.
     */
    async statsSigner(): Promise<StatsSigner> {
        return this.signerOf(await this.ensure());
    }

    /**
     * A new `instanceId` and a new statistics key pair; `resetCount` + 1. The
     * reserved connection key columns are left exactly as they are.
     */
    async reset(): Promise<EverInstance> {
        const row = await this.ensure();
        const key = newStoredStatsKey(this.secrets);
        await this.repository.update(
            { id: EVER_INSTANCE_ROW_ID },
            {
                instanceId: randomUUID(),
                ...key,
                resetCount: row.resetCount + 1,
            },
        );
        this.cachedSigner = null;
        const next = await this.ensure();
        this.logger.log('Reset the anonymous usage statistics identity of this installation');
        this.events?.emit(EVER_INSTANCE_RESET_EVENT, { resetCount: next.resetCount });
        return next;
    }

    /** Whether the stored private key is wrapped with `PLUGIN_SECRET_ENCRYPTION_KEY`. */
    isKeyStoredWrapped(row: Pick<EverInstance, 'statsPrivateKeyEncrypted'>): boolean {
        return row.statsPrivateKeyEncrypted.startsWith(WRAPPED_PREFIX);
    }

    /**
     * Boot: wrap a key that was stored before `PLUGIN_SECRET_ENCRYPTION_KEY`
     * was set (a value is otherwise rewritten only by a reset). Answers whether
     * the stored key is wrapped now; `false` means no encryption key is
     * configured, and the key stays as it is.
     */
    async wrapStoredKey(): Promise<boolean> {
        const row = await this.ensure();
        if (this.isKeyStoredWrapped(row)) return true;
        if (!this.secrets.isEnabled()) return false;
        await this.repository.update(
            { id: EVER_INSTANCE_ROW_ID, statsKeyId: row.statsKeyId },
            { statsPrivateKeyEncrypted: this.secrets.encryptValue(row.statsPrivateKeyEncrypted) },
        );
        this.logger.log('Wrapped the statistics key of this installation with the encryption key');
        return this.isKeyStoredWrapped(await this.ensure());
    }

    /** Whether the statistics key can be read (and so a report signed) right now. */
    async isKeyReadable(): Promise<boolean> {
        try {
            this.signerOf(await this.ensure());
            return true;
        } catch (error) {
            if (error instanceof EverInstanceKeyUnreadableError) return false;
            throw error;
        }
    }

    /** The operator switch in Settings. */
    async setStatsEnabledUi(enabled: boolean): Promise<EverInstance> {
        await this.ensure();
        await this.repository.update({ id: EVER_INSTANCE_ROW_ID }, { statsEnabledUi: enabled });
        return this.ensure();
    }

    /**
     * The SDK signer over the stored key: the 32-byte Ed25519 seed read from
     * the stored PKCS#8 value, handed to `statsSignerFromSeed`.
     */
    private signerOf(row: EverInstance): StatsSigner {
        if (this.cachedSigner && this.cachedSigner.keyId === row.statsKeyId) {
            return this.cachedSigner.signer;
        }
        let signer: StatsSigner;
        try {
            const der = Buffer.from(
                this.secrets.decryptValue(row.statsPrivateKeyEncrypted),
                'base64',
            );
            const jwk = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({
                format: 'jwk',
            }) as { crv?: string; d?: string };
            if (jwk.crv !== 'Ed25519' || !jwk.d) throw new Error('not an Ed25519 key');
            signer = statsSignerFromSeed(new Uint8Array(Buffer.from(jwk.d, 'base64url')));
        } catch {
            // A missing or changed PLUGIN_SECRET_ENCRYPTION_KEY, or a damaged
            // value. Never echo the stored value: name the condition only.
            throw new EverInstanceKeyUnreadableError();
        }
        this.cachedSigner = { keyId: row.statsKeyId, signer };
        return signer;
    }
}
