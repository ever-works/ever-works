'use client';

import { useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ChatInterface } from '../ChatInterface';
import { useChatContext } from '../ChatProvider';
import { ConversationHeader } from './ConversationHeader';
import { ConversationListPanel } from './ConversationListPanel';
import { ConversationNameDialog } from './ConversationNameDialog';
import { ParticipantSwitcher } from './ParticipantSwitcher';

export interface ConversationPanelRouterProps {
    /** The panel's own close control — the only thing that closes it (FR-13). */
    onClose?: () => void;
}

/**
 * The docked panel's view stack (FR-14): a Conversation, one Agent's
 * Conversation list, and the participant switcher, walked back in that order.
 * Owns no data — who is open lives in `ChatProvider`, so a route change never
 * loses it and a reload restores it (FR-13, FR-20).
 *
 * The assistant's Conversation view is `ChatInterface` exactly as it always
 * rendered; the only addition there is a Switch control in its toolbar.
 */
export function ConversationPanelRouter({ onClose }: ConversationPanelRouterProps) {
    const t = useTranslations('dashboard.aiChat.panel');
    const { panel, panelBack, openSwitcher, updateNamedConversation } = useChatContext();
    const [naming, setNaming] = useState(false);

    // Alt+← goes back one view, from anywhere inside the panel (spec §6.12).
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.altKey && event.key === 'ArrowLeft') {
            event.preventDefault();
            panelBack();
        }
    };

    const participant = panel.participant;
    let body: React.ReactNode;

    if (panel.view === 'switcher') {
        body = (
            <>
                <ConversationHeader title={t('switch')} onClose={onClose} />
                <ParticipantSwitcher />
            </>
        );
    } else if (participant.kind === 'assistant') {
        body = <ChatInterface onSwitch={() => openSwitcher()} />;
    } else if (panel.view === 'list') {
        body = (
            <>
                <ConversationHeader
                    title={participant.name}
                    onBack={panelBack}
                    onSwitch={() => openSwitcher()}
                    onClose={onClose}
                />
                <ConversationListPanel />
            </>
        );
    } else {
        const conversationId = panel.conversation.id;
        body = (
            <>
                <ConversationHeader
                    title={participant.name}
                    conversationName={panel.conversation.title}
                    context={panel.conversation.context}
                    onBack={panelBack}
                    onSwitch={() => openSwitcher()}
                    onRename={conversationId ? () => setNaming(true) : undefined}
                    onClose={onClose}
                />
                <ChatInterface
                    // Keyed by Agent only: the first message turning a fresh
                    // Conversation into a stored one must not remount the view
                    // (and drop the message still on its way).
                    key={participant.agentId}
                    kind="direct"
                    conversationId={conversationId}
                />
                {naming && conversationId && (
                    <ConversationNameDialog
                        conversationId={conversationId}
                        currentName={panel.conversation.title}
                        open={naming}
                        onOpenChange={setNaming}
                        onSaved={(name) => updateNamedConversation({ title: name })}
                    />
                )}
            </>
        );
    }

    return (
        <div
            data-testid="conversation-panel"
            data-panel-view={panel.view}
            onKeyDown={onKeyDown}
            className="flex h-full min-h-0 flex-col"
        >
            {body}
        </div>
    );
}
