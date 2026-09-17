import { isCredentialFault } from '../agent-halt-classifier';

/**
 * The classifier decides whether an agent halts after ONE failure instead
 * of three, so its bias matters more than its recall: a miss costs the
 * ordinary three-strike path, a false positive stops a healthy agent.
 */
describe('isCredentialFault', () => {
    it('treats 401 and 403 as a rejected credential', () => {
        expect(isCredentialFault({ statusCode: 401 })).toBe(true);
        expect(isCredentialFault({ statusCode: 403 })).toBe(true);
    });

    it('recognises provider-agnostic authentication phrases', () => {
        for (const message of [
            'Invalid API key provided',
            'Authentication failed for this account',
            'The access token has expired',
            'Unauthorized',
            'This credential was revoked',
        ]) {
            expect(isCredentialFault({ errorMessage: message })).toBe(true);
        }
    });

    it('defaults to false — an ordinary failure takes the ordinary path', () => {
        expect(isCredentialFault({})).toBe(false);
        expect(isCredentialFault({ statusCode: 500 })).toBe(false);
        expect(isCredentialFault({ errorMessage: 'ECONNRESET talking to the runtime' })).toBe(
            false,
        );
        expect(isCredentialFault({ statusCode: 404, errorMessage: 'model not found' })).toBe(false);
    });

    it('refuses to call a rate limit, a quota or a billing stop a credential fault', () => {
        // All three legitimately arrive as 429 — and some providers send
        // 403 for a spent quota. Halting the agent for a dead token would
        // be the wrong story and the wrong fix.
        expect(isCredentialFault({ statusCode: 429, errorMessage: 'Rate limit reached' })).toBe(
            false,
        );
        expect(isCredentialFault({ statusCode: 403, errorMessage: 'Quota exceeded' })).toBe(false);
        expect(
            isCredentialFault({ statusCode: 403, errorMessage: 'insufficient_quota for billing' }),
        ).toBe(false);
    });

    it('returns a boolean and nothing else, so a token in the message cannot leak', () => {
        const leaky = 'Invalid API key: sk-live-0123456789abcdef0123456789abcdef';
        const verdict = isCredentialFault({ statusCode: 401, errorMessage: leaky });
        expect(verdict).toBe(true);
        expect(typeof verdict).toBe('boolean');
        expect(JSON.stringify(verdict)).not.toContain('sk-live');
    });

    it('is case-insensitive and tolerates a null message', () => {
        expect(isCredentialFault({ errorMessage: 'INVALID AUTHENTICATION' })).toBe(true);
        expect(isCredentialFault({ errorMessage: null, statusCode: null })).toBe(false);
    });
});
