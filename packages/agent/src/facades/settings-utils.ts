import { Logger } from '@nestjs/common';

/**
 * Expected JavaScript types for settings validation
 */
export type ExpectedSettingType = 'string' | 'number' | 'boolean' | 'object' | 'array';

/**
 * Get a setting value with type validation at runtime.
 * Returns undefined if the value doesn't exist or doesn't match the expected type.
 *
 * @param settings - The settings object to read from
 * @param key - The setting key to retrieve
 * @param expectedType - The expected JavaScript type
 * @param logger - Optional logger for warnings
 * @returns The typed value or undefined if not found or wrong type
 */
export function getSettingTyped<T>(
    settings: Record<string, unknown>,
    key: string,
    expectedType: ExpectedSettingType,
    logger?: Logger,
): T | undefined {
    const value = settings[key];

    if (value === undefined || value === null) {
        return undefined;
    }

    const actualType = Array.isArray(value) ? 'array' : typeof value;

    if (actualType !== expectedType) {
        logger?.warn(`Setting '${key}' has type '${actualType}', expected '${expectedType}'`);
        return undefined;
    }

    return value as T;
}

/**
 * Get a setting value with a default fallback.
 * Returns the default if the value doesn't exist or doesn't match the expected type.
 *
 * @param settings - The settings object to read from
 * @param key - The setting key to retrieve
 * @param expectedType - The expected JavaScript type
 * @param defaultValue - The default value to return if not found
 * @param logger - Optional logger for warnings
 * @returns The typed value or the default
 */
export function getSettingWithDefault<T>(
    settings: Record<string, unknown>,
    key: string,
    expectedType: ExpectedSettingType,
    defaultValue: T,
    logger?: Logger,
): T {
    const value = getSettingTyped<T>(settings, key, expectedType, logger);
    return value ?? defaultValue;
}
