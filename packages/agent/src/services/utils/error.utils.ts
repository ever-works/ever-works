import { BadRequestException, HttpException, Logger } from '@nestjs/common';

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

    let message: string = String(error);

    if (typeof error === 'object') {
        message = (error as any).message || (error as any).error || message;
    }

    const lowerMessage = message.toLowerCase();

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

    return message;
}
