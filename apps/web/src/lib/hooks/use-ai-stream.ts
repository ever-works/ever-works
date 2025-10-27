'use client';

import { useState, useCallback } from 'react';

export interface StreamChunk {
    content?: string;
    done?: boolean;
    error?: string;
    metadata?: Record<string, any>;
}

export interface UseAIStreamOptions {
    onChunk?: (chunk: StreamChunk) => void;
    onComplete?: (fullContent: string) => void;
    onError?: (error: Error) => void;
}

export function useAIStream(options?: UseAIStreamOptions) {
    const [isStreaming, setIsStreaming] = useState(false);
    const [content, setContent] = useState('');
    const [error, setError] = useState<Error | null>(null);

    const streamMessage = useCallback(
        async (endpoint: string, data: any) => {
            setIsStreaming(true);
            setContent('');
            setError(null);

            try {
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data),
                });

                if (!response.ok) {
                    throw new Error(`Stream failed: ${response.status} ${response.statusText}`);
                }

                const reader = response.body?.getReader();
                if (!reader) {
                    throw new Error('Response body is not readable');
                }

                const decoder = new TextDecoder();
                let buffer = '';
                let fullContent = '';

                const parseStreamLine = (line: string): StreamChunk | null => {
                    const trimmed = line.trim();
                    if (!trimmed) {
                        return null;
                    }

                    const candidates: string[] = [trimmed];

                    if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) {
                        const start = trimmed.indexOf('{');
                        const end = trimmed.lastIndexOf('}');
                        if (start !== -1 && end !== -1 && end >= start) {
                            candidates.push(trimmed.slice(start, end + 1));
                        }
                    }

                    for (const candidate of candidates) {
                        try {
                            return JSON.parse(candidate);
                        } catch {
                            continue;
                        }
                    }

                    return null;
                };

                while (true) {
                    const { done, value } = await reader.read();

                    if (done) {
                        // Process any remaining buffer
                        if (buffer.trim()) {
                            try {
                                const chunk = parseStreamLine(buffer);
                                if (!chunk) {
                                    console.error('Failed to parse final buffer:', buffer);
                                    break;
                                }
                                if (chunk.content) {
                                    fullContent += chunk.content;
                                    setContent(fullContent);
                                }
                                options?.onChunk?.(chunk);
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
                            const chunk = parseStreamLine(line);
                            if (!chunk) {
                                console.error('Failed to parse line:', line);
                                continue;
                            }

                            if (chunk.error) {
                                throw new Error(chunk.error);
                            }

                            if (chunk.content) {
                                fullContent += chunk.content;
                                setContent(fullContent);
                            }

                            options?.onChunk?.(chunk);

                            if (chunk.done) {
                                options?.onComplete?.(fullContent);
                                setIsStreaming(false);
                                return fullContent;
                            }
                        }
                    }
                }

                options?.onComplete?.(fullContent);
                return fullContent;
            } catch (err) {
                const error = err instanceof Error ? err : new Error('Stream error');
                setError(error);
                options?.onError?.(error);
                throw error;
            } finally {
                setIsStreaming(false);
            }
        },
        [options],
    );

    const reset = useCallback(() => {
        setContent('');
        setError(null);
        setIsStreaming(false);
    }, []);

    return {
        streamMessage,
        isStreaming,
        content,
        error,
        reset,
    };
}
