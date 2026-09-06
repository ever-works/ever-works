import { computeJiraSignature, verifyJiraSignature } from './jira-signature.util';

const SECRET = 'jira-webhook-secret';
const BODY = JSON.stringify({ webhookEvent: 'jira:issue_created', issue: { id: '10001' } });

/**
 * Jira Cloud signs `sha256=HEX(HMAC_SHA256(secret, rawBody))` into
 * `X-Hub-Signature` — but ONLY for webhooks created with a secret. Every
 * degenerate input below (including the secret-less legacy webhook that
 * sends no header at all) must fail closed.
 */
describe('verifyJiraSignature', () => {
    it('accepts a correctly signed delivery', () => {
        const signature = computeJiraSignature(SECRET, BODY);
        expect(verifyJiraSignature({ rawBody: BODY, signature, webhookSecret: SECRET })).toEqual({
            valid: true,
        });
    });

    it('fails closed when no webhook secret is configured', () => {
        const signature = computeJiraSignature(SECRET, BODY);
        expect(verifyJiraSignature({ rawBody: BODY, signature, webhookSecret: undefined })).toEqual(
            { valid: false, reason: 'missing-webhook-secret' },
        );
        expect(verifyJiraSignature({ rawBody: BODY, signature, webhookSecret: '' })).toEqual({
            valid: false,
            reason: 'missing-webhook-secret',
        });
    });

    it('rejects an unsigned delivery (a webhook created without a secret sends no header)', () => {
        expect(
            verifyJiraSignature({ rawBody: BODY, signature: undefined, webhookSecret: SECRET }),
        ).toEqual({ valid: false, reason: 'missing-signature' });
    });

    it('rejects a tampered body (digest mismatch)', () => {
        const signature = computeJiraSignature(SECRET, BODY);
        expect(
            verifyJiraSignature({ rawBody: `${BODY} `, signature, webhookSecret: SECRET }),
        ).toEqual({ valid: false, reason: 'signature-mismatch' });
    });

    it('rejects a signature of the wrong length without throwing', () => {
        expect(
            verifyJiraSignature({
                rawBody: BODY,
                signature: 'sha256=deadbeef',
                webhookSecret: SECRET,
            }),
        ).toEqual({ valid: false, reason: 'signature-mismatch' });
    });

    it('rejects a signature computed with a different secret', () => {
        const signature = computeJiraSignature('other-secret', BODY);
        expect(verifyJiraSignature({ rawBody: BODY, signature, webhookSecret: SECRET })).toEqual({
            valid: false,
            reason: 'signature-mismatch',
        });
    });

    it('rejects a bare hex digest without the `sha256=` prefix Jira always sends', () => {
        const signature = computeJiraSignature(SECRET, BODY).slice('sha256='.length);
        expect(verifyJiraSignature({ rawBody: BODY, signature, webhookSecret: SECRET })).toEqual({
            valid: false,
            reason: 'signature-mismatch',
        });
    });
});
