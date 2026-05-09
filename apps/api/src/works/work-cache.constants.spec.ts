import {
    WORK_CONFIG_CACHE_KEY_PREFIX,
    WORK_COUNT_CACHE_KEY_PREFIX,
    WORK_ITEMS_CACHE_KEY_PREFIX,
    WORK_CATEGORIES_TAGS_CACHE_KEY_PREFIX,
    WORK_CACHE_TTL_MS,
    getWorkConfigCacheKey,
    getWorkCountCacheKey,
    getWorkItemsCacheKey,
    getWorkCategoriesTagsCacheKey,
} from './work-cache.constants';

describe('work-cache.constants', () => {
    describe('cache-key prefixes', () => {
        it('pins the four documented prefixes literally', () => {
            // These prefixes are referenced from `cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike`
            // for cache invalidation; renaming any of them silently breaks invalidation across the
            // updateWebsiteSettings / works-controller flows. Pin the literal values here so a future
            // rename has to be a deliberate update of both the source and this test.
            expect(WORK_CONFIG_CACHE_KEY_PREFIX).toBe('work-config-');
            expect(WORK_COUNT_CACHE_KEY_PREFIX).toBe('work-count-');
            expect(WORK_ITEMS_CACHE_KEY_PREFIX).toBe('work-items-');
            expect(WORK_CATEGORIES_TAGS_CACHE_KEY_PREFIX).toBe('work-categories-tags-');
        });

        it('every prefix ends with a single trailing dash so id concatenation is unambiguous', () => {
            for (const prefix of [
                WORK_CONFIG_CACHE_KEY_PREFIX,
                WORK_COUNT_CACHE_KEY_PREFIX,
                WORK_ITEMS_CACHE_KEY_PREFIX,
                WORK_CATEGORIES_TAGS_CACHE_KEY_PREFIX,
            ]) {
                expect(prefix.endsWith('-')).toBe(true);
                expect(prefix.endsWith('--')).toBe(false);
            }
        });

        it('all four prefixes are mutually distinct', () => {
            const prefixes = new Set([
                WORK_CONFIG_CACHE_KEY_PREFIX,
                WORK_COUNT_CACHE_KEY_PREFIX,
                WORK_ITEMS_CACHE_KEY_PREFIX,
                WORK_CATEGORIES_TAGS_CACHE_KEY_PREFIX,
            ]);
            expect(prefixes.size).toBe(4);
        });
    });

    describe('WORK_CACHE_TTL_MS', () => {
        it('is exactly 10 minutes in milliseconds', () => {
            expect(WORK_CACHE_TTL_MS).toBe(1000 * 60 * 10);
            expect(WORK_CACHE_TTL_MS).toBe(600_000);
        });

        it('is a positive integer (no fractional ms)', () => {
            expect(Number.isInteger(WORK_CACHE_TTL_MS)).toBe(true);
            expect(WORK_CACHE_TTL_MS).toBeGreaterThan(0);
        });
    });

    describe('getWorkConfigCacheKey', () => {
        it('produces "<prefix><workId>-<userId>" verbatim', () => {
            expect(getWorkConfigCacheKey('w1', 'u1')).toBe('work-config-w1-u1');
        });

        it('does not URL-encode or escape special characters in workId/userId (caller responsibility)', () => {
            expect(getWorkConfigCacheKey('a/b', 'c d')).toBe('work-config-a/b-c d');
        });

        it('handles empty strings without throwing', () => {
            expect(getWorkConfigCacheKey('', '')).toBe('work-config--');
        });

        it('starts with WORK_CONFIG_CACHE_KEY_PREFIX so prefix-based invalidation matches', () => {
            const key = getWorkConfigCacheKey('w', 'u');
            expect(key.startsWith(WORK_CONFIG_CACHE_KEY_PREFIX)).toBe(true);
        });
    });

    describe('getWorkCountCacheKey', () => {
        it('produces "<prefix><workId>-<userId>" verbatim', () => {
            expect(getWorkCountCacheKey('work-1', 'user-1')).toBe('work-count-work-1-user-1');
        });

        it('starts with WORK_COUNT_CACHE_KEY_PREFIX', () => {
            expect(getWorkCountCacheKey('w', 'u').startsWith(WORK_COUNT_CACHE_KEY_PREFIX)).toBe(true);
        });
    });

    describe('getWorkItemsCacheKey', () => {
        it('produces "<prefix><workId>-<userId>" verbatim', () => {
            expect(getWorkItemsCacheKey('w', 'u')).toBe('work-items-w-u');
        });

        it('starts with WORK_ITEMS_CACHE_KEY_PREFIX', () => {
            expect(getWorkItemsCacheKey('w', 'u').startsWith(WORK_ITEMS_CACHE_KEY_PREFIX)).toBe(true);
        });
    });

    describe('getWorkCategoriesTagsCacheKey', () => {
        it('produces "<prefix><workId>-<userId>" verbatim', () => {
            expect(getWorkCategoriesTagsCacheKey('w', 'u')).toBe('work-categories-tags-w-u');
        });

        it('starts with WORK_CATEGORIES_TAGS_CACHE_KEY_PREFIX', () => {
            expect(
                getWorkCategoriesTagsCacheKey('w', 'u').startsWith(WORK_CATEGORIES_TAGS_CACHE_KEY_PREFIX),
            ).toBe(true);
        });
    });

    describe('cross-builder invariants', () => {
        it('different workIds produce different keys for the same user (no collision)', () => {
            const a = getWorkConfigCacheKey('w1', 'u1');
            const b = getWorkConfigCacheKey('w2', 'u1');
            expect(a).not.toBe(b);
        });

        it('different userIds produce different keys for the same work (no per-user cross-leak)', () => {
            const a = getWorkConfigCacheKey('w1', 'u1');
            const b = getWorkConfigCacheKey('w1', 'u2');
            expect(a).not.toBe(b);
        });

        it('all four builders produce mutually distinct keys for the same (workId, userId)', () => {
            const ids = ['w1', 'u1'] as const;
            const keys = new Set([
                getWorkConfigCacheKey(...ids),
                getWorkCountCacheKey(...ids),
                getWorkItemsCacheKey(...ids),
                getWorkCategoriesTagsCacheKey(...ids),
            ]);
            expect(keys.size).toBe(4);
        });
    });
});
