'use client';

import { useEffect } from 'react';

/**
 * EW-681 / T34 — subscribe to the per-Agent inbox SSE stream and invoke
 * `onMessage` whenever a new inbound message arrives. Pair it with
 * `useAgentInbox` (T33): pass that hook's `mutate` as `onMessage` so the
 * list refreshes live.
 *
 * Falls back to a 30s poll (calling `onMessage` on a timer) when the
 * browser lacks EventSource or the stream errors, so the inbox still
 * eventually-converges without SSE.
 */
export function useInboxStream(agentId: string, onMessage: () => void): void {
    useEffect(() => {
        if (!agentId) return;

        let pollTimer: ReturnType<typeof setInterval> | null = null;
        let source: EventSource | null = null;
        let disposed = false;

        const startPollFallback = () => {
            if (pollTimer || disposed) return;
            pollTimer = setInterval(() => onMessage(), 30000);
        };

        if (typeof EventSource === 'undefined') {
            startPollFallback();
            return () => {
                if (pollTimer) clearInterval(pollTimer);
            };
        }

        try {
            source = new EventSource(`/api/email/messages/stream?agentId=${encodeURIComponent(agentId)}`);
            source.addEventListener('message', () => onMessage());
            source.onerror = () => {
                // Connection dropped — close it and degrade to polling.
                source?.close();
                source = null;
                startPollFallback();
            };
        } catch {
            startPollFallback();
        }

        return () => {
            disposed = true;
            source?.close();
            if (pollTimer) clearInterval(pollTimer);
        };
    }, [agentId, onMessage]);
}
