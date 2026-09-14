jest.mock('@ever-works/agent/conversations', () => ({
    ConversationService: class {},
    ConversationMessageService: class {},
}));

import { NotFoundException } from '@nestjs/common';
import {
    CONVERSATION_STREAM_HEARTBEAT_MS,
    CONVERSATION_STREAM_MAX_LIFETIME_MS,
    CONVERSATION_STREAM_POLL_MS,
    ConversationStreamController,
} from './conversation-stream.controller';

const SCOPE = { tenantId: 't1', organizationId: 'o1' };
const CONVERSATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const auth = { userId: 'user-1' } as never;

function fakeResponse() {
    const listeners: Array<() => void> = [];
    const res = {
        headers: {} as Record<string, string>,
        chunks: [] as string[],
        writableEnded: false,
        setHeader: jest.fn((name: string, value: string) => {
            res.headers[name] = value;
        }),
        flushHeaders: jest.fn(),
        write: jest.fn((chunk: string) => {
            res.chunks.push(chunk);
        }),
        end: jest.fn(() => {
            res.writableEnded = true;
        }),
        on: jest.fn((_event: 'close', listener: () => void) => listeners.push(listener)),
        close: () => listeners.forEach((listener) => listener()),
    };
    return res;
}

function fakeRequest() {
    const listeners: Array<() => void> = [];
    return {
        on: jest.fn((_event: 'close', listener: () => void) => listeners.push(listener)),
        socket: { on: jest.fn() },
        close: () => listeners.forEach((listener) => listener()),
    };
}

/** Let the awaited poll inside a timer callback settle. */
const flush = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('ConversationStreamController', () => {
    let conversations: { assertParticipant: jest.Mock };
    let messages: { listMessages: jest.Mock; listMessagesAfter: jest.Mock };
    let controller: ConversationStreamController;

    beforeEach(() => {
        jest.useFakeTimers();
        conversations = { assertParticipant: jest.fn().mockResolvedValue({ id: CONVERSATION_ID }) };
        messages = {
            listMessages: jest.fn().mockResolvedValue([]),
            listMessagesAfter: jest.fn().mockResolvedValue([]),
        };
        controller = new ConversationStreamController(
            conversations as any,
            messages as any,
            {
                getScope: () => SCOPE,
            } as any,
        );
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('404s before writing any header for a Conversation the caller may not read', async () => {
        conversations.assertParticipant.mockRejectedValue(new NotFoundException());
        const res = fakeResponse();
        await expect(
            controller.stream(auth, CONVERSATION_ID, res as any, fakeRequest() as any),
        ).rejects.toThrow(NotFoundException);
        expect(res.setHeader).not.toHaveBeenCalled();
        expect(conversations.assertParticipant).toHaveBeenCalledWith(
            CONVERSATION_ID,
            'user-1',
            SCOPE,
        );
    });

    it('sets event-stream headers and does not announce the backlog', async () => {
        messages.listMessages.mockResolvedValue([{ id: 'm1', status: 'sent' }]);
        const res = fakeResponse();

        await controller.stream(auth, CONVERSATION_ID, res as any, fakeRequest() as any);

        expect(res.headers).toMatchObject({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
        });
        expect(res.chunks).toEqual([]);
        expect(messages.listMessages).toHaveBeenCalledWith(
            'user-1',
            CONVERSATION_ID,
            { limit: 50 },
            SCOPE,
        );
        res.close();
    });

    it('emits new messages and status changes on later polls, and a heartbeat comment', async () => {
        messages.listMessages.mockResolvedValueOnce([{ id: 'm1', status: 'sent' }]);
        const res = fakeResponse();
        await controller.stream(auth, CONVERSATION_ID, res as any, fakeRequest() as any);

        messages.listMessages.mockResolvedValue([
            { id: 'm1', status: 'failed' },
            { id: 'm2', status: 'sent' },
        ]);
        jest.advanceTimersByTime(CONVERSATION_STREAM_POLL_MS);
        await flush();

        const events = res.chunks.filter((chunk) => chunk.startsWith('event: message'));
        expect(events).toHaveLength(2);
        expect(events[0]).toContain('"id":"m1"');
        expect(events[0]).toContain('"status":"failed"');
        expect(events[1]).toContain('"id":"m2"');

        jest.advanceTimersByTime(CONVERSATION_STREAM_POLL_MS);
        await flush();
        expect(res.chunks.filter((chunk) => chunk.startsWith('event: message'))).toHaveLength(2);

        jest.advanceTimersByTime(CONVERSATION_STREAM_HEARTBEAT_MS);
        expect(res.chunks).toContain(': ping\n\n');
        res.close();
    });

    it('delivers every message of a burst larger than one page, oldest first', async () => {
        // A Conversation store: the newest-window read and the cursor read
        // both look at the same rows, as the database would.
        const store: Array<{ id: string; status: string; createdAt: Date }> = [];
        const write = (id: string) =>
            store.push({ id, status: 'sent', createdAt: new Date(1_000 + store.length) });
        write('m0');
        messages.listMessages.mockImplementation(
            async (_user: string, _conversation: string, options: { limit: number }) =>
                store.slice(-options.limit),
        );
        messages.listMessagesAfter.mockImplementation(
            async (
                _user: string,
                _conversation: string,
                options: { limit: number; after: { id: string } | null },
            ) => {
                const start = options.after
                    ? store.findIndex((row) => row.id === options.after?.id) + 1
                    : 0;
                return store.slice(start, start + options.limit);
            },
        );
        const res = fakeResponse();
        await controller.stream(auth, CONVERSATION_ID, res as any, fakeRequest() as any);
        expect(res.chunks).toEqual([]);

        // 51 messages land between two polls — one more than a page holds.
        const burst = Array.from({ length: 51 }, (_, i) => `n${i + 1}`);
        burst.forEach(write);
        jest.advanceTimersByTime(CONVERSATION_STREAM_POLL_MS);
        for (let i = 0; i < 50; i += 1) await Promise.resolve();

        const delivered = res.chunks
            .filter((chunk) => chunk.startsWith('event: message'))
            .map((chunk) => JSON.parse(chunk.split('data: ')[1]).message.id);
        expect(delivered).toEqual(burst);
        // Paged from the cursor at the newest message it had seen, then on.
        expect(messages.listMessagesAfter).toHaveBeenCalledWith(
            'user-1',
            CONVERSATION_ID,
            { limit: 50, after: expect.objectContaining({ id: 'm0' }) },
            SCOPE,
        );

        // Nothing is announced twice on the next poll.
        jest.advanceTimersByTime(CONVERSATION_STREAM_POLL_MS);
        for (let i = 0; i < 50; i += 1) await Promise.resolve();
        expect(res.chunks.filter((chunk) => chunk.startsWith('event: message'))).toHaveLength(51);
        res.close();
    });

    it('swallows a failing poll and keeps the stream open', async () => {
        const res = fakeResponse();
        await controller.stream(auth, CONVERSATION_ID, res as any, fakeRequest() as any);
        messages.listMessages.mockRejectedValue(new Error('db down'));

        jest.advanceTimersByTime(CONVERSATION_STREAM_POLL_MS);
        await flush();

        expect(res.end).not.toHaveBeenCalled();
        res.close();
    });

    it('closing the client clears both timers and ends the response once', async () => {
        const res = fakeResponse();
        const req = fakeRequest();
        await controller.stream(auth, CONVERSATION_ID, res as any, req as any);
        expect(jest.getTimerCount()).toBe(3);

        req.close();
        res.close();

        expect(jest.getTimerCount()).toBe(0);
        expect(res.end).toHaveBeenCalledTimes(1);
        const calls = messages.listMessages.mock.calls.length;
        jest.advanceTimersByTime(CONVERSATION_STREAM_POLL_MS * 3);
        await flush();
        expect(messages.listMessages.mock.calls.length).toBe(calls);
    });

    it('forces the stream closed after ten minutes', async () => {
        const res = fakeResponse();
        await controller.stream(auth, CONVERSATION_ID, res as any, fakeRequest() as any);

        jest.advanceTimersByTime(CONVERSATION_STREAM_MAX_LIFETIME_MS);
        await flush();

        expect(res.end).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });
});
