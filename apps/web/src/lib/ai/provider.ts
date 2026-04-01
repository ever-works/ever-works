import 'server-only';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export interface BackendProviderOptions {
    baseURL: string;
    authToken?: string;
    authCookieHeader?: string;
    providerOverride: string;
    directoryId?: string;
    conversationId?: string;
}

export function createBackendProvider(options: BackendProviderOptions) {
    return createOpenAICompatible({
        name: 'ever-works',
        baseURL: options.baseURL,
        apiKey: options.authToken || 'auth-session',
        headers: {
            'X-Provider-Override': options.providerOverride,
            ...(options.authCookieHeader && { Cookie: options.authCookieHeader }),
            ...(options.directoryId && { 'X-Directory-Id': options.directoryId }),
            ...(options.conversationId && { 'X-Conversation-Id': options.conversationId }),
        },
    });
}
