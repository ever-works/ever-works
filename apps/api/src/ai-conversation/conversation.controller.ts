import {
    BadRequestException,
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Patch,
    Body,
    Param,
    ParseUUIDPipe,
    Query,
    HttpCode,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    ArrayMaxSize,
    IsArray,
    IsIn,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
    ValidateIf,
    ValidateNested,
    isUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
    CONVERSATION_CONTEXT_TYPES,
    CONVERSATION_KINDS,
    isConversationContextType,
    isConversationKind,
    type ConversationContextType,
    type ConversationKind,
} from '@ever-works/contracts';
import { CurrentUser } from '../auth/decorators/user.decorator';
import { AuthenticatedUser } from '../auth/types/auth.types';
import { ConversationRepository } from '@ever-works/agent/database';
import {
    ConversationMentionService,
    ConversationMessageService,
    ConversationService,
} from '@ever-works/agent/conversations';
import { ScopeContextService } from '../scope/scope-context.service';
import { ConversationTitleService } from './conversation-title.service';
import {
    ConversationNameDto,
    MarkConversationReadDto,
    SendConversationMessageDto,
} from './dto/conversation.dto';

// Largest page size a client may request from `GET /api/conversations`.
// Security (DoS): the `limit` query param is otherwise passed straight to
// TypeORM's `take`, so an authenticated caller could request e.g.
// `?limit=1000000` and force a large table scan on the shared DB. Mirrors
// the `@Max(200)` cap used by `ListAgentsQueryDto` (see `dto/agent.dto.ts`).
const MAX_CONVERSATIONS_PAGE_SIZE = 200;

/** Default and largest page of `GET /api/conversations/:id/messages`. */
const DEFAULT_MESSAGES_PAGE_SIZE = 50;
const MAX_MESSAGES_PAGE_SIZE = 200;
/** Longest `q` the mention picker may send. */
const MAX_MENTION_QUERY_CHARS = 80;
/** Every write added for named Conversations: 30 per person per minute (FR-47). */
const CONVERSATION_WRITE_THROTTLE = { long: { limit: 30, ttl: 60_000 } };

/**
 * Body for `POST /api/conversations`.
 *
 * Security: replaces a plain object literal (which the global
 * ValidationPipe cannot enforce — no class-validator metadata) so the
 * `title` length is bounded before it reaches the DB. Caps mirror the
 * Agent title/provider caps in `dto/agent.dto.ts`.
 */
class CreateConversationDto {
    @ApiProperty({ required: false, maxLength: 200 })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    title?: string;

    @ApiProperty({ required: false, maxLength: 100 })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    providerId?: string;

    /**
     * Model the thread starts pinned to. Optional and unvalidated against any
     * catalogue on purpose — same posture as `providerId` above: the UI only
     * OFFERS reachable models, but the record layer stays permissive so a
     * self-hosted / custom model id is never rejected by the platform.
     */
    @ApiProperty({ required: false, maxLength: 100 })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    model?: string;

    // ── Named Conversations with Agents. All optional: a body that sends
    // none of them creates exactly the Conversation it always did.

    /** Only `direct` can be opened here today. */
    @ApiProperty({ required: false, enum: CONVERSATION_KINDS })
    @IsOptional()
    @IsIn(CONVERSATION_KINDS)
    kind?: ConversationKind;

    /** The Agent a `direct` Conversation is addressed at — fixed for its lifetime. */
    @ApiProperty({ required: false, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    agentId?: string;

    /** What the Conversation is about — fixed at creation. Sent with `contextId`. */
    @ApiProperty({ required: false, enum: CONVERSATION_CONTEXT_TYPES })
    @IsOptional()
    @IsIn(CONVERSATION_CONTEXT_TYPES)
    contextType?: ConversationContextType;

    @ApiProperty({ required: false, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    contextId?: string;
}

/**
 * Body for `PATCH /api/conversations/:id`.
 *
 * Security: caps the title length so a megabyte-sized string can no longer
 * be persisted verbatim (DB / response bloat). Mirrors the Agent title cap.
 *
 * `providerId` is deliberately ABSENT from this whitelist. With the global
 * ValidationPipe's `forbidNonWhitelisted`, sending it is a hard 400 rather
 * than a silent drop — a conversation's provider is the thread's identity and
 * is immutable after creation. `model` IS whitelisted because it is a dial
 * inside one thread, not identity: the user re-points the same provider at a
 * different model mid-conversation and the pin has to survive a reload.
 */
export class UpdateConversationDto {
    /**
     * 🛑 `@ValidateIf`, deliberately NOT `@IsOptional()`.
     *
     * `@IsOptional()` skips every other validator when the value is `null` as
     * well as when it is `undefined` — class-validator's condition is literally
     * `value !== null && value !== undefined`. With it, `PATCH {"title": null}`
     * sailed past `@IsString`, then satisfied the handler's
     * `body.title !== undefined` guard (because `null !== undefined`) and WROTE
     * NULL over the user's title. That was a hard 400 before this field became
     * optional, and the `model` docblock below still claimed non-string
     * payloads were rejected.
     *
     * `@ValidateIf(o => o.title !== undefined)` restores the intent exactly:
     * absent is fine, present-but-not-a-string is a 400.
     */
    @ApiProperty({ required: false, maxLength: 200 })
    @ValidateIf((o: UpdateConversationDto) => o.title !== undefined)
    @IsString()
    @MaxLength(200)
    title?: string;

    /**
     * Empty string clears the pin back to "resolve the provider's configured
     * default". `null` would be the more obvious signal, but the field is
     * typed `string` so the whitelist keeps rejecting non-string payloads.
     *
     * That last sentence is only TRUE because of the `@ValidateIf` below —
     * see the note on `title`. Under `@IsOptional()` a null slipped through to
     * `updateModel`, where it happened to coincide with the clear-the-pin path
     * and so did no damage, but the documented contract was false.
     */
    @ApiProperty({ required: false, maxLength: 100 })
    @ValidateIf((o: UpdateConversationDto) => o.model !== undefined)
    @IsString()
    @MaxLength(100)
    model?: string;
}

// Upper bound on messages accepted in a single append. Real clients send 1-2
// per turn (see apps/web/src/lib/ai/persistence.ts); the cap only stops a
// pathological mega-batch. Content length is bounded by the JSON body-parser
// limit, so no per-message length cap is added here (a future tightening can).
const MAX_MESSAGES_PER_APPEND = 500;

const MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool'] as const;

/**
 * One message in `POST /api/conversations/:id/messages`.
 *
 * Security / robustness: the handler previously took a plain `AIMessage[]`
 * with NO class-validator metadata, so the global ValidationPipe could not
 * police it. A malformed element (non-object, null, missing/typed-wrong
 * `role`/`content`) then threw an UNMAPPED Error mid-loop → HTTP 500 (and,
 * because the batch is not transaction-wrapped, a partial row could leak).
 * It also silently persisted an arbitrary `role` string and non-string
 * `content`. This DTO turns every such shape into a clean 400 BEFORE the
 * handler runs. Fields mirror exactly what the web BFF serialises.
 */
class AppendMessageDto {
    @ApiProperty({ required: false, maxLength: 200 })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    id?: string;

    @ApiProperty({ enum: MESSAGE_ROLES })
    @IsIn(MESSAGE_ROLES)
    role: (typeof MESSAGE_ROLES)[number];

    @ApiProperty()
    @IsString()
    content: string;

    @ApiProperty({ required: false, type: [Object] })
    @IsOptional()
    @IsArray()
    parts?: unknown[];

    @ApiProperty({ required: false, maxLength: 100 })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    model?: string;

    @ApiProperty({ required: false, type: Object })
    @IsOptional()
    @IsObject()
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/**
 * Body for `POST /api/conversations/:id/messages`.
 */
class AppendMessagesDto {
    @ApiProperty({ type: [AppendMessageDto] })
    @IsArray()
    @ArrayMaxSize(MAX_MESSAGES_PER_APPEND)
    @ValidateNested({ each: true })
    @Type(() => AppendMessageDto)
    messages: AppendMessageDto[];
}

@ApiTags('Conversations')
@ApiBearerAuth('JWT-auth')
@Controller('api/conversations')
export class ConversationController {
    constructor(
        private readonly repo: ConversationRepository,
        private readonly titleService: ConversationTitleService,
        // Named Conversations with Agents. Appended LAST + @Optional() so the
        // positional `new ConversationController(repo, titleService)` in the
        // specs keeps compiling, and so every pre-existing route behaves
        // exactly as before whether or not they are bound.
        @Optional() private readonly conversations?: ConversationService,
        @Optional() private readonly messages?: ConversationMessageService,
        @Optional() private readonly mentions?: ConversationMentionService,
        @Optional() private readonly scopeContext?: ScopeContextService,
    ) {}

    @Get()
    @ApiOperation({ summary: 'List conversations' })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
        // Named Conversations — optional filters. A request that sends none
        // of them gets today's response, byte for byte; one that sends any
        // gets the named-list rows (kind, Agent, name source, last activity,
        // unread count) scoped to the active Organization.
        @Query('kind') kind?: string,
        @Query('agentId') agentId?: string,
        @Query('contextType') contextType?: string,
        @Query('contextId') contextId?: string,
    ) {
        // Security (DoS): clamp client-supplied paging so a hostile `limit`
        // (e.g. `?limit=1000000`) cannot be forwarded verbatim to TypeORM's
        // `take` and trigger a large scan on the shared DB. `undefined` is
        // preserved so the repository default (50) still applies.
        const parsedLimit = limit ? parseInt(limit, 10) : undefined;
        const parsedOffset = offset ? parseInt(offset, 10) : undefined;
        const paging = {
            limit:
                parsedLimit === undefined || Number.isNaN(parsedLimit)
                    ? undefined
                    : Math.min(Math.max(parsedLimit, 1), MAX_CONVERSATIONS_PAGE_SIZE),
            offset:
                parsedOffset === undefined || Number.isNaN(parsedOffset)
                    ? undefined
                    : Math.max(parsedOffset, 0),
        };
        const wantsNamedList =
            kind !== undefined ||
            agentId !== undefined ||
            contextType !== undefined ||
            contextId !== undefined;
        if (wantsNamedList && this.conversations) {
            return this.conversations.list(
                auth.userId,
                {
                    ...paging,
                    ...parseListFilters({ kind, agentId, contextType, contextId }),
                },
                this.scope(),
            );
        }
        return this.repo.findByUser(auth.userId, paging);
    }

    @Post()
    @ApiOperation({ summary: 'Create a conversation' })
    async create(@CurrentUser() auth: AuthenticatedUser, @Body() body: CreateConversationDto) {
        const named =
            body.kind !== undefined ||
            body.agentId !== undefined ||
            body.contextType !== undefined ||
            body.contextId !== undefined;
        if (named && this.conversations) {
            return this.conversations.create(
                auth.userId,
                {
                    kind: body.kind,
                    agentId: body.agentId,
                    title: body.title,
                    providerId: body.providerId,
                    model: body.model,
                    contextType: body.contextType,
                    contextId: body.contextId,
                },
                this.scope(),
            );
        }
        return this.repo.create({
            userId: auth.userId,
            title: body.title,
            providerId: body.providerId,
            model: body.model,
        });
    }

    /**
     * The mention picker (FR-25..FR-27): at most eight Agents the caller can
     * address, most recently addressed first. Declared BEFORE `:id` so the
     * uuid pipe never captures `mention-candidates`.
     */
    @Get('mention-candidates')
    @ApiOperation({ summary: 'People and Agents the caller can mention' })
    async mentionCandidates(@CurrentUser() auth: AuthenticatedUser, @Query('q') q?: string) {
        if (!this.mentions) return { candidates: [] };
        if (q !== undefined && q.length > MAX_MENTION_QUERY_CHARS) {
            throw new BadRequestException(
                `q must be at most ${MAX_MENTION_QUERY_CHARS} characters.`,
            );
        }
        const candidates = await this.mentions.resolveCandidates(q ?? '', {
            userId: auth.userId,
            scope: this.scope(),
        });
        return { candidates };
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get conversation with messages' })
    async get(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        const conversation = await this.repo.findById(id, auth.userId);
        if (!conversation) throw new NotFoundException();
        return conversation;
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update conversation title and/or pinned model' })
    @HttpCode(204)
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateConversationDto,
    ) {
        const conversation = await this.repo.findById(id, auth.userId);
        if (!conversation) throw new NotFoundException();
        // Both fields are optional, so each write is guarded independently —
        // a model-only PATCH must not blank the title, and a title-only PATCH
        // (the long-standing shape every existing caller sends) must not clear
        // the model pin.
        if (body.title !== undefined) {
            await this.repo.updateTitle(id, auth.userId, body.title);
        }
        if (body.model !== undefined) {
            await this.repo.updateModel(id, auth.userId, body.model === '' ? null : body.model);
        }
    }

    @Post(':id/messages')
    @ApiOperation({ summary: 'Append messages to a conversation' })
    async appendMessages(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body()
        body: AppendMessagesDto,
    ) {
        const conversation = await this.repo.findById(id, auth.userId);
        if (!conversation) throw new NotFoundException();

        await this.repo.appendMessages(
            body.messages.map((m) => ({
                conversationId: id,
                role: m.role,
                content: m.content,
                parts: m.parts,
                model: m.model,
                usage: m.usage,
            })),
        );

        // Set title from first user message if none exists
        if (!conversation.title) {
            const firstUser = body.messages.find((m) => m.role === 'user');
            if (firstUser?.content) {
                const normalised = firstUser.content.replace(/\s+/g, ' ').trim();
                const title =
                    normalised.length <= 60 ? normalised : normalised.substring(0, 57) + '...';
                await this.repo.updateTitle(id, auth.userId, title);
            }
        }

        // AI title generation in background (fires once at 4+ messages)
        this.titleService.maybeGenerateTitle(id, auth.userId).catch(() => {});

        return { success: true };
    }

    /**
     * Set or clear the name a person gives a Conversation (FR-5, FR-6).
     * `{ "name": "…" }` sets it and stops automatic titling; `{ "name": null }`
     * clears it and lets automatic titling run again.
     */
    @Put(':id/name')
    @Throttle(CONVERSATION_WRITE_THROTTLE)
    @ApiOperation({ summary: 'Set or clear the name of a conversation' })
    async setName(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: ConversationNameDto,
    ) {
        const conversation = await this.requireConversations().rename(
            id,
            auth.userId,
            body.name,
            this.scope(),
        );
        return {
            id: conversation.id,
            title: conversation.title ?? null,
            titleSource: conversation.titleSource ?? null,
        };
    }

    /** A page of messages, oldest first; `before` (a message id) pages backwards. */
    @Get(':id/messages')
    @ApiOperation({ summary: 'List messages of a conversation' })
    async listMessages(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query('limit') limit?: string,
        @Query('before') before?: string,
    ) {
        const parsed = limit ? parseInt(limit, 10) : NaN;
        const pageSize = Number.isNaN(parsed)
            ? DEFAULT_MESSAGES_PAGE_SIZE
            : Math.min(Math.max(parsed, 1), MAX_MESSAGES_PAGE_SIZE);
        if (before !== undefined && !isUUID(before)) {
            throw new BadRequestException('before must be a message id.');
        }
        const messages = await this.requireMessages().listMessages(
            auth.userId,
            id,
            { limit: pageSize, before },
            this.scope(),
        );
        return { messages };
    }

    /**
     * A person's message to the Agents of this Conversation. Returns the
     * stored message and, per addressed Agent, what happened (`delivered`,
     * `queued`, `skipped`, `refused`). A repeated `clientMessageId` returns the
     * first message and starts nothing (FR-41). Refusals carry a
     * `failureCode` so the composer can keep the text and say why.
     */
    @Post(':id/messages/send')
    @HttpCode(202)
    @Throttle(CONVERSATION_WRITE_THROTTLE)
    @ApiOperation({ summary: 'Send a message to the Agents of a conversation' })
    async send(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: SendConversationMessageDto,
    ) {
        return this.requireMessages().send(
            auth.userId,
            id,
            {
                body: body.body,
                clientMessageId: body.clientMessageId,
                attachments: body.attachments,
                model: body.model,
            },
            this.scope(),
        );
    }

    /** Send a failed message again. `409` unless it is `failed` (FR-44). */
    @Post(':id/messages/:messageId/retry')
    @HttpCode(202)
    @Throttle(CONVERSATION_WRITE_THROTTLE)
    @ApiOperation({ summary: 'Retry a message that failed to send' })
    async retry(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('messageId', ParseUUIDPipe) messageId: string,
    ) {
        return this.requireMessages().retry(auth.userId, id, messageId, this.scope());
    }

    /** Discard a failed message. `409` unless it is `failed` (FR-44). */
    @Delete(':id/messages/:messageId')
    @HttpCode(204)
    @Throttle(CONVERSATION_WRITE_THROTTLE)
    @ApiOperation({ summary: 'Discard a message that failed to send' })
    async discard(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('messageId', ParseUUIDPipe) messageId: string,
    ) {
        await this.requireMessages().discard(auth.userId, id, messageId, this.scope());
    }

    /** Move the caller's read position (FR-24). */
    @Post(':id/read')
    @HttpCode(204)
    @Throttle(CONVERSATION_WRITE_THROTTLE)
    @ApiOperation({ summary: 'Mark a conversation read up to a message' })
    async markRead(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: MarkConversationReadDto,
    ) {
        await this.requireConversations().markRead(
            id,
            auth.userId,
            body.lastReadMessageId,
            this.scope(),
        );
    }

    @Delete(':id')
    @HttpCode(204)
    @ApiOperation({ summary: 'Delete a conversation' })
    async delete(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        const deleted = await this.repo.delete(id, auth.userId);
        if (!deleted) throw new NotFoundException();
    }

    @Delete()
    @HttpCode(200)
    @ApiOperation({ summary: 'Delete all conversations' })
    async deleteAll(@CurrentUser() auth: AuthenticatedUser) {
        const count = await this.repo.deleteAllByUser(auth.userId);
        return { deleted: count };
    }

    // ── internals ──────────────────────────────────────────────────────

    private scope() {
        return this.scopeContext?.getScope();
    }

    /** The named-Conversation routes need their services; absent, they do not exist. */
    private requireConversations(): ConversationService {
        if (!this.conversations) throw new NotFoundException();
        return this.conversations;
    }

    private requireMessages(): ConversationMessageService {
        if (!this.messages) throw new NotFoundException();
        return this.messages;
    }
}

/**
 * Validate the named-list filters. Only the NEW parameters are validated —
 * unknown query parameters stay ignored, as they always were on this route.
 */
function parseListFilters(raw: {
    kind?: string;
    agentId?: string;
    contextType?: string;
    contextId?: string;
}): {
    kind?: ConversationKind;
    agentId?: string;
    contextType?: ConversationContextType;
    contextId?: string;
} {
    const filters: {
        kind?: ConversationKind;
        agentId?: string;
        contextType?: ConversationContextType;
        contextId?: string;
    } = {};
    if (raw.kind !== undefined) {
        if (!isConversationKind(raw.kind)) throw new BadRequestException('Unknown kind.');
        filters.kind = raw.kind;
    }
    if (raw.agentId !== undefined) {
        if (!isUUID(raw.agentId)) throw new BadRequestException('agentId must be a uuid.');
        filters.agentId = raw.agentId;
    }
    if (raw.contextType !== undefined) {
        if (!isConversationContextType(raw.contextType)) {
            throw new BadRequestException('Unknown contextType.');
        }
        filters.contextType = raw.contextType;
    }
    if (raw.contextId !== undefined) {
        if (!isUUID(raw.contextId)) throw new BadRequestException('contextId must be a uuid.');
        filters.contextId = raw.contextId;
    }
    return filters;
}
