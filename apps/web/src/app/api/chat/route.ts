import type { UIMessage } from 'ai';
import { runAgent } from '@/lib/ai/agent';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { refreshAccessToken } from '@/lib/auth/refresh';
import { saveConversationMessages, type MessageUsage } from '@/lib/ai/persistence';

export const maxDuration = 60;

export async function POST(request: Request) {
    let token = await getAuthAccessCookie();
    if (!token) {
        const refreshed = await refreshAccessToken();
        if (refreshed) token = await getAuthAccessCookie();
    }
    if (!token) {
        return new Response('Unauthorized', { status: 401 });
    }

    const { messages, providerOverride, directoryId, conversationId, currentPageUrl } =
        (await request.json()) as {
            messages: UIMessage[];
            providerOverride: string;
            directoryId?: string;
            conversationId?: string;
            currentPageUrl?: string;
        };

    if (!providerOverride) {
        return new Response('providerOverride is required', { status: 400 });
    }

    // Capture usage/model from streamText's onFinish for persistence
    let resolvedModel: string | undefined;
    let resolvedUsage: MessageUsage | undefined;

    const result = await runAgent({
        messages,
        authToken: token,
        providerOverride,
        directoryId,
        conversationId,
        currentPageUrl,
        onFinish: ({ usage, response }) => {
            resolvedModel = response.modelId;
            resolvedUsage = {
                promptTokens: usage.inputTokens,
                completionTokens: usage.outputTokens,
                totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
            };
        },
    });

    result.consumeStream();

    return result.toUIMessageStreamResponse({
        originalMessages: messages,
        onFinish: ({ messages: allMessages }) => {
            if (conversationId) {
                saveConversationMessages({
                    conversationId,
                    originalMessages: messages,
                    allMessages,
                    model: resolvedModel,
                    usage: resolvedUsage,
                }).catch((err) => console.error('Failed to save conversation:', err));
            }
        },
    });
}
