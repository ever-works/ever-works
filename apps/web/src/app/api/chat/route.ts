import { consumeStream, type UIMessage } from 'ai';
import { after } from 'next/server';
import { z } from 'zod';
import { runAgent } from '@/lib/ai/agent';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { saveConversationMessages, type MessageUsage } from '@/lib/ai/persistence';
import { applyBffWorkspaceScope } from '@/lib/api/bff-scope';

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
    /**
     * Model the user pinned in the composer. Absent means "let the provider
     * resolve its configured model" — the route then sends the sentinel
     * `'auto'`, which the API maps back to `undefined` so the facade's
     * defaultModel/tier resolution runs exactly as it always has.
     *
     * Security: this reaches the backend in the JSON BODY (not a header), so
     * it cannot split a response the way `providerOverride` could. The charset
     * is still constrained because a model id is an identifier, never prose:
     * vendor ids look like `openai/gpt-5-mini`, `anthropic.claude-3:0` or
     * `meta-llama/Llama-3.3-70B-Instruct`, all of which fit. The cap matches
     * the conversations table's `model` column (varchar 100) so a value that
     * round-trips through the chat route can always be persisted.
     */
    model: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[a-zA-Z0-9_.:/-]+$/, 'model contains invalid characters')
        .optional(),
    workId: z.string().min(1).max(128).optional(),
    conversationId: z.string().min(1).max(128).optional(),
    currentPageUrl: z.string().max(2048).optional(),
    /**
     * Upload ids for files attached in the composer.
     *
     * The model already sees the attachments as a fenced block inside the
     * user turn; this is the PLATFORM's copy, so nothing downstream has to
     * re-parse a model-facing string to recover ids. Constrained to the
     * sha256 shape the uploads spine issues — an id is a lookup key, and a
     * free-form string here would be one.
     *
     * Bounded at 20: the composer allows multi-select, and an unbounded
     * array is a cheap way to make a request expensive.
     */
    attachmentIds: z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .max(20)
        .optional(),
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
    const {
        messages,
        providerOverride,
        model,
        workId,
        conversationId,
        currentPageUrl,
        attachmentIds,
    } = parsed.data as {
        messages: UIMessage[];
        providerOverride: string;
        model?: string;
        workId?: string;
        conversationId?: string;
        currentPageUrl?: string;
        attachmentIds?: string[];
    };
    // Files attached in chat also land in global Memory, so the org keeps
    // them after the conversation scrolls away.
    //
    // Scheduled with `after()` rather than awaited: ingest reads each file
    // back out of storage and extracts its text, which is far too slow to
    // sit in front of the first streamed token. It is also strictly
    // best-effort — a failure here must never cost the user their message,
    // so nothing about the chat response depends on the outcome.
    if (attachmentIds && attachmentIds.length > 0) {
        // Scope has to be resolved HERE, not inside `after()`. The callback
        // runs after the response, where Next's `headers()` is no longer
        // available — which is why this call hand-built its headers and so
        // forwarded no selector at all. `OrgMemoryController.ingestFromAttachments`
        // requires an active Organization and answers 422 without one, so
        // every attachment a member added inside an Org was silently dropped:
        // the catch below swallowed it and the chat turn looked fine.
        //
        // Still strictly best-effort. A caller with no selector (or a stale
        // one) must not cost the user their message, so a failure to build
        // scoped headers skips the ingest rather than throwing — same
        // contract the empty catch already gave this call.
        let ingestHeaders: Headers | null = null;
        try {
            ingestHeaders = applyBffWorkspaceScope(request, {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            });
        } catch {
            ingestHeaders = null;
        }

        if (ingestHeaders) {
            const headersForIngest = ingestHeaders;
            after(async () => {
                try {
                    await fetch(`${API_URL}/memory/uploads/from-attachments`, {
                        method: 'POST',
                        headers: headersForIngest,
                        body: JSON.stringify({ attachmentIds }),
                        cache: 'no-store',
                    });
                } catch {
                    // Deliberately silent: Memory ingest is an enhancement of
                    // the chat turn, not part of it.
                }
            });
        }
    }

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
        model,
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
