'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { EmailMessageListItem } from '@/lib/api/email-addresses';

/**
 * EW-681 / T33 — client-side hook for a per-Agent inbox.
 *
 * The notifications-v2 spec called for an SWR hook, but SWR is not a
 * dependency of `apps/web` (same constraint that drove
 * `use-organizations.ts`). We implement the same surface — shared
 * per-agent cache + `mutate()` to revalidate — with a module-level
 * store + `useSyncExternalStore`, fetching the BFF proxy at
 * `GET /api/email/messages?agentId=…`.
 *
 * `mutate()` is what the SSE hook (T34, `useInboxStream`) calls when a
 * new inbound message arrives, so the list refreshes without a manual
 * reload.
 *
 * Surface:
 *   - `messages` — `EmailMessageListItem[]` (defaults to `[]`).
 *   - `isLoading` — `true` until the first fetch resolves.
 *   - `error` — `Error | null`.
 *   - `mutate()` — re-runs the fetch + updates all subscribers.
 */

type Listener = () => void;

interface InboxStore {
    data: EmailMessageListItem[];
    isLoading: boolean;
    error: Error | null;
    listeners: Set<Listener>;
}

const stores = new Map<string, InboxStore>();

function getStore(agentId: string): InboxStore {
    let store = stores.get(agentId);
    if (!store) {
        store = { data: [], isLoading: true, error: null, listeners: new Set() };
        stores.set(agentId, store);
    }
    return store;
}

function emit(store: InboxStore): void {
    for (const l of store.listeners) l();
}

async function fetchInbox(agentId: string): Promise<void> {
    const store = getStore(agentId);
    try {
        const res = await fetch(`/api/email/messages?agentId=${encodeURIComponent(agentId)}`, {
            cache: 'no-store',
        });
        if (!res.ok) throw new Error(`Inbox fetch failed: ${res.status}`);
        const body = (await res.json()) as { messages: EmailMessageListItem[] };
        store.data = body.messages ?? [];
        store.error = null;
    } catch (err) {
        store.error = err instanceof Error ? err : new Error(String(err));
    } finally {
        store.isLoading = false;
        emit(store);
    }
}

export interface UseAgentInboxResult {
    messages: EmailMessageListItem[];
    isLoading: boolean;
    error: Error | null;
    mutate: () => Promise<void>;
}

export function useAgentInbox(agentId: string): UseAgentInboxResult {
    const store = getStore(agentId);

    const subscribe = useCallback(
        (listener: Listener) => {
            store.listeners.add(listener);
            return () => store.listeners.delete(listener);
        },
        [store],
    );

    const messages = useSyncExternalStore(
        subscribe,
        () => store.data,
        () => store.data,
    );
    const isLoading = useSyncExternalStore(
        subscribe,
        () => store.isLoading,
        () => store.isLoading,
    );
    const error = useSyncExternalStore(
        subscribe,
        () => store.error,
        () => store.error,
    );

    const mutate = useCallback(() => fetchInbox(agentId), [agentId]);

    useEffect(() => {
        // Fetch once per agent on mount (and whenever agentId changes).
        void fetchInbox(agentId);
    }, [agentId]);

    return { messages, isLoading, error, mutate };
}
