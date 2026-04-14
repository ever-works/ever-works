export const DIRECTORY_CONFIG_CACHE_KEY_PREFIX = 'directory-config-';
export const DIRECTORY_COUNT_CACHE_KEY_PREFIX = 'directory-count-';
export const DIRECTORY_ITEMS_CACHE_KEY_PREFIX = 'directory-items-';
export const DIRECTORY_CATEGORIES_TAGS_CACHE_KEY_PREFIX = 'directory-categories-tags-';

export const DIRECTORY_CACHE_TTL_MS = 1000 * 60 * 10;

export const getDirectoryConfigCacheKey = (directoryId: string, userId: string) =>
    `${DIRECTORY_CONFIG_CACHE_KEY_PREFIX}${directoryId}-${userId}`;

export const getDirectoryCountCacheKey = (directoryId: string, userId: string) =>
    `${DIRECTORY_COUNT_CACHE_KEY_PREFIX}${directoryId}-${userId}`;

export const getDirectoryItemsCacheKey = (directoryId: string, userId: string) =>
    `${DIRECTORY_ITEMS_CACHE_KEY_PREFIX}${directoryId}-${userId}`;

export const getDirectoryCategoriesTagsCacheKey = (directoryId: string, userId: string) =>
    `${DIRECTORY_CATEGORIES_TAGS_CACHE_KEY_PREFIX}${directoryId}-${userId}`;
