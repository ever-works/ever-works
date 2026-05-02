import {
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
    });
});
