import { convertToModelMessages, streamText, type UIMessage } from 'ai';
import { createBackendProvider } from '@/lib/ai/provider';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { refreshAccessToken } from '@/lib/auth/refresh';
import { API_URL } from '@/lib/constants';

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

    const body = await request.json();
    const {
        messages,
        providerOverride,
        directoryId,
        conversationId,
    }: {
        messages: UIMessage[];
        providerOverride: string;
        directoryId?: string;
        conversationId?: string;
    } = body;

    if (!providerOverride) {
        return new Response('providerOverride is required', { status: 400 });
    }

    const provider = createBackendProvider({
        baseURL: `${API_URL}/v1`,
        authToken: token,
        providerOverride,
        directoryId,
        conversationId,
    });

    const result = streamText({
        model: provider.chatModel('auto'),
        messages: await convertToModelMessages(messages),
    });

    return result.toUIMessageStreamResponse();
}
