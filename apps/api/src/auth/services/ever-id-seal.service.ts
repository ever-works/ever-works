import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { EVER_ID_LIMITS } from '@ever-works/contracts';
import { config } from '../../config/constants';

/**
 * The three kinds of sealed value (APW-12 plan §3.4) and how long each lives.
 *
 * - `txn` — the browser transaction between "Sign in with Ever ID" and the
 *   callback: `state`, `nonce`, PKCE verifier, intent (600 s, FR-9).
 * - `signUp` — a pending account creation (S2) or the account-exists hand-off
 *   (S3): the verified identity, until the person confirms (600 s, FR-23).
 * - `connect` — a pending connection from Settings (300 s, FR-26).
 */
export type EverIdSealKind = 'txn' | 'signUp' | 'connect';

export const EVER_ID_SEAL_TTL_SECONDS: Readonly<Record<EverIdSealKind, number>> = {
    txn: EVER_ID_LIMITS.transactionTtlSeconds,
    signUp: EVER_ID_LIMITS.signUpPendingTtlSeconds,
    connect: EVER_ID_LIMITS.connectPendingTtlSeconds,
};

/** NFR-6: a sealed value never exceeds 3,072 characters, so its cookie fits under 4 KB. */
export const EVER_ID_SEAL_MAX_LENGTH = 3_072;

const VERSION = 1;
const IV_BYTES = 12;
/** A sealed value never inflates past this — a bound on what a forged value can make the API decompress. */
const MAX_PLAINTEXT_BYTES = 16_384;
const TAG_BYTES = 16;
const HKDF_SALT = 'ever-id';
const HKDF_INFO = 'ever-id-seal-v1';

/** Thrown for every way a sealed value can be wrong — one error, one copy (S17). */
export class EverIdSealError extends Error {
    constructor() {
        super('sealed value invalid');
        this.name = 'EverIdSealError';
    }
}

interface SealEnvelope<T> {
    v: number;
    k: EverIdSealKind;
    exp: number;
    d: T;
}

/**
 * APW-12 (Ever ID) — the sealed values the flow hands to the browser and gets
 * back (plan §3.4). Never persisted: a sealed value is the whole state of a
 * pending step, authenticated and encrypted so the browser can carry it but
 * neither read nor alter it.
 *
 * AES-256-GCM with a key derived by HKDF-SHA256 from the platform's auth
 * secret (salt `ever-id`, info `ever-id-seal-v1`), a fresh 12-byte IV per seal,
 * the JSON deflated before encryption, base64url output. A wrong kind, version, expiry or authentication tag is one
 * error ({@link EverIdSealError}) that the API answers as
 * `transactionInvalid` (S17). Sealing is not single use by itself — the replay
 * store makes each value usable once (FR-19, NFR-7).
 */
@Injectable()
export class EverIdSealService {
    private key: Buffer | null = null;

    /** The clock, in epoch milliseconds — a seam a spec may replace. */
    protected now(): number {
        return Date.now();
    }

    seal<T>(kind: EverIdSealKind, data: T): string {
        const envelope: SealEnvelope<T> = {
            v: VERSION,
            k: kind,
            exp: Math.floor(this.now() / 1000) + EVER_ID_SEAL_TTL_SECONDS[kind],
            d: data,
        };
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv('aes-256-gcm', this.getKey(), iv);
        // Compressed before encryption, so a long return path still fits the cap.
        const plaintext = deflateRawSync(Buffer.from(JSON.stringify(envelope), 'utf8'));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
        if (sealed.length > EVER_ID_SEAL_MAX_LENGTH) {
            // Impossible for the payloads the flow builds (returnTo ≤ 2,048); refuse
            // rather than hand the browser a cookie it would silently drop.
            throw new EverIdSealError();
        }
        return sealed;
    }

    unseal<T>(kind: EverIdSealKind, sealed: unknown): T {
        if (
            typeof sealed !== 'string' ||
            sealed.length === 0 ||
            sealed.length > EVER_ID_SEAL_MAX_LENGTH
        ) {
            throw new EverIdSealError();
        }
        let raw: Buffer;
        try {
            raw = Buffer.from(sealed, 'base64url');
        } catch {
            throw new EverIdSealError();
        }
        if (raw.length <= IV_BYTES + TAG_BYTES) throw new EverIdSealError();
        const iv = raw.subarray(0, IV_BYTES);
        const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
        const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
        let envelope: SealEnvelope<T>;
        try {
            const decipher = createDecipheriv('aes-256-gcm', this.getKey(), iv);
            decipher.setAuthTag(tag);
            const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            const plaintext = inflateRawSync(compressed, { maxOutputLength: MAX_PLAINTEXT_BYTES });
            envelope = JSON.parse(plaintext.toString('utf8')) as SealEnvelope<T>;
        } catch {
            throw new EverIdSealError();
        }
        if (
            !envelope ||
            envelope.v !== VERSION ||
            envelope.k !== kind ||
            typeof envelope.exp !== 'number' ||
            envelope.exp <= Math.floor(this.now() / 1000)
        ) {
            throw new EverIdSealError();
        }
        return envelope.d;
    }

    private getKey(): Buffer {
        if (!this.key) {
            this.key = Buffer.from(
                hkdfSync('sha256', config.auth.secret(), HKDF_SALT, HKDF_INFO, 32),
            );
        }
        return this.key;
    }
}
