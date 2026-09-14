import { Controller, Get, ParseUUIDPipe, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConversationMessageService, ConversationService } from '@ever-works/agent/conversations';
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
    socket?: { on(event: 'close', listener: () => void): void };
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
 * to emit any message whose send status changed (a `failed` one, for instance).
 * A 15 s heartbeat comment keeps the connection open, the stream is closed
 * after 10 minutes, and every timer is cleared on close. Poll errors are
 * swallowed — the heartbeat keeps the stream up and the client already polls
 * if it drops.
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
        let closed = false;
        let primed = false;
        // The newest message this connection has walked past. Only paging
        // moves it, so every message written after it is read before it moves.
        let cursor: StreamCursor | null = null;

        type StreamRow = Awaited<ReturnType<ConversationMessageService['listMessages']>>[number];
        const emit = (row: StreamRow) => {
            const status = row.status ?? 'sent';
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
                primed = true;
            } catch {
                // Swallowed on purpose — see the class note.
            } finally {
                polling = false;
            }
        };

        await poll();
        const pollTimer = setInterval(() => void poll(), CONVERSATION_STREAM_POLL_MS);
        const heartbeat = setInterval(() => {
            if (!closed) res.write(': ping\n\n');
        }, CONVERSATION_STREAM_HEARTBEAT_MS);
        let maxLifetime: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
            if (closed) return;
            closed = true;
            clearInterval(pollTimer);
            clearInterval(heartbeat);
            if (maxLifetime) clearTimeout(maxLifetime);
            if (!res.writableEnded) res.end();
        };

        maxLifetime = setTimeout(cleanup, CONVERSATION_STREAM_MAX_LIFETIME_MS);
        req.on('close', cleanup);
        res.on('close', cleanup);
        req.socket?.on('close', cleanup);
    }
}
