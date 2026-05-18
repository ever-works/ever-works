import { consumeStream, type UIMessage } from 'ai';
import { z } from 'zod';
import { runAgent } from '@/lib/ai/agent';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { saveConversationMessages, type MessageUsage } from '@/lib/ai/persistence';

export const maxDuration = 60;

/**
 * M-08: runtime shape validation for the chat-route body. The previous
 * `as` cast trusted whatever the client sent, which lets an attacker pass
 * non-string fields (`workId` as an object, `currentPageUrl` as a 100MB
 * string) that downstream code may not be ready for. The API tier has its
 * own DTO check, but defense-in-depth at the web boundary is cheap.
 */
const chatBodySchema = z.object({
    messages: z.array(z.unknown()).min(1).max(512), // UIMessage shape is owned by `ai` SDK; trust its types after this length cap
    providerOverride: z.string().min(1).max(128),
    workId: z.string().min(1).max(128).optional(),
    conversationId: z.string().min(1).max(128).optional(),
    currentPageUrl: z.string().max(2048).optional(),
});

export async function POST(request: Request) {
    const token = await getAuthAccessCookie();
    if (!token) {
        return new Response('Unauthorized', { status: 401 });
    }

    let parsed;
    try {
        parsed = chatBodySchema.safeParse(await request.json());
    } catch {
        return new Response('invalid JSON body', { status: 400 });
    }
    if (!parsed.success) {
        return new Response(
            `invalid request body: ${parsed.error.issues
                .slice(0, 3)
                .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
                .join('; ')}`,
            { status: 400 },
        );
    }
    const { messages, providerOverride, workId, conversationId, currentPageUrl } = parsed.data as {
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
