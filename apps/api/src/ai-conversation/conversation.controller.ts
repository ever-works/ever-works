import {
    Controller,
    Get,
    Post,
    Delete,
    Patch,
    Body,
    Param,
    Query,
    HttpCode,
    NotFoundException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/user.decorator';
import { AuthenticatedUser } from '../auth/types/auth-user.types';
import { ConversationRepository } from '@ever-works/agent/database';
import { ConversationTitleService } from './conversation-title.service';

type AIMessage = {
    id?: string;
    role: string;
    content: string;
    parts?: unknown[];
    model?: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
};

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
        return this.repo.findByUser(auth.userId, {
            limit: limit ? parseInt(limit, 10) : undefined,
            offset: offset ? parseInt(offset, 10) : undefined,
        });
    }

    @Post()
    @ApiOperation({ summary: 'Create a conversation' })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: { title?: string; providerId?: string },
    ) {
        return this.repo.create({
            userId: auth.userId,
            title: body.title,
            providerId: body.providerId,
        });
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get conversation with messages' })
    async get(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const conversation = await this.repo.findById(id, auth.userId);
        if (!conversation) throw new NotFoundException();
        return conversation;
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update conversation title' })
    @HttpCode(204)
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() body: { title: string },
    ) {
        const conversation = await this.repo.findById(id, auth.userId);
        if (!conversation) throw new NotFoundException();
        await this.repo.updateTitle(id, auth.userId, body.title);
    }

    @Post(':id/messages')
    @ApiOperation({ summary: 'Append messages to a conversation' })
    async appendMessages(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body()
        body: { messages: AIMessage[] },
    ) {
        const conversation = await this.repo.findById(id, auth.userId);
        if (!conversation) throw new NotFoundException();

        await this.repo.appendMessages(
            body.messages.map((m) => ({
                conversationId: id,
                role: m.role as 'user' | 'assistant' | 'system' | 'tool',
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
    async delete(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
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
