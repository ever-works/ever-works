import { BadRequestException, HttpException, Logger } from '@nestjs/common';

function getErrorMessage(error: unknown): string {
    if (typeof error === 'object' && error !== null) {
        return (error as any).message || (error as any).error || String(error);
    }

    return String(error);
}

function collectErrorMessages(error: unknown): string[] {
    const messages: string[] = [];
    const seen = new Set<object>();
    let current: unknown = error;

    while (current) {
        const message = getErrorMessage(current);
        if (message) {
            messages.push(message);
        }

        if (typeof current !== 'object' || current === null) {
            break;
        }

        if (seen.has(current)) {
            break;
        }

        seen.add(current);
        current = (current as any).cause;
    }

    return [...new Set(messages)];
}

export function rethrowAsNormalized(
    error: unknown,
    logger: Logger,
    context: string,
    extraFields?: Record<string, unknown>,
): never {
    if (error instanceof HttpException) {
        throw error;
    }

    logger.error(`Error ${context}:`, error);

    throw new BadRequestException({
        status: 'error',
        message: normalizeGeneratorError(error),
        ...extraFields,
    });
}

export function normalizeGeneratorError(error: any): string {
    if (!error) {
        return 'Unknown error';
    }

    const messages = collectErrorMessages(error);
    const message = messages[0] || String(error);
    const detailedMessage = messages.join(': ');

    const lowerMessage = detailedMessage.toLowerCase();

    if (lowerMessage.includes('not found')) {
        return 'Repository not found. Please verify the repository exists and try again.';
    }

    if (lowerMessage.includes('enotfound') || lowerMessage.includes('getaddrinfo')) {
        return 'Connection failed. Please check your network and try again.';
    }

    if (lowerMessage.includes('timeout') || lowerMessage.includes('timedout')) {
        return 'Request timed out. Please try again.';
    }

    if (
        lowerMessage.includes('could not read username') ||
        lowerMessage.includes('could not read password')
    ) {
        return 'Please reconnect your Git account to continue.';
    }

    return detailedMessage || message;
}
