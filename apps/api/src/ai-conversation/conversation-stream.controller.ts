import { Controller, Get, ParseUUIDPipe, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConversationMessageService, ConversationService } from '@ever-works/agent/conversations';
import type { ConversationMessageStatus } from '@ever-works/contracts';
import { CurrentUser } from '../auth/decorators/user.decorator';
import { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope/scope-context.service';

/**
 * Minimal structural types for the raw response/request — the same shape the
 * email stream uses, because `express` types are not in the api tsconfig.
 */
export type ConversationSseResponse = {
    setHeader(name: string, value: string): void;
    flushHeaders?(): void;
    write(chunk: string): void;
    end(): void;
    readonly writableEnded?: boolean;
    on(event: 'close', listener: () => void): void;
};

export type ConversationSseRequest = {
    on(event: 'close', listener: () => void): void;
    socket?: {
        on(event: 'close', listener: () => void): void;
        readonly destroyed?: boolean;
    };
};

/** How often the stream looks for new messages (FR-22: visible within 5 s). */
export const CONVERSATION_STREAM_POLL_MS = 5_000;
/** Comment line that keeps proxies from closing an idle stream. */
export const CONVERSATION_STREAM_HEARTBEAT_MS = 15_000;
/** Forced lifetime; the client reconnects, or falls back to polling (FR-23). */
export const CONVERSATION_STREAM_MAX_LIFETIME_MS = 10 * 60 * 1000;
/** Page size for each read: new messages since the cursor, and the newest window. */
const STREAM_WINDOW = 50;
/**
 * Statuses a message can still move out of. A person's message is refused
 * (`sent` → `failed`) by the reply job long after it was written, and a Retry
 * sends it again (`failed` → `sent`), so neither is an end state.
 */
const STREAM_UNSETTLED_STATUSES: ConversationMessageStatus[] = ['sending', 'failed'];
/** Cap on the ids one status refresh carries, so a long-lived stream stays bounded. */
export const STREAM_MAX_WATCHED_IDS = 100;
/**
 * Pages one poll reads before yielding to the next tick. Only bounds the work
 * of a single poll: the cursor is kept, so the next poll carries on from it.
 */
export const STREAM_MAX_PAGES_PER_POLL = 20;

/** The last message a stream has paged past. */
type StreamCursor = { id: string; createdAt: Date | string };

/**
 * Live delivery for the open Conversation — server-sent events.
 *
 * The same poll-diff transport as the Agent inbox stream
 * (`email.controller.ts`): no broker, so the deployment surface does not
 * change. The first poll primes the seen-set so the backlog is never
 * announced as new, and sets a cursor at the newest message. Every later poll
 * first pages forward from that cursor until it is caught up — so a burst of
 * any size is delivered in full, in order — then re-reads the newest window
 * to emit any message whose send status changed (a `failed` one, for instance),
 * and finally re-reads the messages that can still change but have already
 * scrolled out of that window, so a late refusal or a Retry is delivered
 * however busy the Conversation got in the meantime.
 * A 15 s heartbeat comment keeps the connection open, the stream is closed
 * after 10 minutes, and every timer is cleared on close. The close handlers
 * are registered before the first read, so a client that leaves during it
 * cannot leave timers behind. Poll errors are swallowed — the heartbeat keeps
 * the stream up and the client already polls if it drops.
 *
 * Its own controller, registered BEFORE `ConversationController` in the
 * module, so `GET /api/conversations/stream` is never captured by `:id`.
 */
@ApiTags('Conversations')
@ApiBearerAuth('JWT-auth')
@Controller('api/conversations')
export class ConversationStreamController {
    constructor(
        private readonly conversations: ConversationService,
        private readonly messages: ConversationMessageService,
        private readonly scopeContext: ScopeContextService,
    ) {}

    @Get('stream')
    @ApiOperation({ summary: 'SSE stream of new messages in a conversation' })
    async stream(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('conversationId', ParseUUIDPipe) conversationId: string,
        @Res() res: ConversationSseResponse,
        @Req() req: ConversationSseRequest,
    ): Promise<void> {
        const scope = this.scopeContext.getScope();
        // Before any header is written, so a caller who may not read the
        // Conversation gets a plain 404 rather than an empty stream.
        await this.conversations.assertParticipant(conversationId, auth.userId, scope);

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        const seen = new Map<string, string>();
        // Ids this connection last saw in a status that can still move. They
        // are re-read by id on every poll, so a change reaches the client even
        // after newer traffic pushed the message out of the newest window.
        const watched = new Set<string>();
        let closed = false;
        let primed = false;
        // The newest message this connection has walked past. Only paging
        // moves it, so every message written after it is read before it moves.
        let cursor: StreamCursor | null = null;

        type StreamRow = Awaited<ReturnType<ConversationMessageService['listMessages']>>[number];
        const emit = (row: StreamRow) => {
            const status = row.status ?? 'sent';
            if (STREAM_UNSETTLED_STATUSES.includes(status as ConversationMessageStatus)) {
                // Re-inserted, so the set reads most-recently-seen last, and
                // trimmed, so one long-lived connection to a Conversation with
                // a long tail of failed sends cannot grow it without bound.
                watched.delete(row.id);
                watched.add(row.id);
                while (watched.size > STREAM_MAX_WATCHED_IDS) {
                    const oldest = watched.values().next().value;
                    if (oldest === undefined) break;
                    watched.delete(oldest);
                }
            } else {
                watched.delete(row.id);
            }
            if (seen.get(row.id) === status) return;
            seen.set(row.id, status);
            if (primed && !closed) {
                res.write(
                    `event: message\ndata: ${JSON.stringify({
                        type: 'message',
                        conversationId,
                        message: row,
                    })}\n\n`,
                );
            }
        };

        // One poll at a time: a poll paging through a large burst can outlast
        // the interval, and two overlapping polls would move the cursor
        // out of order.
        let polling = false;

        const poll = async () => {
            if (closed || polling) return;
            polling = true;
            try {
                if (primed) {
                    // 1. Everything written since the cursor, page by page until
                    //    caught up. A fixed newest-N window would let the oldest
                    //    rows of a burst larger than N fall out of view before
                    //    this connection ever saw them.
                    for (let page = 0; page < STREAM_MAX_PAGES_PER_POLL && !closed; page += 1) {
                        const rows = await this.messages.listMessagesAfter(
                            auth.userId,
                            conversationId,
                            { limit: STREAM_WINDOW, after: cursor },
                            scope,
                        );
                        for (const row of rows) emit(row);
                        const last = rows[rows.length - 1];
                        if (last) cursor = { id: last.id, createdAt: last.createdAt };
                        // A short page means caught up; a capped poll resumes
                        // from the cursor on the next tick, so nothing is lost.
                        if (rows.length < STREAM_WINDOW) break;
                    }
                }
                // 2. The newest window again, for status changes on messages
                //    already sent (a send that failed, a Retry that went out).
                const rows = await this.messages.listMessages(
                    auth.userId,
                    conversationId,
                    { limit: STREAM_WINDOW },
                    scope,
                );
                for (const row of rows) emit(row);
                if (!primed) {
                    const newest = rows[rows.length - 1];
                    cursor = newest ? { id: newest.id, createdAt: newest.createdAt } : null;
                }
                // 3. Status changes on messages that are NOT in that window —
                //    a message still waiting for its outcome is pushed out of
                //    the newest 50 by later traffic, and its `failed` (or a
                //    Retry's `sent`) would otherwise never reach this
                //    connection. Read by status and by the ids still watched,
                //    so both directions of the change are delivered. Its own
                //    try: a failure here must not leave the stream unprimed,
                //    which would announce the whole backlog as new.
                if (!closed) {
                    const inWindow = new Set(rows.map((row) => row.id));
                    try {
                        const watchedIds = [...watched]
                            .filter((id) => !inWindow.has(id))
                            .slice(-STREAM_MAX_WATCHED_IDS);
                        const unsettled = await this.messages.listUnsettledMessages(
                            auth.userId,
                            conversationId,
                            {
                                statuses: STREAM_UNSETTLED_STATUSES,
                                watchedIds,
                                limit: STREAM_WINDOW,
                            },
                            scope,
                        );
                        for (const row of unsettled) {
                            if (!inWindow.has(row.id)) emit(row);
                        }
                    } catch {
                        // Swallowed on purpose — see the class note.
                    }
                }
                primed = true;
            } catch {
                // Swallowed on purpose — see the class note.
            } finally {
                polling = false;
            }
        };

        // Timers and close handlers are wired BEFORE the first read. A client
        // that disconnects while that read is in flight would otherwise miss
        // the close event entirely, and the stream would go on polling the
        // database and writing heartbeats into a dead socket until the
        // ten-minute lifetime timer fired.
        let pollTimer: ReturnType<typeof setInterval> | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let maxLifetime: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
            if (closed) return;
            closed = true;
            if (pollTimer) clearInterval(pollTimer);
            if (heartbeat) clearInterval(heartbeat);
            if (maxLifetime) clearTimeout(maxLifetime);
            if (!res.writableEnded) res.end();
        };

        req.on('close', cleanup);
        res.on('close', cleanup);
        req.socket?.on('close', cleanup);

        await poll();

        // The client may have gone while the first read ran — a close event
        // already handled, or a socket torn down without one. Either way
        // nothing is scheduled.
        if (closed || res.writableEnded || req.socket?.destroyed) {
            cleanup();
            return;
        }

        pollTimer = setInterval(() => void poll(), CONVERSATION_STREAM_POLL_MS);
        heartbeat = setInterval(() => {
            if (!closed) res.write(': ping\n\n');
        }, CONVERSATION_STREAM_HEARTBEAT_MS);
        maxLifetime = setTimeout(cleanup, CONVERSATION_STREAM_MAX_LIFETIME_MS);
    }
}
