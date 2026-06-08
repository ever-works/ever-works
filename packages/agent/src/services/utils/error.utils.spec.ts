import { normalizeGeneratorError } from './error.utils';

describe('normalizeGeneratorError', () => {
    it('includes nested cause messages for wrapped generator errors', () => {
        const error = new Error('Failed to complete data repository initialization') as Error & {
            cause?: Error;
        };
        error.cause = new Error('Git clone failed with unexpected EOF');

        expect(normalizeGeneratorError(error)).toBe(
            'Failed to complete data repository initialization: Git clone failed with unexpected EOF',
        );
    });

    it('still maps nested not found errors to the repository-friendly message', () => {
        const error = new Error('Failed to complete data repository initialization') as Error & {
            cause?: Error;
        };
        error.cause = new Error('HTTP Error: 404 Not Found');

        expect(normalizeGeneratorError(error)).toBe(
            'Repository not found. Please verify the repository exists and try again.',
        );
    });

    it('maps missing connected git accounts to a reconnect message', () => {
        const error = new Error(
            'No connected account found for user user-123 with provider github',
        );

        expect(normalizeGeneratorError(error)).toBe(
            'Please reconnect your Git account to continue.',
        );
    });

    it('redacts credentials embedded in a URL in the returned detailed message', () => {
        const error = new Error('Failed to clone repository') as Error & { cause?: Error };
        error.cause = new Error('fatal: unable to access https://u:secret@host/x.git');

        const result = normalizeGeneratorError(error);

        // The userinfo (user:pass) is replaced with ***:*** and the raw token is gone.
        expect(result).toContain('https://***:***@host/x.git');
        expect(result).not.toContain('secret');
        expect(result).not.toContain('u:secret');
        // The non-credential parts of the message are preserved.
        expect(result).toContain('Failed to clone repository');
        expect(result).toContain('fatal: unable to access');
    });

    it('redacts a standalone GitHub token in the returned message', () => {
        const token = `ghp_${'A'.repeat(36)}`;
        const error = new Error(`git push rejected using token ${token}`);

        const result = normalizeGeneratorError(error);

        expect(result).not.toContain(token);
        expect(result).toContain('git push rejected using token');
    });

    it('returns a clean message unchanged', () => {
        const error = new Error('Something unexpected happened while building the page');

        expect(normalizeGeneratorError(error)).toBe(
            'Something unexpected happened while building the page',
        );
    });
});
