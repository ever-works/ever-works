import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, type Repository } from 'typeorm';
import {
    generateInstanceKeyPair,
    makeNodeSigner,
    publicJwkOf,
    type Ed25519PublicJwk,
    type InstanceSigner,
} from '@ever-co/connect-sdk';
import { EVER_INSTANCE_ROW_ID, EverInstance } from '@ever-works/agent/entities';
import { EverInstanceService } from '@ever-works/agent/ever-instance';
import { PluginSecretEncService } from '@ever-works/agent/plugins';

/**
 * The connect key: the Ed25519 key this installation authenticates to Ever
 * Platform with (client assertions for its token). It is a different key from
 * the statistics key and lives in the reserved columns of `ever_instance`,
 * the private half wrapped with `PLUGIN_SECRET_ENCRYPTION_KEY` like a plugin
 * secret. It is never logged or returned by a route.
 */
@Injectable()
export class EverConnectKeyService {
    private readonly secrets: PluginSecretEncService;
    /**
     * The signer last made, with the exact ciphertext it was made from.
     * `signer()` runs on nearly every Ever Connect call (each `client()`), and
     * unwrapping the key there meant an AES decrypt and a key import per call.
     * The row is still read every time, so a key another replica discarded or
     * replaced is seen at once: a different (or no) ciphertext is a miss.
     */
    private cachedSigner: { sealed: string; signer: InstanceSigner } | null = null;

    constructor(
        @InjectRepository(EverInstance) private readonly instances: Repository<EverInstance>,
        private readonly identity: EverInstanceService,
        @Optional() secrets?: PluginSecretEncService,
    ) {
        this.secrets = secrets ?? new PluginSecretEncService();
    }

    /** The public key to connect with, made on first use (safe on many replicas at once). */
    async ensure(): Promise<Ed25519PublicJwk> {
        const signer = await this.signer();
        if (signer) return publicJwkOf(signer);
        await this.identity.ensure();
        const pair = generateInstanceKeyPair();
        await this.instances.update(
            { id: EVER_INSTANCE_ROW_ID, connectPrivateKeyEncrypted: IsNull() },
            {
                connectPublicKey: pair.publicJwk.x,
                connectPrivateKeyEncrypted: this.secrets.encryptValue(
                    Buffer.from(pair.privateKeyPkcs8Der).toString('base64'),
                ),
                connectKeyId: pair.kid,
            },
        );
        const stored = await this.signer();
        if (!stored) throw new Error('The connect key could not be stored');
        return publicJwkOf(stored);
    }

    /** The signer of the stored connect key, or `null` when there is none. */
    async signer(): Promise<InstanceSigner | null> {
        const row = await this.instances.findOne({ where: { id: EVER_INSTANCE_ROW_ID } });
        const sealed = row?.connectPrivateKeyEncrypted;
        if (!sealed) {
            this.cachedSigner = null;
            return null;
        }
        if (this.cachedSigner?.sealed === sealed) return this.cachedSigner.signer;
        const der = Buffer.from(this.secrets.decryptValue(sealed), 'base64');
        const signer = makeNodeSigner(der);
        this.cachedSigner = { sealed, signer };
        return signer;
    }

    /**
     * Forget the connect key. Ever Platform never accepts a key an installation
     * held again, so connecting after a disconnect needs a new one.
     */
    async discard(): Promise<void> {
        this.cachedSigner = null;
        await this.instances.update(
            { id: EVER_INSTANCE_ROW_ID },
            { connectPublicKey: null, connectPrivateKeyEncrypted: null, connectKeyId: null },
        );
    }
}
