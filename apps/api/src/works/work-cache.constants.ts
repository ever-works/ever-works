export const WORK_CONFIG_CACHE_KEY_PREFIX = 'work-config-';
export const WORK_COUNT_CACHE_KEY_PREFIX = 'work-count-';
export const WORK_ITEMS_CACHE_KEY_PREFIX = 'work-items-';
export const WORK_CATEGORIES_TAGS_CACHE_KEY_PREFIX = 'work-categories-tags-';

export const WORK_CACHE_TTL_MS = 1000 * 60 * 10;

export const getWorkConfigCacheKey = (workId: string, userId: string) =>
    `${WORK_CONFIG_CACHE_KEY_PREFIX}${workId}-${userId}`;

export const getWorkCountCacheKey = (workId: string, userId: string) =>
    `${WORK_COUNT_CACHE_KEY_PREFIX}${workId}-${userId}`;

export const getWorkItemsCacheKey = (workId: string, userId: string) =>
    `${WORK_ITEMS_CACHE_KEY_PREFIX}${workId}-${userId}`;

export const getWorkCategoriesTagsCacheKey = (workId: string, userId: string) =>
    `${WORK_CATEGORIES_TAGS_CACHE_KEY_PREFIX}${workId}-${userId}`;
