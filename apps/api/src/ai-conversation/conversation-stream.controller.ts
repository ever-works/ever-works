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
/** Newest messages each poll compares against what this connection already sent. */
const STREAM_WINDOW = 50;

/**
 * Live delivery for the open Conversation — server-sent events.
 *
 * The same poll-diff transport as the Agent inbox stream
 * (`email.controller.ts`): no broker, so the deployment surface does not
 * change. The first poll primes the seen-set so the backlog is never
 * announced as new; every later poll emits the messages it has not sent yet,
 * plus any message whose send status changed (a `failed` one, for instance).
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

        const poll = async () => {
            if (closed) return;
            try {
                const rows = await this.messages.listMessages(
                    auth.userId,
                    conversationId,
                    { limit: STREAM_WINDOW },
                    scope,
                );
                for (const row of rows) {
                    const status = row.status ?? 'sent';
                    if (seen.get(row.id) === status) continue;
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
                }
                primed = true;
            } catch {
                // Swallowed on purpose — see the class note.
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
