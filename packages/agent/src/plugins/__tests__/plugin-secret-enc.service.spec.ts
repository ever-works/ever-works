import { Logger } from '@nestjs/common';
import { PluginSecretEncService } from '../services/plugin-secret-enc.service';

// Silence Logger output during tests.
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

/**
 * C-08 — AES-256-GCM envelope-encryption invariants for plugin secret settings.
 *
 * These specs lock the contract of `PluginSecretEncService` so future
 * refactors can't accidentally weaken at-rest encryption: random IV per
 * encrypt, GCM auth-tag verification on every decrypt, hard fail in prod
 * when the key is missing, and the stable `enc::v1::` version prefix that
 * lets readers distinguish encrypted records from legacy plaintext rows.
 */
describe('PluginSecretEncService (C-08 envelope encryption)', () => {
    // A known 32-byte hex key (64 hex chars) — same value across tests so each
    // test can construct a fresh service instance without leaking state.
    const TEST_KEY_HEX = 'a'.repeat(64);
    const ENVELOPE_PREFIX = 'enc::v1::';

    // Snapshot of the relevant env vars; restored after every test so a
    // production-mode test can't bleed into the next one.
    let savedKey: string | undefined;
    let savedNodeEnv: string | undefined;

    beforeEach(() => {
        savedKey = process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
        savedNodeEnv = process.env.NODE_ENV;
    });

    afterEach(() => {
        if (savedKey === undefined) {
            delete process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
        } else {
            process.env.PLUGIN_SECRET_ENCRYPTION_KEY = savedKey;
        }
        if (savedNodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = savedNodeEnv;
        }
    });

    // Helper: create a fresh service with the test key configured.
    const makeServiceWithKey = (): PluginSecretEncService => {
        process.env.PLUGIN_SECRET_ENCRYPTION_KEY = TEST_KEY_HEX;
        return new PluginSecretEncService();
    };

    // Helper: decode the base64 payload of an envelope into a mutable Buffer.
    const decodeEnvelope = (envelope: string): Buffer =>
        Buffer.from(envelope.slice(ENVELOPE_PREFIX.length), 'base64');

    // Helper: re-encode a Buffer back into the envelope shape.
    const reEncodeEnvelope = (buf: Buffer): string => `${ENVELOPE_PREFIX}${buf.toString('base64')}`;

    it('round-trips a plaintext value through encryptValue → decryptValue', () => {
        const service = makeServiceWithKey();
        const plaintext = 'super-secret-api-key-xyz-123';
        const envelope = service.encryptValue(plaintext);

        // Sanity: produced an actual envelope, not a passthrough.
        expect(envelope.startsWith(ENVELOPE_PREFIX)).toBe(true);
        expect(envelope).not.toContain(plaintext);

        // Round-trip equals input exactly.
        expect(service.decryptValue(envelope)).toBe(plaintext);
    });

    it('decryptValue passes legacy plaintext (no enc::v1:: prefix) through unchanged', () => {
        const service = makeServiceWithKey();

        // A raw value from before the cutover — no prefix.
        const legacy = 'plaintext-token-from-before-encryption-shipped';
        expect(service.decryptValue(legacy)).toBe(legacy);

        // Empty string is also valid passthrough — no prefix, nothing to decrypt.
        expect(service.decryptValue('')).toBe('');
    });

    it('throws when the ciphertext bytes are tampered with (GCM auth-tag mismatch)', () => {
        const service = makeServiceWithKey();
        const envelope = service.encryptValue('secret-payload-that-must-not-tamper');

        // IV (0..12) + authTag (12..28) + ciphertext (28..). Flip a single
        // ciphertext byte — auth tag verification must reject the message.
        const buf = decodeEnvelope(envelope);
        buf[buf.length - 1] ^= 0xff;
        const tampered = reEncodeEnvelope(buf);

        expect(() => service.decryptValue(tampered)).toThrow(/auth tag mismatch/i);
    });

    it('throws when the auth-tag bytes are tampered with', () => {
        const service = makeServiceWithKey();
        const envelope = service.encryptValue('another-secret');

        // Flip a byte inside the auth-tag region (offsets 12..28).
        const buf = decodeEnvelope(envelope);
        buf[20] ^= 0xff;
        const tampered = reEncodeEnvelope(buf);

        expect(() => service.decryptValue(tampered)).toThrow(/auth tag mismatch/i);
    });

    it('throws when the IV bytes are tampered with', () => {
        const service = makeServiceWithKey();
        const envelope = service.encryptValue('iv-tamper-target');

        // Flip a byte in the IV region (offsets 0..12). Changing the IV means
        // the auth tag (computed over the original IV) no longer verifies.
        const buf = decodeEnvelope(envelope);
        buf[0] ^= 0xff;
        const tampered = reEncodeEnvelope(buf);

        expect(() => service.decryptValue(tampered)).toThrow(/auth tag mismatch/i);
    });

    it('throws in production when PLUGIN_SECRET_ENCRYPTION_KEY is unset', () => {
        delete process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
        process.env.NODE_ENV = 'production';

        const service = new PluginSecretEncService();

        // The boot-time guard is what fails fast — assertKeyAvailableInProd is
        // the canonical entry point for this invariant.
        expect(() => service.assertKeyAvailableInProd()).toThrow(/PLUGIN_SECRET_ENCRYPTION_KEY/);
        expect(() => service.assertKeyAvailableInProd()).toThrow(/production/);
    });

    it('passes through plaintext when the key is unset in test/dev mode, but throws on encrypted envelopes', () => {
        delete process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
        process.env.NODE_ENV = 'test';

        const service = new PluginSecretEncService();

        // No key → encryptValue is a passthrough (dev/preview convenience).
        const plaintext = 'no-key-configured-yet';
        expect(service.encryptValue(plaintext)).toBe(plaintext);
        expect(service.isEnabled()).toBe(false);

        // But a real enc::v1:: envelope must NOT be silently returned as
        // ciphertext to the caller — that would leak base64 into the UI.
        // Build a valid-looking envelope using a different service that DOES
        // have the key, then attempt to decrypt it with the key-less one.
        const encryptingService = makeServiceWithKey();
        const envelope = encryptingService.encryptValue('payload');

        // Re-clear the key for the failing service (makeServiceWithKey set it).
        delete process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
        const keylessService = new PluginSecretEncService();

        expect(() => keylessService.decryptValue(envelope)).toThrow(
            /PLUGIN_SECRET_ENCRYPTION_KEY is missing but encrypted secrets are present/,
        );
    });

    it('throws at first key access when PLUGIN_SECRET_ENCRYPTION_KEY is malformed', () => {
        // Non-hex characters.
        process.env.PLUGIN_SECRET_ENCRYPTION_KEY = 'zzz-not-hex-at-all-zzz';
        const badCharsService = new PluginSecretEncService();
        expect(() => badCharsService.encryptValue('x')).toThrow(/PLUGIN_SECRET_ENCRYPTION_KEY/);
        expect(() => badCharsService.encryptValue('x')).toThrow(/hex/i);

        // Wrong byte length (valid hex, but decodes to 16 bytes, not 32).
        process.env.PLUGIN_SECRET_ENCRYPTION_KEY = 'a'.repeat(32); // 16 bytes
        const shortKeyService = new PluginSecretEncService();
        expect(() => shortKeyService.encryptValue('x')).toThrow(/PLUGIN_SECRET_ENCRYPTION_KEY/);
        expect(() => shortKeyService.encryptValue('x')).toThrow(/32 bytes/);
    });

    it('produces a fresh, random IV on every encrypt — same plaintext yields different ciphertexts', () => {
        const service = makeServiceWithKey();
        const plaintext = 'deterministic-input-must-not-yield-deterministic-output';

        const envelope1 = service.encryptValue(plaintext);
        const envelope2 = service.encryptValue(plaintext);
        const envelope3 = service.encryptValue(plaintext);

        // All distinct — random IV ensures ciphertext divergence.
        expect(envelope1).not.toBe(envelope2);
        expect(envelope2).not.toBe(envelope3);
        expect(envelope1).not.toBe(envelope3);

        // But all three decrypt back to the same plaintext.
        expect(service.decryptValue(envelope1)).toBe(plaintext);
        expect(service.decryptValue(envelope2)).toBe(plaintext);
        expect(service.decryptValue(envelope3)).toBe(plaintext);

        // And the IV prefix (first 12 bytes after the version tag) is
        // distinct across encrypts — proves the randomness is in the IV
        // itself, not just the ciphertext bytes.
        const iv1 = decodeEnvelope(envelope1).subarray(0, 12);
        const iv2 = decodeEnvelope(envelope2).subarray(0, 12);
        const iv3 = decodeEnvelope(envelope3).subarray(0, 12);
        expect(iv1.equals(iv2)).toBe(false);
        expect(iv2.equals(iv3)).toBe(false);
        expect(iv1.equals(iv3)).toBe(false);
    });

    it('uses the version prefix `enc::v1::` exactly (future-rotation invariant)', () => {
        const service = makeServiceWithKey();
        const envelope = service.encryptValue('any-value');

        // Exact prefix — not v2, not v0, not a typo. Bumping this is a
        // breaking change that requires a coordinated migration.
        expect(envelope.startsWith('enc::v1::')).toBe(true);
        expect(envelope.startsWith('enc::v2::')).toBe(false);
        expect(envelope.startsWith('enc::v0::')).toBe(false);
        expect(envelope.startsWith('encv1::')).toBe(false);

        // The literal prefix string itself is unchanged.
        expect(envelope.slice(0, 'enc::v1::'.length)).toBe('enc::v1::');
    });
});
