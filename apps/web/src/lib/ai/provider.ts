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
    // Security: strip CR, LF, and NUL from providerOverride before it is
    // forwarded as an HTTP header. The route-level schema already enforces
    // /^[a-zA-Z0-9_-]+$/, but this layer-in-depth guard prevents header
    // injection / response-splitting if the function is ever called from a
    // path that bypasses that schema validation.
    const safeProviderOverride = options.providerOverride.replace(/[\r\n\0]/g, '');
    return createOpenAICompatible({
        name: 'ever-works',
        baseURL: options.baseURL,
        apiKey: options.authToken,
        headers: {
            'X-Provider-Override': safeProviderOverride,
            ...(options.workId && { 'X-Work-Id': options.workId }),
            ...(options.conversationId && { 'X-Conversation-Id': options.conversationId }),
        },
    });
}
