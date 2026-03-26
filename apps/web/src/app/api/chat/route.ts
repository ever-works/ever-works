import { convertToModelMessages, streamText, type UIMessage } from 'ai';
import { createBackendProvider } from '@/lib/ai/provider';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { refreshAccessToken } from '@/lib/auth/refresh';
import { API_URL } from '@/lib/constants';

export const maxDuration = 60;

export async function POST(request: Request) {
    // 1. Auth — same pattern as serverFetch (cookie → JWT → refresh on failure)
    let token = await getAuthAccessCookie();
    if (!token) {
        const refreshed = await refreshAccessToken();
        if (refreshed) token = await getAuthAccessCookie();
    }
    if (!token) {
        return new Response('Unauthorized', { status: 401 });
    }

    // 2. Parse request body (sent by useChat from @ai-sdk/react)
    const body = await request.json();
    const {
        messages,
        providerOverride,
        directoryId,
    }: {
        messages: UIMessage[];
        providerOverride: string;
        directoryId?: string;
    } = body;

    if (!providerOverride) {
        return new Response('providerOverride is required', { status: 400 });
    }

    // 3. Create provider pointing to NestJS backend
    //    API_URL already includes /api suffix (e.g., http://localhost:3100/api)
    const provider = createBackendProvider({
        baseURL: `${API_URL}/v1`,
        authToken: token,
        providerOverride,
        directoryId,
    });

    // 4. Stream through the custom provider → NestJS → AiFacadeService → Plugin
    const result = streamText({
        model: provider('default'),
        messages: await convertToModelMessages(messages),
    });

    return result.toUIMessageStreamResponse();
}
