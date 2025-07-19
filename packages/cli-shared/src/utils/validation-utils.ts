/**
 * Validates URL format
 */
export function validateUrl(url: string): { isValid: boolean; error?: string } {
    try {
        new URL(url);
        return { isValid: true };
    } catch {
        return { isValid: false, error: 'Please enter a valid URL (e.g., https://example.com)' };
    }
}

/**
 * Validates email format
 */
export function validateEmail(email: string): { isValid: boolean; error?: string } {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return { isValid: false, error: 'Please enter a valid email address' };
    }
    return { isValid: true };
}

/**
 * Validates GitHub username format
 */
export function validateGitHubUsername(username: string): { isValid: boolean; error?: string } {
    if (username.length < 1 || username.length > 39) {
        return { isValid: false, error: 'GitHub username must be between 1 and 39 characters' };
    }
    const usernameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
    if (!usernameRegex.test(username)) {
        return { isValid: false, error: 'GitHub username can only contain alphanumeric characters and hyphens, and cannot start or end with a hyphen' };
    }
    return { isValid: true };
}

/**
 * Validates API key format (basic validation)
 */
export function validateApiKey(apiKey: string): { isValid: boolean; error?: string } {
    if (apiKey.length < 10) {
        return { isValid: false, error: 'API key seems too short (minimum 10 characters)' };
    }
    if (apiKey.length > 200) {
        return { isValid: false, error: 'API key seems too long (maximum 200 characters)' };
    }
    return { isValid: true };
}

/**
 * Validates model name format
 */
export function validateModelName(modelName: string): { isValid: boolean; error?: string } {
    if (modelName.length < 2) {
        return { isValid: false, error: 'Model name must be at least 2 characters long' };
    }
    if (modelName.length > 100) {
        return { isValid: false, error: 'Model name must be less than 100 characters' };
    }
    // Allow alphanumeric, hyphens, underscores, dots, and slashes (for provider/model format)
    const modelRegex = /^[a-zA-Z0-9\-_.\/]+$/;
    if (!modelRegex.test(modelName)) {
        return { isValid: false, error: 'Model name can only contain letters, numbers, hyphens, underscores, dots, and slashes (e.g., gpt-4, claude-3-opus, provider/model-name)' };
    }
    return { isValid: true };
}
