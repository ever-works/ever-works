import { computeSentrySignature, verifySentrySignature } from './sentry-signature.util';

const SECRET = 'sentry-integration-client-secret';
const BODY = JSON.stringify({ action: 'created', installation: { uuid: 'abc' } });

/**
 * Sentry signs with the integration client secret over the RAW body and
 * ships a bare hex digest. Every degenerate input below must fail
 * closed — a delivery that cannot be verified with Sentry's own scheme
 * files nothing.
 */
describe('verifySentrySignature', () => {
    it('accepts a correctly signed delivery', () => {
        const signature = computeSentrySignature(SECRET, BODY);
        expect(verifySentrySignature({ rawBody: BODY, signature, clientSecret: SECRET })).toEqual({
            valid: true,
        });
    });

    it('fails closed when no client secret is configured', () => {
        const signature = computeSentrySignature(SECRET, BODY);
        expect(
            verifySentrySignature({ rawBody: BODY, signature, clientSecret: undefined }),
        ).toEqual({ valid: false, reason: 'missing-client-secret' });
        expect(verifySentrySignature({ rawBody: BODY, signature, clientSecret: '' })).toEqual({
            valid: false,
            reason: 'missing-client-secret',
        });
    });

    it('rejects a missing signature header', () => {
        expect(
            verifySentrySignature({ rawBody: BODY, signature: undefined, clientSecret: SECRET }),
        ).toEqual({ valid: false, reason: 'missing-signature' });
        expect(
            verifySentrySignature({ rawBody: BODY, signature: '', clientSecret: SECRET }),
        ).toEqual({ valid: false, reason: 'missing-signature' });
    });

    it('rejects a tampered body (digest mismatch)', () => {
        const signature = computeSentrySignature(SECRET, BODY);
        expect(
            verifySentrySignature({ rawBody: `${BODY} `, signature, clientSecret: SECRET }),
        ).toEqual({ valid: false, reason: 'signature-mismatch' });
    });

    it('rejects a signature of the wrong length without throwing', () => {
        expect(
            verifySentrySignature({ rawBody: BODY, signature: 'deadbeef', clientSecret: SECRET }),
        ).toEqual({ valid: false, reason: 'signature-mismatch' });
    });

    it('rejects a signature computed with a different secret', () => {
        const signature = computeSentrySignature('some-other-secret', BODY);
        expect(verifySentrySignature({ rawBody: BODY, signature, clientSecret: SECRET })).toEqual({
            valid: false,
            reason: 'signature-mismatch',
        });
    });

    it('rejects a GitHub-style `sha256=` prefixed digest — Sentry ships a bare hex digest', () => {
        const signature = `sha256=${computeSentrySignature(SECRET, BODY)}`;
        expect(verifySentrySignature({ rawBody: BODY, signature, clientSecret: SECRET })).toEqual({
            valid: false,
            reason: 'signature-mismatch',
        });
    });

    it('is a bare lowercase hex digest, no prefix', () => {
        expect(computeSentrySignature(SECRET, BODY)).toMatch(/^[0-9a-f]{64}$/);
    });
});
