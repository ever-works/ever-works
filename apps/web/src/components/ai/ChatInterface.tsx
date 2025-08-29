'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils/cn';

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
}

export function ChatInterface() {
    const [messages, setMessages] = useState<Message[]>([
        {
            id: '1',
            role: 'assistant',
            content:
                'Hi! I can help you create directories using natural language. Try asking me to "Create a directory for AI tools" or describe what kind of directory you want to build.',
            timestamp: new Date(),
        },
    ]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || isLoading) return;

        const userMessage: Message = {
            id: Date.now().toString(),
            role: 'user',
            content: input,
            timestamp: new Date(),
        };

        setMessages((prev) => [...prev, userMessage]);
        setInput('');
        setIsLoading(true);

        // TODO: Integrate with actual AI endpoint
        setTimeout(() => {
            const assistantMessage: Message = {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: `I understand you want to create a directory for "${input}". Let me help you set that up with the right configuration...`,
                timestamp: new Date(),
            };
            setMessages((prev) => [...prev, assistantMessage]);
            setIsLoading(false);
        }, 1500);
    };

    return (
        <div className="flex flex-col h-full min-h-0">
            <div className="flex-shrink-0 px-4 py-3 border-b border-border dark:border-border-dark">
                <h2 className="text-base font-semibold text-text dark:text-text-dark">
                    AI Assistant
                </h2>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    Create directories with natural language
                </p>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
                {messages.map((message) => (
                    <div
                        key={message.id}
                        className={cn(
                            'flex',
                            message.role === 'user' ? 'justify-end' : 'justify-start',
                        )}
                    >
                        <div
                            className={cn(
                                'max-w-[90%] rounded-lg px-3 py-2',
                                message.role === 'user'
                                    ? 'bg-primary text-white'
                                    : 'bg-surface-tertiary dark:bg-surface-tertiary-dark text-text dark:text-text-dark',
                            )}
                        >
                            <p className="text-xs leading-relaxed">{message.content}</p>
                            <p
                                className={cn(
                                    'text-[10px] mt-1',
                                    message.role === 'user'
                                        ? 'text-white/70'
                                        : 'text-text-muted dark:text-text-muted-dark',
                                )}
                            >
                                {message.timestamp.toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                })}
                            </p>
                        </div>
                    </div>
                ))}
                {isLoading && (
                    <div className="flex justify-start">
                        <div className="bg-surface-tertiary dark:bg-surface-tertiary-dark rounded-lg px-3 py-2">
                            <div className="flex space-x-1">
                                <div
                                    className="w-1.5 h-1.5 bg-text-muted dark:bg-text-muted-dark rounded-full animate-bounce"
                                    style={{ animationDelay: '0ms' }}
                                />
                                <div
                                    className="w-1.5 h-1.5 bg-text-muted dark:bg-text-muted-dark rounded-full animate-bounce"
                                    style={{ animationDelay: '150ms' }}
                                />
                                <div
                                    className="w-1.5 h-1.5 bg-text-muted dark:bg-text-muted-dark rounded-full animate-bounce"
                                    style={{ animationDelay: '300ms' }}
                                />
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <form onSubmit={handleSubmit} className="flex-shrink-0 px-4 pb-4 pt-2">
                <div className="flex gap-2">
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="Describe the directory you want to create..."
                        className={cn(
                            'flex-1 px-3 py-2 text-sm rounded-lg transition-colors',
                            'bg-surface-tertiary dark:bg-surface-tertiary-dark',
                            'border border-border dark:border-border-dark',
                            'text-text dark:text-text-dark',
                            'placeholder-text-muted dark:placeholder-text-muted-dark',
                            'focus:outline-none focus:border-primary',
                        )}
                        disabled={isLoading}
                    />
                    <button
                        type="submit"
                        disabled={!input.trim() || isLoading}
                        className={cn(
                            'px-3 py-2 rounded-lg transition-colors',
                            'bg-primary hover:bg-primary-hover text-white',
                            'disabled:opacity-50 disabled:cursor-not-allowed',
                        )}
                    >
                        <svg
                            className="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                            />
                        </svg>
                    </button>
                </div>
            </form>
        </div>
    );
}
