import 'server-only';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export interface BackendProviderOptions {
    baseURL: string;
    authToken: string;
    providerOverride: string;
    workId?: string;
    conversationId?: string;
}

export function createBackendProvider(options: BackendProviderOptions) {
    return createOpenAICompatible({
        name: 'ever-works',
        baseURL: options.baseURL,
        apiKey: options.authToken,
        headers: {
            'X-Provider-Override': options.providerOverride,
            ...(options.workId && { 'X-Work-Id': options.workId }),
            ...(options.conversationId && { 'X-Conversation-Id': options.conversationId }),
        },
    });
}
