import { randomBytes } from 'node:crypto';
import {
    EVER_ID_SEAL_MAX_LENGTH,
    EverIdSealError,
    EverIdSealService,
} from './ever-id-seal.service';

/**
 * APW-12 (Ever ID) — sealed values (plan §3.4, NFR-6, S17). One error for every
 * way a sealed value can be wrong, so the API answers all of them alike.
 */
describe('EverIdSealService', () => {
    const SAVED_SECRET = process.env.AUTH_SECRET;
    let clock = Date.parse('2026-09-01T00:00:00.000Z');

    class ClockedSeal extends EverIdSealService {
        protected now(): number {
            return clock;
        }
    }

    beforeAll(() => {
        process.env.AUTH_SECRET = 'a-test-secret-that-is-long-enough-for-hkdf-1234';
    });
    afterAll(() => {
        if (SAVED_SECRET === undefined) delete process.env.AUTH_SECRET;
        else process.env.AUTH_SECRET = SAVED_SECRET;
    });
    beforeEach(() => {
        clock = Date.parse('2026-09-01T00:00:00.000Z');
    });

    it('round-trips a payload for the same kind', () => {
        const seal = new ClockedSeal();
        const sealed = seal.seal('txn', { state: 's', nonce: 'n', codeVerifier: 'v' });

        expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(seal.unseal('txn', sealed)).toEqual({ state: 's', nonce: 'n', codeVerifier: 'v' });
    });

    it('never shows the payload in clear text', () => {
        const sealed = new ClockedSeal().seal('signUp', { email: 'person@example.com' });
        expect(Buffer.from(sealed, 'base64url').toString('latin1')).not.toContain(
            'person@example.com',
        );
    });

    it('refuses another kind, a tampered value and garbage with one error', () => {
        const seal = new ClockedSeal();
        const sealed = seal.seal('connect', { id: 'x' });
        const raw = Buffer.from(sealed, 'base64url');
        raw[raw.length - 1] ^= 0x01;

        expect(() => seal.unseal('signUp', sealed)).toThrow(EverIdSealError);
        expect(() => seal.unseal('connect', raw.toString('base64url'))).toThrow(EverIdSealError);
        expect(() => seal.unseal('connect', 'not-sealed')).toThrow(EverIdSealError);
        expect(() => seal.unseal('connect', undefined)).toThrow(EverIdSealError);
        expect(() => seal.unseal('connect', 'x'.repeat(EVER_ID_SEAL_MAX_LENGTH + 1))).toThrow(
            EverIdSealError,
        );
    });

    it('expires each kind after its TTL: txn and signUp 600 s, connect 300 s', () => {
        const seal = new ClockedSeal();
        const txn = seal.seal('txn', {});
        const connect = seal.seal('connect', {});

        clock += 299_000;
        expect(() => seal.unseal('connect', connect)).not.toThrow();
        clock += 2_000;
        expect(() => seal.unseal('connect', connect)).toThrow(EverIdSealError);
        expect(() => seal.unseal('txn', txn)).not.toThrow();
        clock += 300_000;
        expect(() => seal.unseal('txn', txn)).toThrow(EverIdSealError);
    });

    it('keeps a transaction with a 2,048-character return path under the cookie cap (NFR-6)', () => {
        const random = (bytes: number) => randomBytes(bytes).toString('base64url');
        const sealed = new ClockedSeal().seal('txn', {
            state: random(32),
            nonce: random(32),
            codeVerifier: random(48),
            intent: 'sign-in',
            // A return path with no repetition to compress away.
            returnTo: `/${random(1536).slice(0, 2047)}`,
        });
        expect(sealed.length).toBeLessThanOrEqual(EVER_ID_SEAL_MAX_LENGTH);
    });

    it('cannot be opened with a key derived from another secret', () => {
        const sealed = new ClockedSeal().seal('txn', { state: 's' });
        process.env.AUTH_SECRET = 'another-secret-that-is-long-enough-for-hkdf-9876';
        try {
            expect(() => new ClockedSeal().unseal('txn', sealed)).toThrow(EverIdSealError);
        } finally {
            process.env.AUTH_SECRET = 'a-test-secret-that-is-long-enough-for-hkdf-1234';
        }
    });
});
