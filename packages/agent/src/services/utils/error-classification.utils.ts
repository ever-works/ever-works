import type { NotificationService } from '@src/notifications/notification.service';

export type ErrorClassificationType =
    | 'ai_credits'
    | 'ai_provider'
    | 'git_auth'
    | 'account_level'
    | 'unknown';

export type ErrorClassification = {
    type: ErrorClassificationType;
    provider: string;
    message: string;
};

export function classifyGenerationError(error: unknown): ErrorClassification {
    const message = error instanceof Error ? error.message : String(error);
    const errorLower = message.toLowerCase();

    if (isAiCreditsError(errorLower)) {
        return { type: 'ai_credits', provider: detectAiProvider(errorLower), message };
    }

    if (isAiProviderError(errorLower)) {
        return { type: 'ai_provider', provider: detectAiProvider(errorLower), message };
    }

    if (isGitAuthError(errorLower)) {
        return { type: 'git_auth', provider: detectGitProvider(errorLower), message };
    }

    if (isAccountLevelError(errorLower)) {
        return { type: 'account_level', provider: '', message };
    }

    return { type: 'unknown', provider: '', message };
}

export async function notifyForClassifiedError(
    notificationService: NotificationService,
    userId: string,
    workId: string,
    workName: string,
    classification: ErrorClassification,
): Promise<void> {
    switch (classification.type) {
        case 'ai_credits':
            await notificationService.notifyAiCreditsDepleted(
                userId,
                classification.provider,
                classification.message,
            );
            break;

        case 'ai_provider':
            await notificationService.notifyAiProviderError(
                userId,
                classification.provider,
                classification.message,
            );
            break;

        case 'git_auth':
            await notificationService.notifyGitAuthExpired(userId, classification.provider);
            break;

        case 'account_level':
            await notificationService.notifyGenerationAccountError(
                userId,
                workId,
                workName,
                classification.message,
            );
            break;
    }
}

function isAiCreditsError(error: string): boolean {
    return (
        error.includes('insufficient_quota') ||
        error.includes('rate_limit') ||
        error.includes('quota exceeded') ||
        error.includes('credits') ||
        error.includes('billing') ||
        error.includes('exceeded your current quota')
    );
}

function isAiProviderError(error: string): boolean {
    return (
        error.includes('invalid_api_key') ||
        error.includes('authentication') ||
        error.includes('unauthorized') ||
        error.includes('api key')
    );
}

function isGitAuthError(error: string): boolean {
    return (
        (error.includes('git') || error.includes('github') || error.includes('gitlab')) &&
        (error.includes('authentication') ||
            error.includes('unauthorized') ||
            error.includes('token') ||
            error.includes('expired') ||
            error.includes('permission denied'))
    );
}

function isAccountLevelError(error: string): boolean {
    return (
        error.includes('account') ||
        error.includes('subscription') ||
        error.includes('plan limit') ||
        error.includes('not configured')
    );
}

function detectAiProvider(error: string): string {
    if (error.includes('openai')) return 'OpenAI';
    if (error.includes('anthropic') || error.includes('claude')) return 'Anthropic';
    if (error.includes('google') || error.includes('gemini')) return 'Google';
    if (error.includes('groq')) return 'Groq';
    if (error.includes('ollama')) return 'Ollama';
    if (error.includes('openrouter')) return 'OpenRouter';
    return 'AI Provider';
}

function detectGitProvider(error: string): string {
    if (error.includes('github')) return 'GitHub';
    if (error.includes('gitlab')) return 'GitLab';
    if (error.includes('bitbucket')) return 'Bitbucket';
    return 'Git Provider';
}
