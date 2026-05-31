'use client';

import { useEffect, useRef } from 'react';
import type { UIMessage } from '@ai-sdk/react';
import { getToolName, isToolUIPart } from 'ai';
import { useCanvas } from './CanvasProvider';
import { isCanvasToolOutput } from './types';

/**
 * Watches the chat message stream for canvas tool outputs and opens the canvas
 * panel for any newly-seen artifact. Decoupled from `ChatToolResult` so the
 * panel works the same whether a tool ran live or was replayed from history.
 */
export function CanvasBridge({ messages }: { messages: UIMessage[] }) {
    const { open } = useCanvas();
    const seen = useRef<Set<string>>(new Set());
    // On the first pass we only *register* artifacts already present in the
    // replayed history — we don't auto-open them. Otherwise re-mounting the
    // chat (e.g. after viewing history) would reopen a panel the user closed.
    const didInit = useRef(false);

    useEffect(() => {
        const isInitialPass = !didInit.current;
        for (const message of messages) {
            for (const part of message.parts) {
                if (!isToolUIPart(part)) continue;
                if (part.state !== 'output-available') continue;
                const name = getToolName(part);
                if (!name) continue;

                const output = part.output;
                if (!isCanvasToolOutput(output)) continue;

                const artifactId = output.artifact.id;
                if (seen.current.has(artifactId)) continue;
                seen.current.add(artifactId);
                // Only auto-open artifacts that arrive after the initial replay.
                if (!isInitialPass) open(output.artifact);
            }
        }
        didInit.current = true;
    }, [messages, open]);

    return null;
}
