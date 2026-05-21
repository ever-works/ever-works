import { Logger } from '@nestjs/common';
import { WebhookSecretService } from './webhook-secret.service';

describe('WebhookSecretService', () => {
    const SAVED = process.env.PLATFORM_ENCRYPTION_KEY;
    let service: WebhookSecretService;
    let errorSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
        errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
        warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    });

    afterEach(() => {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
        if (SAVED === undefined) delete process.env.PLATFORM_ENCRYPTION_KEY;
        else process.env.PLATFORM_ENCRYPTION_KEY = SAVED;
    });

    describe('without key (dev/test passthrough)', () => {
        beforeEach(() => {
            delete process.env.PLATFORM_ENCRYPTION_KEY;
            service = new WebhookSecretService();
        });

        it('reports disabled', () => {
            expect(service.isEnabled()).toBe(false);
        });

        it('encrypt() returns the input unchanged', () => {
            expect(service.encrypt('hello')).toBe('hello');
        });

        it('decrypt() returns plaintext unchanged when no prefix', () => {
            expect(service.decrypt('hello')).toBe('hello');
        });

        it('generateSecret returns 32-byte base64url raw secret', () => {
            const r = service.generateSecret();
            // 32 raw bytes → 43 base64url chars (no padding).
            expect(r.raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
            // In passthrough mode the encrypted == raw.
            expect(r.encrypted).toBe(r.raw);
        });
    });

    describe('with 32-byte hex key', () => {
        beforeEach(() => {
            process.env.PLATFORM_ENCRYPTION_KEY =
                '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
            service = new WebhookSecretService();
        });

        it('reports enabled', () => {
            expect(service.isEnabled()).toBe(true);
        });

        it('encrypt → decrypt round-trips', () => {
            const ct = service.encrypt('the-secret');
            expect(ct).toMatch(/^enc::v1::/);
            expect(service.decrypt(ct)).toBe('the-secret');
        });

        it('two encryptions of the same plaintext yield different ciphertexts (random IV)', () => {
            const a = service.encrypt('same');
            const b = service.encrypt('same');
            expect(a).not.toBe(b);
            expect(service.decrypt(a)).toBe('same');
            expect(service.decrypt(b)).toBe('same');
        });

        it('tampered ciphertext fails to decrypt (AES-GCM auth tag check)', () => {
            const ct = service.encrypt('truth');
            // Flip the last byte of the base64 payload.
            const corrupted = ct.slice(0, -1) + (ct.slice(-1) === 'A' ? 'B' : 'A');
            // GCM auth-tag failure logs + returns empty string per service contract.
            const result = service.decrypt(corrupted);
            expect(result).toBe('');
        });

        it('generateSecret returns RAW != encrypted', () => {
            const r = service.generateSecret();
            expect(r.encrypted).toMatch(/^enc::v1::/);
            expect(r.encrypted).not.toBe(r.raw);
            expect(service.decrypt(r.encrypted)).toBe(r.raw);
        });

        it('rejects a key of wrong length (treats as no-key)', () => {
            process.env.PLATFORM_ENCRYPTION_KEY = 'too-short';
            const bad = new WebhookSecretService();
            expect(bad.isEnabled()).toBe(false);
            expect(bad.encrypt('hi')).toBe('hi');
        });
    });

    describe('with base64 (44-char) key', () => {
        beforeEach(() => {
            // 32 bytes → 44 base64 chars (with one '=').
            process.env.PLATFORM_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
            service = new WebhookSecretService();
        });

        it('encrypt → decrypt round-trips', () => {
            const ct = service.encrypt('via-b64');
            expect(service.decrypt(ct)).toBe('via-b64');
        });
    });
});
