'use client';

import { useCallback } from 'react';
import { useChatContextOptional } from '@/components/ai/ChatProvider';
import { useChatPanel } from '@/lib/hooks/use-chat-panel';

/**
 * Shared "the user typed a prompt and pressed enter" handler.
 *
 * Replaces the previous "submit prompt → server-action → redirect"
 * pattern across the dashboard. The new contract is: opening the
 * chat panel + sending the prompt as the first chat message is what
 * happens on every prompt submit, regardless of which surface
 * (`/new`, `/works/new`, `/missions`, `/ideas`, the dashboard
 * quick-add) the user came from. The chat AI then guides them
 * through the rest, while the calling page is free to additionally
 * navigate into a canvas (a creator form, a draft detail page)
 * where the user can edit manually in parallel.
 *
 * The returned function is safe to call from outside the dashboard
 * layout — both the chat-panel controls and the chat context fall
 * back to no-ops when they aren't mounted (previews / unit tests).
 *
 * Usage:
 *
 *   const startFromPrompt = useStartFromPrompt();
 *   const submit = () => {
 *     startFromPrompt(prompt, { intent: 'agent' });
 *     // …then optionally router.push(canvasRoute) without `?prompt=`.
 *   };
 *
 * The optional `intent` is prefixed onto the chat message so the AI
 * has a hint about what the user is trying to build ("Create an
 * agent: <prompt>"). The unprefixed prompt is used when no intent
 * is supplied.
 */
export interface StartFromPromptOptions {
    /** Short noun describing what the user is creating — used as a
     *  context prefix on the chat message. Examples: 'mission',
     *  'idea', 'agent', 'task', 'website', 'landing page'. */
    intent?: string;
}

export type StartFromPromptFn = (prompt: string, opts?: StartFromPromptOptions) => boolean;

export function useStartFromPrompt(): StartFromPromptFn {
    const chat = useChatContextOptional();
    const chatPanel = useChatPanel();

    return useCallback(
        (prompt: string, opts?: StartFromPromptOptions) => {
            const trimmed = prompt.trim();
            if (!trimmed) return false;
            // Open the side panel first so the user immediately sees
            // the message land — sending without opening would leave
            // a confusing "where did my prompt go?" beat.
            chatPanel?.setOpen?.(true);
            if (chat) {
                const message = opts?.intent
                    ? `I want to create a ${opts.intent}. ${trimmed}`
                    : trimmed;
                chat.sendMessage(message);
            }
            return true;
        },
        [chat, chatPanel],
    );
}
