import { NextRequest } from 'next/server';
import { aiConversationAPI } from '@/lib/api/ai-conversation';

export async function POST(request: NextRequest, { params }: { params: { sessionId: string } }) {
    try {
        const body = await request.json();
        const { sessionId } = params;

        const streamGenerator = aiConversationAPI.streamMessage(sessionId, body);

        // Create a TransformStream to convert the async generator to a ReadableStream
        const encoder = new TextEncoder();

        const stream = new ReadableStream({
            async start(controller) {
                try {
                    for await (const chunk of streamGenerator) {
                        // Encode each chunk as NDJSON and send it
                        const line = JSON.stringify(chunk) + '\n';
                        controller.enqueue(encoder.encode(line));

                        // If chunk indicates completion, close the stream
                        if (chunk.done) {
                            controller.close();
                            break;
                        }
                    }
                    controller.close();
                } catch (error) {
                    console.error('Stream error:', error);
                    const errorChunk = JSON.stringify({
                        error: error instanceof Error ? error.message : 'Stream error',
                        done: true,
                    });
                    controller.enqueue(encoder.encode(errorChunk + '\n'));
                    controller.close();
                }
            },
        });

        // Return streaming response
        return new Response(stream, {
            headers: {
                'Content-Type': 'application/x-ndjson',
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no',
            },
        });
    } catch (error) {
        console.error('API route error:', error);
        return new Response(
            JSON.stringify({
                error: error instanceof Error ? error.message : 'Internal server error',
            }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            },
        );
    }
}
