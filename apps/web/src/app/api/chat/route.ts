import { consumeStream, type UIMessage } from 'ai';
import { runAgent } from '@/lib/ai/agent';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { saveConversationMessages, type MessageUsage } from '@/lib/ai/persistence';

export const maxDuration = 60;

export async function POST(request: Request) {
    const token = await getAuthAccessCookie();
    if (!token) {
        return new Response('Unauthorized', { status: 401 });
    }

    const { messages, providerOverride, workId, conversationId, currentPageUrl } =
        (await request.json()) as {
            messages: UIMessage[];
            providerOverride: string;
            workId?: string;
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
        workId,
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

    // The SDK sends all messages including the new user message in the request body.
    // To correctly diff new vs existing, originalMessages should exclude the last user message
    // since it hasn't been persisted yet.
    const lastMessage = messages[messages.length - 1];
    const previousMessages = lastMessage?.role === 'user' ? messages.slice(0, -1) : messages;

    return result.toUIMessageStreamResponse({
        originalMessages: messages,
        consumeSseStream: consumeStream,
        onFinish: ({ messages: allMessages }) => {
            if (conversationId) {
                saveConversationMessages({
                    conversationId,
                    originalMessages: previousMessages,
                    allMessages,
                    model: resolvedModel,
                    usage: resolvedUsage,
                }).catch((err) => console.error('Failed to save conversation:', err));
            }
        },
    });
}
