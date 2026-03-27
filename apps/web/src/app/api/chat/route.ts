import type { UIMessage } from 'ai';
import { runAgent } from '@/lib/ai/agent';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { refreshAccessToken } from '@/lib/auth/refresh';

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

    const { messages, providerOverride, directoryId, conversationId } = (await request.json()) as {
        messages: UIMessage[];
        providerOverride: string;
        directoryId?: string;
        conversationId?: string;
    };

    if (!providerOverride) {
        return new Response('providerOverride is required', { status: 400 });
    }

    const result = await runAgent({
        messages,
        authToken: token,
        providerOverride,
        directoryId,
        conversationId,
    });

    return result.toUIMessageStreamResponse();
}
