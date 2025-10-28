import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import { MessageResponse } from './types';

// DTOs
export interface StartConversationDto {
    title?: string;
    metadata?: Record<string, any>;
}

export interface SendMessageDto {
    message: string;
    options?: {
        model?: string;
        temperature?: number;
        maxTokens?: number;
        [key: string]: any;
    };
}

// Response Types
export interface ConversationStartResponse {
    success: boolean;
    sessionId: string;
    message: string;
}

export type ConversationMessage = {
    role: 'user' | 'assistant' | 'system' | 'tool' | 'function';
    content: string;
    timestamp: string | null;
};

export interface ConversationHistoryResponse {
    sessionId: string;
    context: Record<string, any>;
    totalMessages: number;
    messages: ConversationMessage[];
}

export interface ConversationSummary {
    sessionId: string;
    title?: string;
    createdAt: string | null;
    updatedAt: string | null;
    messageCount: number;
}

export interface StreamChunk {
    content?: string;
    done?: boolean;
    error?: string;
    metadata?: Record<string, any>;
}

// Helper function to parse NDJSON stream
async function* parseNDJSONStream(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            // Process any remaining buffer
            if (buffer.trim()) {
                try {
                    yield JSON.parse(buffer);
                } catch (e) {
                    console.error('Failed to parse final buffer:', buffer);
                }
            }
            break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');

        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (line.trim()) {
                try {
                    yield JSON.parse(line);
                } catch (e) {
                    console.error('Failed to parse line:', line);
                }
            }
        }
    }
}

export const aiConversationAPI = {
    // Start a new conversation
    startConversation: async (data: StartConversationDto) => {
        return serverMutation<ConversationStartResponse>({
            endpoint: '/ai-conversations/start',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    getConversationHistory: async (sessionId: string) => {
        return serverFetch<ConversationHistoryResponse>(`/ai-conversations/${sessionId}/history`);
    },

    getRecentConversations: async (limit?: number) => {
        const params = new URLSearchParams();
        if (limit !== undefined) {
            params.set('limit', limit.toString());
        }
        const query = params.toString() ? `?${params.toString()}` : '';
        return serverFetch<ConversationSummary[]>(`/ai-conversations/recent${query}`);
    },

    // Send a message (non-streaming)
    sendMessage: async (sessionId: string, data: SendMessageDto) => {
        return serverMutation<MessageResponse>({
            endpoint: `/ai-conversations/${sessionId}/send`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Stream a message response
    streamMessage: async function* (
        sessionId: string,
        data: SendMessageDto,
    ): AsyncGenerator<StreamChunk, void, unknown> {
        const response = await serverFetch<Response>(`/ai-conversations/${sessionId}/stream`, {
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

    // Ask a question without conversation history (non-streaming)
    ask: async (data: SendMessageDto) => {
        return serverMutation<MessageResponse>({
            endpoint: '/ai-conversations/ask',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Stream a response without conversation history
    streamAsk: async function* (data: SendMessageDto): AsyncGenerator<StreamChunk, void, unknown> {
        const response = await serverFetch<Response>('/ai-conversations/ask/stream', {
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

// Helper function to collect stream into a single response
export async function collectStream(streamGenerator: AsyncGenerator<StreamChunk>): Promise<string> {
    let fullContent = '';

    for await (const chunk of streamGenerator) {
        if (chunk.error) {
            throw new Error(chunk.error);
        }
        if (chunk.content) {
            fullContent += chunk.content;
        }
    }

    return fullContent;
}
