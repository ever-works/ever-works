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
});
