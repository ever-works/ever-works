import { NextRequest } from 'next/server';
import { aiConversationAPI } from '@/lib/api/ai-conversation';
import { nextApiResponseStreaming } from '@/lib/utils/next-api';

type Params = { params: Promise<{ sessionId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
    const body = await request.json();
    const { sessionId } = await params;

    return nextApiResponseStreaming(() => aiConversationAPI.streamMessage(sessionId, body));
}
