import {
    buildCaseInsensitiveEqualsClause,
    buildCaseInsensitiveLikeClause,
    prepareCaseInsensitiveContainsPattern,
    prepareLikeSearchTerm,
} from './db.utils';

describe('db.utils', () => {
    describe('prepareLikeSearchTerm', () => {
        it('escapes LIKE wildcard characters', () => {
            expect(prepareLikeSearchTerm('100%_match\\test')).toBe('100\\%\\_match\\\\test');
        });

        it('returns undefined for empty input', () => {
            expect(prepareLikeSearchTerm('   ')).toBeUndefined();
        });
    });

    describe('prepareCaseInsensitiveContainsPattern', () => {
        it('wraps the sanitized value for case-insensitive contains search', () => {
            expect(prepareCaseInsensitiveContainsPattern('Hello%_World')).toBe(
                '%hello\\%\\_world%',
            );
        });
    });

    describe('buildCaseInsensitiveLikeClause', () => {
        it('includes an explicit ESCAPE clause for portable LIKE behavior', () => {
            expect(buildCaseInsensitiveLikeClause('work.name')).toBe(
                "LOWER(work.name) LIKE :search ESCAPE '\\'",
            );
        });

        it('rejects a column expression that is not a trusted identifier', () => {
            expect(() => buildCaseInsensitiveLikeClause('work.name) OR (1=1')).toThrow(
                /buildCaseInsensitiveLikeClause: columnExpression must be a trusted SQL identifier/,
            );
        });
    });

    describe('buildCaseInsensitiveEqualsClause', () => {
        it('compares the lower-cased column with the named parameter', () => {
            expect(buildCaseInsensitiveEqualsClause('work.slug', 'exact')).toBe(
                'LOWER(work.slug) = :exact',
            );
        });

        it('rejects a column expression that is not a trusted identifier', () => {
            expect(() => buildCaseInsensitiveEqualsClause("work.slug = '' OR 1")).toThrow(
                /buildCaseInsensitiveEqualsClause: columnExpression must be a trusted SQL identifier/,
            );
        });
    });
});
