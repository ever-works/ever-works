/**
 * Utility functions for sanitizing user input before processing.
 * Used to clean up fields before sending to external APIs (GitHub, etc.)
 * and to prevent injection attacks.
 *
 * **Pick-the-right-function cheat sheet:**
 *
 *   - {@link sanitizeText} — generic; default is aggressive (strips
 *     newlines, collapses whitespace). Use for short freeform text.
 *   - {@link sanitizeDescription} — short single-line strings bound
 *     for external APIs (GitHub repo description, commit titles).
 *     500 char cap.
 *   - {@link sanitizeName} — same as description but for short
 *     identifying labels. 100 char cap.
 *   - {@link sanitizePrompt} — **preserves** newlines and whitespace.
 *     LLM prompts depend on formatting; the aggressive defaults
 *     would mangle them. 5000 char cap.
 *   - {@link sanitizeStringArray} — trims + drops empty entries.
 *
 * **What's NOT removed:** the control-char regex covers `\x00-\x1F`
 * + `\x7F` (DEL) but NOT the C1 control range (`\x80-\x9F`) where
 * Windows-1252 hides smart quotes and other "printable" extended
 * chars. Those survive intentionally so user-typed curly quotes etc.
 * pass through.
 *
 * **`sanitizeStringTransform` lies about types** — for non-string
 * inputs it returns the input unchanged but casts to `string`. If
 * the caller passes a number, the return is typed `string` but is
 * actually a number at runtime. Only safe in class-transformer
 * contexts where the field is typed string upstream.
 */

/**
 * Options for sanitizing text strings
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
 * This is useful for fields that will be sent to external APIs like GitHub.
 *
 * @param text - The text to sanitize
 * @param options - Sanitization options
 * @returns The sanitized text
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
        // Remove control chars except \n, \r, \t
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
 * GitHub descriptions should be a single line without newlines.
 *
 * @param description - The description to sanitize
 * @param maxLength - Maximum length (GitHub limit is 350 chars, but we use 500 as a safe default)
 * @returns The sanitized description
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
 *
 * @param name - The name to sanitize
 * @param maxLength - Maximum length
 * @returns The sanitized name
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
 * Sanitizes a prompt field. Prompts may contain intentional newlines
 * for formatting, so we're less aggressive here.
 *
 * @param prompt - The prompt to sanitize
 * @param maxLength - Maximum length
 * @returns The sanitized prompt
 */
export function sanitizePrompt(prompt: string | undefined | null, maxLength = 5000): string {
    return sanitizeText(prompt, {
        removeNewlines: false, // Prompts can have newlines
        trim: true,
        collapseSpaces: false, // Preserve formatting in prompts
        removeControlChars: true,
        maxLength,
    });
}

/**
 * Sanitizes all string fields in an object recursively.
 * Useful for sanitizing entire DTOs.
 *
 * @param obj - The object to sanitize
 * @param options - Sanitization options
 * @returns A new object with sanitized string fields
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
 * Creates a Transform decorator function for class-transformer
 * that sanitizes string fields automatically.
 *
 * Usage with class-transformer:
 * @Transform(({ value }) => sanitizeStringTransform(value))
 */
export function sanitizeStringTransform(value: unknown): string {
    if (typeof value === 'string') {
        return sanitizeText(value);
    }
    return value as string;
}

/**
 * Creates a Transform decorator function specifically for descriptions.
 */
export function sanitizeDescriptionTransform(value: unknown): string {
    if (typeof value === 'string') {
        return sanitizeDescription(value);
    }
    return value as string;
}

/**
 * Sanitizes string arrays by trimming values and removing empty strings.
 *
 * @param arr - The array to sanitize
 * @returns Sanitized array with trimmed, non-empty strings
 */
export function sanitizeStringArray(arr: string[] | undefined | null): string[] {
    if (!arr || !Array.isArray(arr)) {
        return [];
    }
    return arr.map((item) => sanitizeText(item)).filter((item) => item.length > 0);
}
