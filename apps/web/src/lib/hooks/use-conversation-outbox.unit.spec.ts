import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessageView } from '@ever-works/contracts';

const actions = vi.hoisted(() => ({
    listConversationMessages: vi.fn(),
    sendConversationMessage: vi.fn(),
    retryConversationMessage: vi.fn(),
    discardConversationMessage: vi.fn(),
}));
vi.mock('@/app/actions/dashboard/conversations', () => actions);

import {
    CHAT_OUTBOX_STORAGE_KEY,
    failureCodeOf,
    mergeMessage,
    newClientMessageId,
    readOutbox,
    useConversationOutbox,
    type OutboxRow,
} from './use-conversation-outbox';

const CONVERSATION = 'c-1';

function message(overrides: Partial<ConversationMessageView> = {}): ConversationMessageView {
    return {
        id: 'm-1',
        conversationId: CONVERSATION,
        role: 'user',
        content: 'Can you pull the numbers?',
        authorType: 'user',
        authorId: 'u-1',
        mentions: null,
        attachments: null,
        status: 'sent',
        failureCode: null,
        clientMessageId: null,
        replyToMessageId: null,
        createdAt: '2026-09-14T09:00:00.000Z',
        ...overrides,
    };
}

function renderOutbox(conversationId: string | null = CONVERSATION) {
    return renderHook(
        (props: { conversationId: string | null }) =>
            useConversationOutbox({
                conversationId: props.conversationId,
                draftKey: 'draft:a-1',
                ensureConversation: async () => ({ ok: true, data: CONVERSATION }),
            }),
        { initialProps: { conversationId } },
    );
}

const localRow = (rows: OutboxRow[]) => rows.find((row) => row.source === 'local');

/**
 * Sending, failure and retry (FR-41..FR-48): a refused message is kept with
 * its reason and survives a reload; Retry reuses the original client id so the
 * server can never store it twice; two fast Retries send once; nothing retries
 * on its own.
 */
describe('useConversationOutbox', () => {
    beforeEach(() => {
        window.localStorage.clear();
        actions.listConversationMessages.mockResolvedValue({ ok: true, data: { messages: [] } });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('shows a sent message once, as the server stored it', async () => {
        actions.sendConversationMessage.mockImplementation(async (_id, input) => ({
            ok: true,
            data: {
                message: message({ clientMessageId: input.clientMessageId }),
                reach: [],
                duplicate: false,
            },
        }));
        const { result } = renderOutbox();
        await waitFor(() => expect(result.current.loadState).toBe('ready'));

        await act(() => result.current.send('Can you pull the numbers?'));

        expect(result.current.rows).toHaveLength(1);
        expect(result.current.rows[0].source).toBe('server');
        expect(window.localStorage.getItem(CHAT_OUTBOX_STORAGE_KEY)).toBe('{}');
    });

    it('keeps a rate-limited message with its reason, across a reload', async () => {
        actions.sendConversationMessage.mockResolvedValue({
            ok: false,
            status: 429,
            failureCode: 'rate_limited',
            details: {},
        });
        const first = renderOutbox();
        await waitFor(() => expect(first.result.current.loadState).toBe('ready'));
        await act(() => first.result.current.send('Can you pull the numbers?'));

        const failed = localRow(first.result.current.rows);
        expect(failed?.source === 'local' && failed.entry.status).toBe('failed');
        expect(failed?.source === 'local' && failed.entry.failureCode).toBe('rate_limited');
        first.unmount();

        const reloaded = renderOutbox();
        await waitFor(() => expect(localRow(reloaded.result.current.rows)).toBeDefined());
        const restored = localRow(reloaded.result.current.rows);
        expect(restored?.source === 'local' && restored.entry.body).toBe(
            'Can you pull the numbers?',
        );
    });

    it('sends only upload ids, and keeps a refused message’s files by name across a reload', async () => {
        actions.sendConversationMessage.mockResolvedValue({
            ok: false,
            status: 503,
            failureCode: 'provider_unavailable',
            details: {},
        });
        const file = {
            uploadId: 'a'.repeat(64),
            filename: 'pricing.pdf',
            mimeType: 'application/pdf',
            url: `/api/uploads/u-1/${'a'.repeat(64)}.pdf`,
        };
        const first = renderOutbox();
        await waitFor(() => expect(first.result.current.loadState).toBe('ready'));
        await act(() => first.result.current.send('pricing.pdf', [file]));

        const [, sent] = actions.sendConversationMessage.mock.calls[0];
        expect(sent.attachments).toEqual([{ uploadId: file.uploadId }]);
        first.unmount();

        const reloaded = renderOutbox();
        await waitFor(() => expect(localRow(reloaded.result.current.rows)).toBeDefined());
        const restored = localRow(reloaded.result.current.rows);
        expect(restored?.source === 'local' && restored.entry.attachments).toEqual([file]);
    });

    it('never retries on its own', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            actions.sendConversationMessage.mockResolvedValue({
                ok: false,
                status: 503,
                failureCode: 'provider_unavailable',
                details: {},
            });
            const { result } = renderOutbox();
            await waitFor(() => expect(result.current.loadState).toBe('ready'));
            await act(() => result.current.send('hello'));
            await act(async () => {
                vi.advanceTimersByTime(120_000);
            });
            expect(actions.sendConversationMessage).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('retries with the original client id, and two fast taps send once', async () => {
        actions.sendConversationMessage.mockResolvedValueOnce({
            ok: false,
            status: 0,
            failureCode: 'network',
            details: {},
        });
        const { result } = renderOutbox();
        await waitFor(() => expect(result.current.loadState).toBe('ready'));
        await act(() => result.current.send('hello'));
        const failed = localRow(result.current.rows);
        if (failed?.source !== 'local') throw new Error('expected a failed local row');

        let release: () => void = () => undefined;
        actions.sendConversationMessage.mockImplementationOnce(
            (_id, input) =>
                new Promise((resolve) => {
                    release = () =>
                        resolve({
                            ok: true,
                            data: {
                                message: message({ clientMessageId: input.clientMessageId }),
                                reach: [],
                                duplicate: false,
                            },
                        });
                }),
        );

        let firstTap: Promise<void> = Promise.resolve();
        let secondTap: Promise<void> = Promise.resolve();
        act(() => {
            firstTap = result.current.retry(failed);
            secondTap = result.current.retry(failed);
        });
        // The first tap is on its way (the send was issued); the second did nothing.
        await waitFor(() => expect(actions.sendConversationMessage).toHaveBeenCalledTimes(2));
        await act(async () => {
            release();
            await Promise.all([firstTap, secondTap]);
        });

        expect(actions.sendConversationMessage).toHaveBeenCalledTimes(2);
        const [, retried] = actions.sendConversationMessage.mock.calls[1];
        expect(retried.clientMessageId).toBe(failed.entry.clientMessageId);
        expect(result.current.rows.filter((row) => row.source === 'server')).toHaveLength(1);
        expect(readOutbox(CONVERSATION)).toEqual([]);
    });

    it('discards a failed message locally and permanently', async () => {
        actions.sendConversationMessage.mockResolvedValue({
            ok: false,
            status: 400,
            failureCode: 'secret_detected',
            details: {},
        });
        const { result } = renderOutbox();
        await waitFor(() => expect(result.current.loadState).toBe('ready'));
        await act(() => result.current.send('token=abc'));
        const failed = localRow(result.current.rows);
        if (!failed) throw new Error('expected a failed row');

        await act(() => result.current.discard(failed));

        expect(result.current.rows).toHaveLength(0);
        expect(readOutbox(CONVERSATION)).toEqual([]);
    });

    it('retries a message the server stored and then failed through its id, once per tap burst', async () => {
        const stored = message({ status: 'failed', failureCode: 'capacity_limited' });
        actions.listConversationMessages.mockResolvedValue({
            ok: true,
            data: { messages: [stored] },
        });
        let release: () => void = () => undefined;
        actions.retryConversationMessage.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = () =>
                        resolve({
                            ok: true,
                            data: {
                                message: { ...stored, status: 'sent', failureCode: null },
                                reach: [],
                                duplicate: false,
                            },
                        });
                }),
        );
        const { result } = renderOutbox();
        await waitFor(() => expect(result.current.rows).toHaveLength(1));
        const row = result.current.rows[0];

        let taps: Promise<void>[] = [];
        act(() => {
            taps = [result.current.retry(row), result.current.retry(row)];
        });
        expect(result.current.rows[0].source === 'server' && result.current.rows[0].retrying).toBe(
            true,
        );
        await act(async () => {
            release();
            await Promise.all(taps);
        });

        expect(actions.retryConversationMessage).toHaveBeenCalledTimes(1);
        expect(actions.retryConversationMessage).toHaveBeenCalledWith(CONVERSATION, 'm-1');
        const after = result.current.rows[0];
        expect(after.source === 'server' && after.message.status).toBe('sent');
    });

    it('keeps a failed first message of a brand-new Conversation under its draft', async () => {
        const { result } = renderHook(() =>
            useConversationOutbox({
                conversationId: null,
                draftKey: 'draft:a-1',
                ensureConversation: async () => ({
                    ok: false,
                    status: 0,
                    failureCode: 'network',
                    details: {},
                }),
            }),
        );
        await act(() => result.current.send('first words'));
        expect(readOutbox('draft:a-1').map((entry) => entry.body)).toEqual(['first words']);
        expect(actions.sendConversationMessage).not.toHaveBeenCalled();
    });

    /** A load of `c-old` that answers only when the test says so. */
    function holdOldLoad(messages: ConversationMessageView[]) {
        const held = { release: () => undefined as void };
        actions.listConversationMessages.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    held.release = () => resolve({ ok: true, data: { messages } });
                }),
        );
        return held;
    }

    const oldMessage = message({
        id: 'm-old',
        conversationId: 'c-old',
        content: 'From the previous conversation',
    });

    it('never shows a slow load of the previous Conversation in a fresh one', async () => {
        const held = holdOldLoad([oldMessage]);
        const { result, rerender } = renderOutbox('c-old');
        await waitFor(() =>
            expect(actions.listConversationMessages).toHaveBeenCalledWith('c-old', { limit: 100 }),
        );

        rerender({ conversationId: null });
        await waitFor(() => expect(result.current.loadState).toBe('ready'));
        await act(async () => {
            held.release();
        });

        expect(result.current.rows).toEqual([]);
        expect(result.current.loadState).toBe('ready');
    });

    it('never shows a slow load of the previous Conversation in the next one', async () => {
        const held = holdOldLoad([oldMessage]);
        const { result, rerender } = renderOutbox('c-old');
        await waitFor(() => expect(actions.listConversationMessages).toHaveBeenCalledTimes(1));

        actions.listConversationMessages.mockResolvedValue({
            ok: true,
            data: { messages: [message({ id: 'm-2', conversationId: 'c-2' })] },
        });
        rerender({ conversationId: 'c-2' });
        await waitFor(() => expect(result.current.rows).toHaveLength(1));
        await act(async () => {
            held.release();
        });

        expect(result.current.rows.map((row) => row.source === 'server' && row.message.id)).toEqual(
            ['m-2'],
        );
    });

    it('never lets an older load of the same Conversation roll back a newer one', async () => {
        const held = holdOldLoad([message({ id: 'm-1' })]);
        const { result } = renderOutbox();
        await waitFor(() => expect(actions.listConversationMessages).toHaveBeenCalledTimes(1));

        actions.listConversationMessages.mockResolvedValue({
            ok: true,
            data: {
                messages: [
                    message({ id: 'm-1' }),
                    message({ id: 'm-2', createdAt: '2026-09-14T09:01:00.000Z' }),
                ],
            },
        });
        await act(() => result.current.reload());
        expect(result.current.rows).toHaveLength(2);
        await act(async () => {
            held.release();
        });

        expect(result.current.rows).toHaveLength(2);
    });

    it('never merges a Retry answered after the view moved to another Conversation', async () => {
        const stored = message({
            id: 'm-old',
            conversationId: 'c-old',
            status: 'failed',
            failureCode: 'capacity_limited',
        });
        actions.listConversationMessages.mockResolvedValueOnce({
            ok: true,
            data: { messages: [stored] },
        });
        let release: () => void = () => undefined;
        actions.retryConversationMessage.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = () =>
                        resolve({
                            ok: true,
                            data: {
                                message: { ...stored, status: 'sent', failureCode: null },
                                reach: [],
                                duplicate: false,
                            },
                        });
                }),
        );
        const { result, rerender } = renderOutbox('c-old');
        await waitFor(() => expect(result.current.rows).toHaveLength(1));
        const row = result.current.rows[0];

        let tap: Promise<void> = Promise.resolve();
        act(() => {
            tap = result.current.retry(row);
        });
        rerender({ conversationId: null });
        await waitFor(() => expect(result.current.rows).toEqual([]));
        await act(async () => {
            release();
            await tap;
        });

        expect(result.current.rows).toEqual([]);
    });

    it('asks to leave a Conversation that is gone', async () => {
        actions.listConversationMessages.mockResolvedValue({
            ok: false,
            status: 404,
            failureCode: 'forbidden',
            details: {},
        });
        const onGone = vi.fn();
        renderHook(() =>
            useConversationOutbox({
                conversationId: CONVERSATION,
                draftKey: 'draft:a-1',
                ensureConversation: async () => ({ ok: true, data: CONVERSATION }),
                onGone,
            }),
        );
        await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1));
    });
});

describe('outbox helpers', () => {
    it('makes client ids the API accepts', () => {
        const id = newClientMessageId();
        expect(id).toMatch(/^[A-Za-z0-9_:.-]+$/);
        expect(id.length).toBeLessThanOrEqual(64);
        expect(newClientMessageId()).not.toBe(id);
    });

    it('merges a pushed message in time order without duplicating it', () => {
        const later = message({ id: 'm-2', createdAt: '2026-09-14T09:05:00.000Z' });
        const earlier = message({ id: 'm-1' });
        const merged = mergeMessage([later], earlier);
        expect(merged.map((row) => row.id)).toEqual(['m-1', 'm-2']);
        expect(mergeMessage(merged, { ...later, status: 'failed' })).toHaveLength(2);
    });

    it('orders messages that share a timestamp by id, as the server does', () => {
        const at = '2026-09-14T09:00:00.000Z';
        const high = message({ id: 'f0000000-0000-4000-8000-000000000000', createdAt: at });
        const low = message({ id: '10000000-0000-4000-8000-000000000000', createdAt: at });
        expect(mergeMessage([high], low).map((row) => row.id)).toEqual([low.id, high.id]);
        expect(mergeMessage([low], high).map((row) => row.id)).toEqual([low.id, high.id]);
    });

    it('tells offline apart from a dropped connection', () => {
        const online = vi.spyOn(window.navigator, 'onLine', 'get');
        online.mockReturnValue(false);
        expect(failureCodeOf({ status: 0, failureCode: 'network' })).toBe('offline');
        online.mockReturnValue(true);
        expect(failureCodeOf({ status: 0, failureCode: 'network' })).toBe('network');
        expect(failureCodeOf({ status: 500, failureCode: null })).toBe('provider_unavailable');
        online.mockRestore();
    });
});
