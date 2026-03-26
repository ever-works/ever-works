import { convertToModelMessages, streamText, stepCountIs, type UIMessage } from 'ai';
import { createBackendProvider } from '@/lib/ai/provider';
import { chatTools } from '@/lib/ai/tools';
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
        system: [
            'You are an AI assistant for Ever Works, a directory builder platform.',
            'You can help users manage their directories, check their setup, and navigate the app.',
            'When the user asks to see or view something, use the navigate tool.',
            'When the user wants to create a directory, first check their git connection using checkGitConnection.',
            'Be concise and helpful. Use markdown for formatting.',
        ].join(' '),
        messages: await convertToModelMessages(messages),
        tools: chatTools,
        stopWhen: stepCountIs(5),
    });

    return result.toUIMessageStreamResponse();
}
