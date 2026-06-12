import {
    Controller,
    Get,
    Post,
    Delete,
    Patch,
    Body,
    Param,
    ParseUUIDPipe,
    Query,
    HttpCode,
    NotFoundException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags, ApiOperation } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    IsArray,
    IsIn,
    IsObject,
    IsOptional,
    IsString,
    MaxLength,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser } from '../auth/decorators/user.decorator';
import { AuthenticatedUser } from '../auth/types/auth.types';
import { ConversationRepository } from '@ever-works/agent/database';
import { ConversationTitleService } from './conversation-title.service';

// Largest page size a client may request from `GET /api/conversations`.
// Security (DoS): the `limit` query param is otherwise passed straight to
// TypeORM's `take`, so an authenticated caller could request e.g.
// `?limit=1000000` and force a large table scan on the shared DB. Mirrors
// the `@Max(200)` cap used by `ListAgentsQueryDto` (see `dto/agent.dto.ts`).
const MAX_CONVERSATIONS_PAGE_SIZE = 200;

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
}

/**
 * Body for `PATCH /api/conversations/:id`.
 *
 * Security: caps the title length so a megabyte-sized string can no longer
 * be persisted verbatim (DB / response bloat). Mirrors the Agent title cap.
 */
class UpdateConversationDto {
    @ApiProperty({ maxLength: 200 })
    @IsString()
    @MaxLength(200)
    title: string;
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
    ) {}

    @Get()
    @ApiOperation({ summary: 'List conversations' })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ) {
        // Security (DoS): clamp client-supplied paging so a hostile `limit`
        // (e.g. `?limit=1000000`) cannot be forwarded verbatim to TypeORM's
        // `take` and trigger a large scan on the shared DB. `undefined` is
        // preserved so the repository default (50) still applies.
        const parsedLimit = limit ? parseInt(limit, 10) : undefined;
        const parsedOffset = offset ? parseInt(offset, 10) : undefined;
        return this.repo.findByUser(auth.userId, {
            limit:
                parsedLimit === undefined || Number.isNaN(parsedLimit)
                    ? undefined
                    : Math.min(Math.max(parsedLimit, 1), MAX_CONVERSATIONS_PAGE_SIZE),
            offset:
                parsedOffset === undefined || Number.isNaN(parsedOffset)
                    ? undefined
                    : Math.max(parsedOffset, 0),
        });
    }

    @Post()
    @ApiOperation({ summary: 'Create a conversation' })
    async create(@CurrentUser() auth: AuthenticatedUser, @Body() body: CreateConversationDto) {
        return this.repo.create({
            userId: auth.userId,
            title: body.title,
            providerId: body.providerId,
        });
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get conversation with messages' })
    async get(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        const conversation = await this.repo.findById(id, auth.userId);
        if (!conversation) throw new NotFoundException();
        return conversation;
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update conversation title' })
    @HttpCode(204)
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateConversationDto,
    ) {
        const conversation = await this.repo.findById(id, auth.userId);
        if (!conversation) throw new NotFoundException();
        await this.repo.updateTitle(id, auth.userId, body.title);
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
}
