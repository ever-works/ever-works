'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    ConversationAttachmentView,
    ConversationFailureCode,
    ConversationMessageView,
} from '@ever-works/contracts';
import {
    discardConversationMessage,
    listConversationMessages,
    retryConversationMessage,
    sendConversationMessage,
    type ConversationActionResult,
} from '@/app/actions/dashboard/conversations';

/** Where failed sends are kept so they survive a reload (FR-43). */
export const CHAT_OUTBOX_STORAGE_KEY = 'chat-outbox';

/** A send refusal the composer explains; `offline` is only knowable in the browser. */
export type OutboxFailureCode = ConversationFailureCode | 'offline';

/**
 * A message the person sent that the server has not stored — still on its
 * way, or refused before it was stored. Once the server stores a message it
 * is a {@link ConversationMessageView} instead, even when it later fails.
 */
export interface OutboxEntry {
    clientMessageId: string;
    body: string;
    /**
     * The files sent with it, with the name and URL the composer already had,
     * so a message still on its way (or refused) shows what it carries. Only
     * the upload ids are sent.
     */
    attachments: ConversationAttachmentView[];
    status: 'sending' | 'failed';
    failureCode: OutboxFailureCode | null;
    details?: { size?: number; max?: number };
    createdAt: string;
}

/** One row of the open Conversation, in the order it is shown. */
export type OutboxRow =
    | { source: 'server'; message: ConversationMessageView; retrying: boolean }
    | { source: 'local'; entry: OutboxEntry };

export interface ConversationOutboxOptions {
    /** The open Conversation; `null` before the first message creates it. */
    conversationId: string | null;
    /** Where failed sends for a Conversation that does not exist yet are kept. */
    draftKey: string;
    /**
     * Returns the Conversation id to send into, creating it on first use
     * (FR-3). A refusal comes back as a failure, never a throw.
     */
    ensureConversation: () => Promise<ConversationActionResult<string>>;
    /** The Conversation is gone or no longer readable (FR-20). */
    onGone?: () => void;
}

export interface ConversationOutbox {
    rows: OutboxRow[];
    loadState: 'idle' | 'loading' | 'ready' | 'error';
    send: (body: string, attachments?: ConversationAttachmentView[]) => Promise<void>;
    retry: (row: OutboxRow) => Promise<void>;
    discard: (row: OutboxRow) => Promise<void>;
    /** Merge one message pushed by the live stream. */
    receive: (message: ConversationMessageView) => void;
    /** Re-read the Conversation from the server. */
    reload: () => Promise<void>;
}

// ── persistence ─────────────────────────────────────────────────────────

type StoredOutbox = Record<string, OutboxEntry[]>;

export function readOutbox(key: string): OutboxEntry[] {
    try {
        const raw = window.localStorage.getItem(CHAT_OUTBOX_STORAGE_KEY);
        const parsed = raw ? (JSON.parse(raw) as StoredOutbox) : {};
        const entries = Array.isArray(parsed[key]) ? parsed[key] : [];
        return entries.filter(isStoredEntry);
    } catch {
        return [];
    }
}

/** Only failed sends are kept — a `sending` entry is never restored as if still in flight. */
export function writeOutbox(key: string, entries: readonly OutboxEntry[]): void {
    try {
        const raw = window.localStorage.getItem(CHAT_OUTBOX_STORAGE_KEY);
        const stored = raw ? (JSON.parse(raw) as StoredOutbox) : {};
        const failed = entries.filter((entry) => entry.status === 'failed');
        if (failed.length > 0) stored[key] = failed;
        else delete stored[key];
        window.localStorage.setItem(CHAT_OUTBOX_STORAGE_KEY, JSON.stringify(stored));
    } catch {
        // Storage unavailable (private mode, quota): the failed row still
        // shows for this session, it just does not survive a reload.
    }
}

function isStoredEntry(value: unknown): value is OutboxEntry {
    const entry = value as Partial<OutboxEntry> | null;
    return (
        !!entry &&
        typeof entry.clientMessageId === 'string' &&
        typeof entry.body === 'string' &&
        entry.status === 'failed'
    );
}

/** A retry-safe client id the API accepts (letters, digits, `_:.-`, at most 64). */
export function newClientMessageId(): string {
    const random =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    return `cm_${random}`;
}

/**
 * Insert or replace `message`, keeping the list oldest-first. Messages that
 * share a timestamp keep the server's order — `createdAt`, then `id` — so the
 * thread, the stream and the list preview agree on which came first.
 */
export function mergeMessage(
    messages: readonly ConversationMessageView[],
    message: ConversationMessageView,
): ConversationMessageView[] {
    const next = messages.filter((existing) => existing.id !== message.id);
    next.push(message);
    return next.sort(
        (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/** The reason a failed action should be shown with. */
export function failureCodeOf(result: {
    status: number;
    failureCode: ConversationFailureCode | null;
}): OutboxFailureCode {
    if (result.status === 0 && typeof navigator !== 'undefined' && navigator.onLine === false) {
        return 'offline';
    }
    return result.failureCode ?? 'provider_unavailable';
}

function thrownFailure(): { ok: false; status: 0; failureCode: 'network'; details: object } {
    return { ok: false, status: 0, failureCode: 'network', details: {} };
}

// ── hook ────────────────────────────────────────────────────────────────

/**
 * Optimistic send, failure and retry for the open Conversation (FR-41..FR-48).
 *
 *  - every send carries a client id, so a retry of the same message can never
 *    store it twice — the server returns the first copy (FR-41);
 *  - a refused send becomes a failed row with its reason, kept in
 *    `localStorage['chat-outbox']` so it survives a reload (FR-42, FR-43);
 *  - nothing retries on its own (FR-45); Retry reuses the original client id,
 *    or the stored message id when the server stored it and then failed it;
 *  - a Retry already in flight ignores a second tap, so two fast Retries
 *    produce one delivered message.
 *
 * Failed sends are written to storage from inside the send itself, so a panel
 * view switch that unmounts the Conversation never loses one.
 */
export function useConversationOutbox({
    conversationId,
    draftKey,
    ensureConversation,
    onGone,
}: ConversationOutboxOptions): ConversationOutbox {
    const storageKey = conversationId ?? draftKey;
    const [messages, setMessages] = useState<ConversationMessageView[]>([]);
    const [entries, setEntries] = useState<OutboxEntry[]>([]);
    const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
    const [loadState, setLoadState] = useState<ConversationOutbox['loadState']>('idle');
    const inFlight = useRef(new Set<string>());
    const entriesRef = useRef<OutboxEntry[]>([]);
    useEffect(() => {
        entriesRef.current = entries;
    }, [entries]);
    const latest = useRef({ ensureConversation, onGone, storageKey });
    useEffect(() => {
        latest.current = { ensureConversation, onGone, storageKey };
    });

    // The Conversation on screen. Every answer the server gives after an
    // await — a load, a Retry, a discard — is committed only while the
    // Conversation it was asked for is still this one, so a slow answer for
    // the previous Conversation never lands in the next (or in a fresh one).
    const openConversation = useRef(conversationId);
    // Loads are numbered, so an older load that answers after a newer one
    // has already been shown cannot roll the view back.
    const loadSeq = useRef(0);
    const shownLoad = useRef(0);

    const reload = useCallback(async () => {
        if (!conversationId) return;
        const seq = (loadSeq.current += 1);
        const stillOpen = () => openConversation.current === conversationId;
        let result: Awaited<ReturnType<typeof listConversationMessages>>;
        try {
            result = await listConversationMessages(conversationId, { limit: 100 });
        } catch {
            if (!stillOpen()) return;
            setLoadState((prev) => (prev === 'ready' ? prev : 'error'));
            return;
        }
        if (!stillOpen()) return;
        if (result.ok) {
            if (seq < shownLoad.current) return;
            shownLoad.current = seq;
            setMessages(result.data.messages);
            setLoadState('ready');
            return;
        }
        if (result.status === 404) latest.current.onGone?.();
        setLoadState((prev) => (prev === 'ready' ? prev : 'error'));
    }, [conversationId]);

    useEffect(() => {
        openConversation.current = conversationId;
        // A send still on its way stays visible across the switch from the
        // draft to the Conversation its first message just created.
        const pending = entriesRef.current.filter(
            (entry) => entry.status === 'sending' && inFlight.current.has(entry.clientMessageId),
        );
        const restored = [...readOutbox(storageKey), ...pending];
        entriesRef.current = restored;
        setEntries(restored);
        setMessages([]);
        if (!conversationId) {
            setLoadState('ready');
            return;
        }
        setLoadState('loading');
        void reload();
    }, [storageKey, conversationId, reload]);

    /** Apply `update` to one key's entries, in state when it is open, and in storage always. */
    const updateEntries = useCallback(
        (key: string, update: (current: OutboxEntry[]) => OutboxEntry[]) => {
            const next = update(readOutboxWithPending(key, entriesRef.current, latest.current));
            writeOutbox(key, next);
            if (key === latest.current.storageKey) {
                entriesRef.current = next;
                setEntries(next);
            }
        },
        [],
    );
    const receive = useCallback((message: ConversationMessageView) => {
        setMessages((prev) => mergeMessage(prev, message));
        if (message.clientMessageId) {
            const clientId = message.clientMessageId;
            const key = latest.current.storageKey;
            const current = entriesRef.current;
            if (current.some((entry) => entry.clientMessageId === clientId)) {
                const next = current.filter((entry) => entry.clientMessageId !== clientId);
                writeOutbox(key, next);
                entriesRef.current = next;
                setEntries(next);
            }
        }
    }, []);

    const deliver = useCallback(
        async (entry: OutboxEntry) => {
            const originKey = latest.current.storageKey;
            const conversation = await latest.current
                .ensureConversation()
                .catch(() => thrownFailure());
            if (!conversation.ok) {
                const failureCode = failureCodeOf(conversation);
                updateEntries(originKey, (current) =>
                    upsertEntry(current, { ...entry, status: 'failed', failureCode }),
                );
                return;
            }
            // A first send creates the Conversation: its failed sends now
            // belong to the real id, not the draft.
            const key = conversation.data;
            if (key !== originKey) {
                const carried = readOutbox(originKey);
                writeOutbox(originKey, []);
                if (carried.length > 0) writeOutbox(key, [...readOutbox(key), ...carried]);
            }

            // The API stores references only; names and URLs are read back
            // from the upload, never taken from the client.
            const attachments = (entry.attachments ?? []).map(({ uploadId }) => ({ uploadId }));
            const result = await sendConversationMessage(key, {
                body: entry.body,
                clientMessageId: entry.clientMessageId,
                ...(attachments.length > 0 ? { attachments } : {}),
            }).catch(() => thrownFailure());

            if (result.ok) {
                updateEntries(key, (current) =>
                    current.filter((item) => item.clientMessageId !== entry.clientMessageId),
                );
                if (key === latest.current.storageKey) receive(result.data.message);
                return;
            }
            updateEntries(key, (current) =>
                upsertEntry(current, {
                    ...entry,
                    status: 'failed',
                    failureCode: failureCodeOf(result),
                    details: result.details,
                }),
            );
        },
        [receive, updateEntries],
    );

    const send = useCallback(
        async (body: string, attachments: ConversationAttachmentView[] = []) => {
            const entry: OutboxEntry = {
                clientMessageId: newClientMessageId(),
                body,
                attachments,
                status: 'sending',
                failureCode: null,
                createdAt: new Date().toISOString(),
            };
            inFlight.current.add(entry.clientMessageId);
            const next = upsertEntry(entriesRef.current, entry);
            entriesRef.current = next;
            setEntries(next);
            try {
                await deliver(entry);
            } finally {
                inFlight.current.delete(entry.clientMessageId);
            }
        },
        [deliver],
    );

    const retry = useCallback(
        async (row: OutboxRow) => {
            if (row.source === 'local') {
                const { entry } = row;
                if (inFlight.current.has(entry.clientMessageId)) return;
                inFlight.current.add(entry.clientMessageId);
                const sending: OutboxEntry = { ...entry, status: 'sending', failureCode: null };
                const next = upsertEntry(entriesRef.current, sending);
                entriesRef.current = next;
                setEntries(next);
                try {
                    await deliver(sending);
                } finally {
                    inFlight.current.delete(entry.clientMessageId);
                }
                return;
            }

            const { message } = row;
            if (!conversationId || inFlight.current.has(message.id)) return;
            inFlight.current.add(message.id);
            setRetrying((prev) => new Set(prev).add(message.id));
            try {
                const result = await retryConversationMessage(conversationId, message.id).catch(
                    () => thrownFailure(),
                );
                // The view may have moved on while the Retry was out: its
                // answer then belongs to a Conversation no longer on screen.
                const stillOpen = openConversation.current === conversationId;
                if (stillOpen && result.ok) {
                    receive(result.data.message);
                } else if (
                    stillOpen &&
                    !result.ok &&
                    (result.status === 409 || result.status === 404)
                ) {
                    // Already retried elsewhere, or discarded: show what is true.
                    await reload();
                }
            } finally {
                inFlight.current.delete(message.id);
                setRetrying((prev) => {
                    const next = new Set(prev);
                    next.delete(message.id);
                    return next;
                });
            }
        },
        [conversationId, deliver, receive, reload],
    );

    const discard = useCallback(
        async (row: OutboxRow) => {
            if (row.source === 'local') {
                updateEntries(latest.current.storageKey, (current) =>
                    current.filter((item) => item.clientMessageId !== row.entry.clientMessageId),
                );
                return;
            }
            if (!conversationId) return;
            const result = await discardConversationMessage(conversationId, row.message.id).catch(
                () => thrownFailure(),
            );
            if (openConversation.current !== conversationId) return;
            if (result.ok || result.status === 404) {
                setMessages((prev) => prev.filter((message) => message.id !== row.message.id));
            } else if (result.status === 409) {
                await reload();
            }
        },
        [conversationId, reload, updateEntries],
    );

    const rows: OutboxRow[] = [
        ...messages.map(
            (message): OutboxRow => ({
                source: 'server',
                message,
                retrying: retrying.has(message.id),
            }),
        ),
        ...entries
            // A send the server already stored is shown once, as the server's row.
            .filter(
                (entry) =>
                    !messages.some((message) => message.clientMessageId === entry.clientMessageId),
            )
            .map((entry): OutboxRow => ({ source: 'local', entry })),
    ];

    return { rows, loadState, send, retry, discard, receive, reload };
}

function upsertEntry(entries: readonly OutboxEntry[], entry: OutboxEntry): OutboxEntry[] {
    const index = entries.findIndex((item) => item.clientMessageId === entry.clientMessageId);
    if (index === -1) return [...entries, entry];
    const next = [...entries];
    next[index] = entry;
    return next;
}

/**
 * The entries to update for `key`: the live list when that Conversation is
 * open (it holds `sending` rows storage never sees), storage otherwise.
 */
function readOutboxWithPending(
    key: string,
    open: OutboxEntry[],
    latest: { storageKey: string },
): OutboxEntry[] {
    return key === latest.storageKey ? open : readOutbox(key);
}
