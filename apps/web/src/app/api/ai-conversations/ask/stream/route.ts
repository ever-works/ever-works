import { NextRequest } from 'next/server';
import { aiConversationAPI } from '@/lib/api';
import { nextApiResponseStreaming } from '@/lib/utils/next-api';

export async function POST(request: NextRequest) {
    const body = await request.json();

    return nextApiResponseStreaming(() => aiConversationAPI.streamAsk(body));
}
