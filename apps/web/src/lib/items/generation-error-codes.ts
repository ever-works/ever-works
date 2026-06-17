/**
 * Client-side error code types and utilities for item generation failures.
 *
 * Error codes originate in the backend (ItemSubmissionService) and are forwarded
 * through the server action → component chain. Unknown messages are pattern-matched
 * via inferErrorCode() so even legacy error strings get a useful classification.
 *
 * The user-facing translations live in
 * `dashboard.workDetail.items.generationErrors` in messages/en.json.
 * The component `GenerationErrorTooltip` handles translation internally with
 * statically typed keys — do not pass the `t` function through library code.
 */

export type GenerationErrorCode =
    | 'GIT_PROVIDER_NOT_CONFIGURED'
    | 'GIT_AUTH_FAILED'
    | 'GIT_REPO_NOT_CONFIGURED'
    | 'GIT_CLONE_FAILED'
    | 'GIT_PUSH_FAILED'
    | 'GIT_BRANCH_FAILED'
    | 'ITEM_NOT_FOUND'
    | 'ITEM_ALREADY_EXISTS'
    | 'AI_PROVIDER_NOT_CONFIGURED'
    | 'SCREENSHOT_NOT_CONFIGURED'
    | 'RATE_LIMIT_EXCEEDED'
    | 'QUOTA_EXCEEDED'
    | 'GENERIC_ERROR';

export interface GenerationErrorDetail {
    /** Short title displayed in the popup header */
    title: string;
    /** User-facing explanation — no raw technical details */
    message: string;
    /** Optional link to the relevant settings page */
    settingsPath?: string;
    /** Label for the settings link */
    settingsLabel?: string;
}

/**
 * Map from error code to the settings page path (work-specific where applicable).
 * Translation labels are resolved inside GenerationErrorTooltip.
 */
export function getErrorSettingsPath(
    code: GenerationErrorCode,
    workId?: string,
): string | undefined {
    switch (code) {
        case 'GIT_PROVIDER_NOT_CONFIGURED':
        case 'GIT_AUTH_FAILED':
            return workId ? `/works/${workId}/plugins` : '/plugins';
        case 'GIT_REPO_NOT_CONFIGURED':
        case 'GIT_CLONE_FAILED':
        case 'GIT_PUSH_FAILED':
        case 'GIT_BRANCH_FAILED':
            return workId ? `/works/${workId}/settings` : undefined;
        case 'AI_PROVIDER_NOT_CONFIGURED':
        case 'SCREENSHOT_NOT_CONFIGURED':
            return '/plugins';
        case 'QUOTA_EXCEEDED':
            return '/settings/budgets-usage';
        default:
            return undefined;
    }
}

/**
 * Infer a GenerationErrorCode from a raw server error message string.
 * Used as a fallback when the backend does not emit an explicit error_code
 * (e.g. older API versions or unclassified throws).
 */
export function inferErrorCode(message: string): GenerationErrorCode {
    const lower = message.toLowerCase();

    if (
        lower.includes('git provider') ||
        lower.includes('git credentials') ||
        lower.includes('no git provider')
    ) {
        return 'GIT_PROVIDER_NOT_CONFIGURED';
    }
    if (
        lower.includes('authentication') ||
        lower.includes('unauthorized') ||
        lower.includes('invalid token') ||
        lower.includes('code 401') ||
        lower.includes('code 403')
    ) {
        return 'GIT_AUTH_FAILED';
    }
    if (lower.includes('repository not found') || (lower.includes('repository') && lower.includes('not found'))) {
        return 'GIT_REPO_NOT_CONFIGURED';
    }
    if (lower.includes('clone') || lower.includes('could not pull')) {
        return 'GIT_CLONE_FAILED';
    }
    if (lower.includes('push')) {
        return 'GIT_PUSH_FAILED';
    }
    if (lower.includes('switch to main') || (lower.includes('branch') && lower.includes('failed'))) {
        return 'GIT_BRANCH_FAILED';
    }
    if (lower.includes('not found') && !lower.includes('repository')) {
        return 'ITEM_NOT_FOUND';
    }
    if (lower.includes('already exists')) {
        return 'ITEM_ALREADY_EXISTS';
    }
    if (lower.includes('ai provider') || lower.includes('no ai')) {
        return 'AI_PROVIDER_NOT_CONFIGURED';
    }
    if (lower.includes('screenshot') || lower.includes('capture failed')) {
        return 'SCREENSHOT_NOT_CONFIGURED';
    }
    if (lower.includes('rate limit')) {
        return 'RATE_LIMIT_EXCEEDED';
    }
    if (lower.includes('quota')) {
        return 'QUOTA_EXCEEDED';
    }
    return 'GENERIC_ERROR';
}

/**
 * Resolve a GenerationErrorCode from either an explicit code or a raw message.
 */
export function resolveErrorCode(
    errorCode: string | undefined,
    message: string,
): GenerationErrorCode {
    if (errorCode) {
        return errorCode as GenerationErrorCode;
    }
    return inferErrorCode(message);
}
