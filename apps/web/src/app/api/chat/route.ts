import type { UIMessage } from 'ai';
import { runAgent } from '@/lib/ai/agent';
import { getBetterAuthCookieHeader } from '@/lib/auth/cookies';

export const maxDuration = 60;

export async function POST(request: Request) {
    const betterAuthCookies = await getBetterAuthCookieHeader();
    if (!betterAuthCookies) {
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

    const result = await runAgent({
        messages,
        authCookieHeader: betterAuthCookies,
        providerOverride,
        directoryId,
        conversationId,
        currentPageUrl,
    });

    return result.toUIMessageStreamResponse();
}
