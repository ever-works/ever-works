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

    useEffect(() => {
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
                open(output.artifact);
            }
        }
    }, [messages, open]);

    return null;
}
