import { computeGitHubSignature, verifyGitHubSignature } from './github-signature.util';

const SECRET = 'test-webhook-secret';
const BODY = JSON.stringify({ action: 'opened', number: 7 });

describe('verifyGitHubSignature', () => {
    it('accepts a correctly signed delivery', () => {
        const signature = computeGitHubSignature(SECRET, BODY);
        const verdict = verifyGitHubSignature({
            rawBody: BODY,
            signature,
            webhookSecret: SECRET,
        });
        expect(verdict).toEqual({ valid: true });
    });

    it('fails closed when no webhook secret is configured', () => {
        const signature = computeGitHubSignature(SECRET, BODY);
        expect(
            verifyGitHubSignature({ rawBody: BODY, signature, webhookSecret: undefined }),
        ).toEqual({ valid: false, reason: 'missing-webhook-secret' });
        expect(verifyGitHubSignature({ rawBody: BODY, signature, webhookSecret: '' })).toEqual({
            valid: false,
            reason: 'missing-webhook-secret',
        });
    });

    it('rejects a missing signature header', () => {
        expect(
            verifyGitHubSignature({ rawBody: BODY, signature: undefined, webhookSecret: SECRET }),
        ).toEqual({ valid: false, reason: 'missing-signature' });
    });

    it('rejects a tampered body (digest mismatch)', () => {
        const signature = computeGitHubSignature(SECRET, BODY);
        const verdict = verifyGitHubSignature({
            rawBody: `${BODY} `,
            signature,
            webhookSecret: SECRET,
        });
        expect(verdict).toEqual({ valid: false, reason: 'signature-mismatch' });
    });

    it('rejects a signature of the wrong length without throwing', () => {
        const verdict = verifyGitHubSignature({
            rawBody: BODY,
            signature: 'sha256=deadbeef',
            webhookSecret: SECRET,
        });
        expect(verdict).toEqual({ valid: false, reason: 'signature-mismatch' });
    });

    it('rejects a signature computed with a different secret', () => {
        const signature = computeGitHubSignature('other-secret', BODY);
        const verdict = verifyGitHubSignature({
            rawBody: BODY,
            signature,
            webhookSecret: SECRET,
        });
        expect(verdict).toEqual({ valid: false, reason: 'signature-mismatch' });
    });
});
