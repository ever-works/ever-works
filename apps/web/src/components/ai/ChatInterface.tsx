'use client';

import { useChatContext } from './ChatProvider';
import { ChatToolbar } from './ChatToolbar';
import { ChatMessages } from './ChatMessages';
import { ChatInput } from './ChatInput';
import { ChatWelcome } from './ChatWelcome';

export function ChatInterface() {
    const {
        messages,
        status,
        error,
        sendMessage,
        resetChat,
        stop,
        providers,
        selectedProvider,
        setSelectedProvider,
    } = useChatContext();

    const isStreaming = status === 'streaming' || status === 'submitted';

    return (
        <div className="flex flex-col h-full min-h-0">
            <ChatToolbar
                isStreaming={isStreaming}
                providers={providers}
                selectedProvider={selectedProvider}
                onSelectProvider={setSelectedProvider}
                onNewChat={resetChat}
            />

            {messages.length === 0 ? (
                <ChatWelcome onSuggestion={sendMessage} />
            ) : (
                <ChatMessages messages={messages} isStreaming={isStreaming} />
            )}

            {error && (
                <div className="px-4 py-2 text-xs text-danger bg-danger/5 border-t border-danger/10">
                    {error.message}
                </div>
            )}

            <ChatInput isStreaming={isStreaming} onSubmit={sendMessage} onStop={stop} />
        </div>
    );
}
