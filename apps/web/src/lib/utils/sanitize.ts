/**
 * Frontend utility functions for sanitizing user input before sending to API.
 * These mirror the backend sanitization to provide immediate feedback and
 * prevent unnecessary API errors.
 */

export interface SanitizeTextOptions {
    /** Remove newlines and replace with space */
    removeNewlines?: boolean;
    /** Trim whitespace from start and end */
    trim?: boolean;
    /** Collapse multiple spaces into one */
    collapseSpaces?: boolean;
    /** Maximum length to truncate to */
    maxLength?: number;
    /** Remove control characters */
    removeControlChars?: boolean;
}

const DEFAULT_OPTIONS: SanitizeTextOptions = {
    removeNewlines: true,
    trim: true,
    collapseSpaces: true,
    removeControlChars: true,
};

/**
 * Sanitizes a text string by removing/replacing problematic characters.
 */
export function sanitizeText(
    text: string | undefined | null,
    options: SanitizeTextOptions = {},
): string {
    if (!text) {
        return '';
    }

    const opts = { ...DEFAULT_OPTIONS, ...options };
    let result = text;

    // Remove control characters (except newlines and tabs which we handle separately)
    if (opts.removeControlChars) {
        result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    }

    // Replace newlines with space
    if (opts.removeNewlines) {
        result = result.replace(/[\r\n]+/g, ' ');
    }

    // Collapse multiple spaces into one
    if (opts.collapseSpaces) {
        result = result.replace(/\s+/g, ' ');
    }

    // Trim whitespace
    if (opts.trim) {
        result = result.trim();
    }

    // Truncate if needed
    if (opts.maxLength && result.length > opts.maxLength) {
        result = result.substring(0, opts.maxLength).trim();
    }

    return result;
}

/**
 * Sanitizes a description field specifically for GitHub API.
 */
export function sanitizeDescription(
    description: string | undefined | null,
    maxLength = 500,
): string {
    return sanitizeText(description, {
        removeNewlines: true,
        trim: true,
        collapseSpaces: true,
        removeControlChars: true,
        maxLength,
    });
}

/**
 * Sanitizes a name field.
 */
export function sanitizeName(name: string | undefined | null, maxLength = 100): string {
    return sanitizeText(name, {
        removeNewlines: true,
        trim: true,
        collapseSpaces: true,
        removeControlChars: true,
        maxLength,
    });
}

/**
 * Sanitizes a prompt field. Prompts may contain intentional newlines.
 */
export function sanitizePrompt(prompt: string | undefined | null, maxLength = 5000): string {
    return sanitizeText(prompt, {
        removeNewlines: false,
        trim: true,
        collapseSpaces: false,
        removeControlChars: true,
        maxLength,
    });
}

/**
 * Sanitizes all string fields in an object recursively.
 */
export function sanitizeObject<T extends Record<string, unknown>>(
    obj: T,
    options: SanitizeTextOptions = DEFAULT_OPTIONS,
): T {
    if (!obj || typeof obj !== 'object') {
        return obj;
    }

    const result = { ...obj };

    for (const key of Object.keys(result)) {
        const value = result[key];

        if (typeof value === 'string') {
            (result as Record<string, unknown>)[key] = sanitizeText(value, options);
        } else if (Array.isArray(value)) {
            (result as Record<string, unknown>)[key] = value.map((item) => {
                if (typeof item === 'string') {
                    return sanitizeText(item, options);
                }
                if (item && typeof item === 'object') {
                    return sanitizeObject(item as Record<string, unknown>, options);
                }
                return item;
            });
        } else if (value && typeof value === 'object') {
            (result as Record<string, unknown>)[key] = sanitizeObject(
                value as Record<string, unknown>,
                options,
            );
        }
    }

    return result;
}

/**
 * Sanitizes string arrays by trimming values and removing empty strings.
 */
export function sanitizeStringArray(arr: string[] | undefined | null): string[] {
    if (!arr || !Array.isArray(arr)) {
        return [];
    }
    return arr.map((item) => sanitizeText(item)).filter((item) => item.length > 0);
}
