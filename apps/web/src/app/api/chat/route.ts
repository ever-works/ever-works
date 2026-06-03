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
// Security: per-part and whole-body size caps for the messages array. Each
// message is an opaque `UIMessage` (the `ai` SDK owns its shape), so the only
// way to bound a single 10MB+ text part — which would otherwise flow straight
// into `convertToModelMessages`/the provider and cause OOM + huge inference
// cost — is to walk the `parts[].text` fields and cap them, plus cap the total
// serialized payload. Limits are generous (well above any legitimate prompt or
// long conversation history) so only abusive payloads are rejected.
const MAX_TEXT_PART_BYTES = 128 * 1024; // 128 KB per text part
const MAX_MESSAGES_BYTES = 4 * 1024 * 1024; // 4 MB for the whole messages array

function messagesWithinSizeLimits(messages: unknown[]): boolean {
    let total = 0;
    for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        const parts = (message as { parts?: unknown }).parts;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
            if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
                const text = (part as { text?: unknown }).text;
                if (typeof text === 'string') {
                    const bytes = Buffer.byteLength(text, 'utf8');
                    if (bytes > MAX_TEXT_PART_BYTES) return false;
                    total += bytes;
                    if (total > MAX_MESSAGES_BYTES) return false;
                }
            }
        }
    }
    return true;
}

const chatBodySchema = z.object({
    messages: z
        .array(z.unknown())
        .min(1)
        .max(512) // UIMessage shape is owned by `ai` SDK; trust its types after this length cap
        .refine(messagesWithinSizeLimits, {
            message: 'message content exceeds size limits',
        }),
    // Security: providerOverride is forwarded verbatim as the `X-Provider-Override`
    // HTTP header to the backend (lib/ai/provider.ts). Restrict to a plugin-id
    // charset so a CR/LF payload can't attempt header injection / response
    // splitting. Legitimate values are AI plugin ids (e.g. `openrouter`,
    // `anthropic`, `vercel-ai-gateway`), all of which match this set.
    providerOverride: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-zA-Z0-9_-]+$/, 'providerOverride contains invalid characters'),
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
