import 'server-only';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export interface BackendProviderOptions {
    /** Base URL for the OpenAI-compatible API (e.g., http://localhost:3100/api/v1) */
    baseURL: string;
    /** JWT access token — sent as Authorization: Bearer header */
    authToken: string;
    /** AI provider plugin ID (e.g., 'openrouter', 'openai', 'anthropic') — always required */
    providerOverride: string;
    /** Directory ID for directory-scoped settings */
    directoryId?: string;
}

/**
 * Creates a Vercel AI SDK provider backed by the Ever Works NestJS API.
 *
 * The provider wraps our OpenAI-compatible endpoint (POST /api/v1/chat/completions)
 * and injects auth + provider selection headers automatically.
 */
export function createBackendProvider(options: BackendProviderOptions) {
    return createOpenAICompatible({
        name: 'ever-works',
        baseURL: options.baseURL,
        apiKey: options.authToken,
        headers: {
            'X-Provider-Override': options.providerOverride,
            ...(options.directoryId && { 'X-Directory-Id': options.directoryId }),
        },
    });
}
