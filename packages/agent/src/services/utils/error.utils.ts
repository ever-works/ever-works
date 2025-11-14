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
