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

    // CodeQL js/polynomial-redos: the credential pattern used to start with a
    // scheme `[a-z][a-z0-9+.-]*` that was retried from every offset of a long
    // run of scheme characters — about 2.8 s for 50,000 `a`s on a dev box —
    // and the message is upstream text (git / provider errors).
    // Sized, not tightly timed: at 200,000 characters the old pattern needs
    // ~45 s on a dev box and the `://`-anchored pass milliseconds, so a 2 s
    // bound can be failed neither by a CPU-throttled CI runner nor passed by
    // the old pattern. (A "< 200 ms" at 50,000 was one scheduler stall from
    // red — develop CI, 2026-10-09.)
    it('redacts a long run of scheme characters in linear time', () => {
        const error = new Error('a'.repeat(200_000));

        const started = performance.now();
        const result = normalizeGeneratorError(error);
        const elapsedMs = performance.now() - started;

        expect(result).toBe('a'.repeat(200_000));
        expect(elapsedMs).toBeLessThan(2_000);
    });

    // Recorded from the regex this replaced: the same URLs are redacted, the
    // same near-misses are left alone.
    it.each<[string, string]>([
        ['fatal: https://u:p@h/x', 'fatal: https://***:***@h/x'],
        ['1https://u:p@h', '1https://***:***@h'],
        ['git+ssh://user:tok@github.com/x', 'git+ssh://***:***@github.com/x'],
        ['x://a:b://c:d@x', 'x://a:b://***:***@x'],
        ['HTTPS://U:P@H', 'HTTPS://***:***@H'],
        ['http://u:p:q@h', 'http://***:***@h'],
        ['http://@h', 'http://@h'],
        ['http://u:@h', 'http://u:@h'],
        [' ://u:p@h', ' ://u:p@h'],
        ['-://u:p@h', '-://u:p@h'],
        ['1-2://u:p@h', '1-2://u:p@h'],
        ['a.b-c+d://u:p@h', 'a.b-c+d://***:***@h'],
        ['http://u:p@h and ftp://v:q@i', 'http://***:***@h and ftp://***:***@i'],
        ['http://u:p/x@h', 'http://u:p/x@h'],
        ['http://u:p@h@i', 'http://***:***@h@i'],
        ['http://u p:q@h', 'http://u p:q@h'],
        ['redis://:pass@host', 'redis://:pass@host'],
        ['9a://u:p@h', '9a://***:***@h'],
        ['é://u:p@h', 'é://u:p@h'],
        ['aé://u:p@h', 'aé://u:p@h'],
    ])('redacts %p as %p', (message, redacted) => {
        expect(normalizeGeneratorError(new Error(message))).toBe(redacted);
    });

    it('returns a clean message unchanged', () => {
        const error = new Error('Something unexpected happened while building the page');

        expect(normalizeGeneratorError(error)).toBe(
            'Something unexpected happened while building the page',
        );
    });
});
