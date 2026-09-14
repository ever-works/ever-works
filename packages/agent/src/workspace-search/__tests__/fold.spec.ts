import { fold } from '../fold';

describe('workspace-search fold()', () => {
    it.each([
        ['Invoice', 'invoice'],
        ['  Padded  ', 'padded'],
        ['Café Crème', 'cafe creme'],
        ['ÀÉÎÕÜ ñ ç', 'aeiou n c'],
        ['Straße', 'straße'],
    ])('folds %j to %j', (input, expected) => {
        expect(fold(input)).toBe(expected);
    });

    it('passes non-Latin scripts through apart from lower-casing', () => {
        expect(fold('Привет')).toBe('привет');
        expect(fold('日本語')).toBe('日本語');
        expect(fold('مرحبا')).toBe('مرحبا');
    });

    it.each([[''], ['   '], [null], [undefined]])('returns an empty string for %j', (input) => {
        expect(fold(input as string | null | undefined)).toBe('');
    });
});
