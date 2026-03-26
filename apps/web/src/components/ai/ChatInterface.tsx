'use client';

import { useCallback, useState } from 'react';
import { useChatContext } from './ChatProvider';
import { ChatToolbar } from './ChatToolbar';
import { ChatMessages } from './ChatMessages';
import { ChatInput } from './ChatInput';
import { ChatWelcome } from './ChatWelcome';

export function ChatInterface() {
    const {
        messages,
        setMessages,
        status,
        error,
        sendMessage,
        resetChat,
        stop,
        regenerate,
        providers,
        selectedProvider,
        setSelectedProvider,
    } = useChatContext();

    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingContent, setEditingContent] = useState('');

    const isStreaming = status === 'streaming' || status === 'submitted';

    const handleEditStart = useCallback(
        (id: string, content: string) => {
            if (isStreaming) return;
            setEditingId(id);
            setEditingContent(content);
        },
        [isStreaming],
    );

    const handleEditCancel = useCallback(() => {
        setEditingId(null);
        setEditingContent('');
    }, []);

    const handleEditSave = useCallback(() => {
        if (!editingId || !editingContent.trim() || isStreaming) return;
        const editIndex = messages.findIndex((m) => m.id === editingId);
        if (editIndex === -1) return;

        const updated = messages.slice(0, editIndex + 1);
        updated[editIndex] = {
            ...updated[editIndex],
            parts: [{ type: 'text', text: editingContent.trim() }],
        };

        setMessages(updated);
        setEditingId(null);
        setEditingContent('');
        regenerate();
    }, [editingId, editingContent, isStreaming, messages, setMessages, regenerate]);

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
                <ChatMessages
                    messages={messages}
                    isStreaming={isStreaming}
                    editingId={editingId}
                    editingContent={editingContent}
                    onEditStart={handleEditStart}
                    onEditCancel={handleEditCancel}
                    onEditSave={handleEditSave}
                    onEditChange={setEditingContent}
                />
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
