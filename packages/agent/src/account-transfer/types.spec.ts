import {
    MASKED_SECRET_PREFIX,
    maskSecretValue,
    maskSecretSettings,
    containsMaskedSecrets,
} from './types';

/**
 * Pins the pure helpers exposed by `account-transfer/types.ts`. They are the
 * security boundary that keeps real credentials out of every export payload
 * (the file name lies a little — these functions ship at runtime alongside
 * the type definitions). The masking shape MUST stay stable: changing the
 * prefix would break GitHub-sync round-trip detection on the import side
 * (`containsMaskedSecrets` short-circuits on this exact string).
 */
describe('account-transfer/types — secret-masking helpers', () => {
    describe('MASKED_SECRET_PREFIX constant', () => {
        it('is the literal "MASKED:" string (wire-format-stable)', () => {
            expect(MASKED_SECRET_PREFIX).toBe('MASKED:');
        });
    });

    describe('maskSecretValue', () => {
        it('returns 8-asterisk fully-masked output for non-string input', () => {
            expect(maskSecretValue(undefined)).toBe('MASKED:********');
            expect(maskSecretValue(null)).toBe('MASKED:********');
            expect(maskSecretValue(123)).toBe('MASKED:********');
            expect(maskSecretValue({})).toBe('MASKED:********');
            expect(maskSecretValue([])).toBe('MASKED:********');
            expect(maskSecretValue(true)).toBe('MASKED:********');
        });

        it('returns 8-asterisk fully-masked output for empty string', () => {
            expect(maskSecretValue('')).toBe('MASKED:********');
        });

        it('returns fully-masked output for strings of length <= 8 (boundary)', () => {
            // Boundary: length 8 is treated as short and fully masked
            expect(maskSecretValue('abcdefgh')).toBe('MASKED:********');
            expect(maskSecretValue('a')).toBe('MASKED:********');
            expect(maskSecretValue('1234567')).toBe('MASKED:********');
        });

        it('shows the first 3 + last 4 characters separated by `***` for strings > 8 chars', () => {
            expect(maskSecretValue('sk-abcdefghij1234')).toBe('MASKED:sk-***1234');
        });

        it('handles minimum length-9 case (length 9 → first 3 + last 4 + middle hidden by ***)', () => {
            expect(maskSecretValue('123456789')).toBe('MASKED:123***6789');
        });

        it('preserves prefixes/suffixes verbatim regardless of payload (no escaping/transforming)', () => {
            // 'xoxb-token-with-dashes' is 22 chars; slice(0,3)='xox', slice(-4)='shes'
            expect(maskSecretValue('xoxb-token-with-dashes')).toBe('MASKED:xox***shes');
        });
    });

    describe('maskSecretSettings', () => {
        it('returns {} when settings is null', () => {
            expect(maskSecretSettings(null)).toEqual({});
        });

        it('returns {} when settings is undefined', () => {
            expect(maskSecretSettings(undefined)).toEqual({});
        });

        it('returns {} when given a non-object scalar (defensive coercion)', () => {
            // Type system blocks this, but the runtime check protects against
            // accidentally-passed JSON.parse output of a non-object.
            expect(maskSecretSettings('foo' as any)).toEqual({});
            expect(maskSecretSettings(42 as any)).toEqual({});
        });

        it('preserves keys but replaces every value with its masked representation', () => {
            const masked = maskSecretSettings({
                apiKey: 'sk-prod-XXXXXXX1234',
                token: 'short',
                empty: '',
                blob: { ignored: true },
            });
            expect(masked).toEqual({
                apiKey: 'MASKED:sk-***1234',
                token: 'MASKED:********',
                empty: 'MASKED:********',
                blob: 'MASKED:********',
            });
        });

        it('returns an empty object when given an empty object input', () => {
            expect(maskSecretSettings({})).toEqual({});
        });

        it('does not mutate the input object', () => {
            const input = { apiKey: 'sk-abcdefghij1234' };
            const inputClone = { ...input };
            maskSecretSettings(input);
            expect(input).toEqual(inputClone);
        });
    });

    describe('containsMaskedSecrets', () => {
        it('returns false when settings is null/undefined', () => {
            expect(containsMaskedSecrets(null)).toBe(false);
            expect(containsMaskedSecrets(undefined)).toBe(false);
        });

        it('returns false when given non-object scalar (defensive)', () => {
            expect(containsMaskedSecrets('foo' as any)).toBe(false);
        });

        it('returns false for empty object', () => {
            expect(containsMaskedSecrets({})).toBe(false);
        });

        it('returns true when ANY value starts with the prefix', () => {
            expect(
                containsMaskedSecrets({
                    apiKey: 'sk-real-key',
                    token: 'MASKED:abc***1234',
                }),
            ).toBe(true);
        });

        it('returns false when all values are real (no prefix match)', () => {
            expect(
                containsMaskedSecrets({
                    apiKey: 'sk-real-key',
                    token: 'real-token',
                }),
            ).toBe(false);
        });

        it('returns false when a value just contains the prefix substring (NOT startsWith)', () => {
            expect(
                containsMaskedSecrets({
                    apiKey: 'foo MASKED: bar',
                }),
            ).toBe(false);
        });

        it('returns false when values are non-string types (numbers/objects/booleans)', () => {
            expect(
                containsMaskedSecrets({
                    age: 12,
                    active: true,
                    nested: { x: 1 },
                }),
            ).toBe(false);
        });

        it('round-trip: maskSecretSettings output is always detected by containsMaskedSecrets', () => {
            const masked = maskSecretSettings({
                apiKey: 'sk-prod-XXXX1234',
                token: 'short',
            });
            expect(containsMaskedSecrets(masked)).toBe(true);
        });
    });
});
