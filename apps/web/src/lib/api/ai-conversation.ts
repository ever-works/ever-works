import 'server-only';
import { serverFetch } from './server-api';

export type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'function';

export interface ChatMessage {
    role: ChatMessageRole;
    content: string;
}

export interface ChatStreamRequestDto {
    messages: ChatMessage[];
    model?: string;
    temperature?: number;
    providerOverride?: string;
}

export interface StreamChunk {
    content?: string;
    done?: boolean;
    error?: string;
}

async function* parseNDJSONStream(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            if (buffer.trim()) {
                try {
                    yield JSON.parse(buffer);
                } catch {
                    // ignore
                }
            }
            break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (line.trim()) {
                try {
                    yield JSON.parse(line);
                } catch {
                    // ignore
                }
            }
        }
    }
}

export const aiConversationAPI = {
    streamChat: async function* (
        data: ChatStreamRequestDto,
    ): AsyncGenerator<StreamChunk, void, unknown> {
        const response = await serverFetch<Response>('/ai-conversations/chat/stream', {
            method: 'POST',
            body: JSON.stringify(data),
            rawResponse: true,
        });

        if (!response.ok) {
            throw new Error(`Stream failed: ${response.status} ${response.statusText}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('Response body is not readable');
        }

        yield* parseNDJSONStream(reader);
    },
};
