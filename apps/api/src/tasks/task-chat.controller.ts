import {
    BadRequestException,
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { TaskChatService } from '@ever-works/agent/tasks-domain';
// Review-fix I5 (second-pass NEW-1 corrected): repository class lives under database barrel.
import { AgentRepository } from '@ever-works/agent/database';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 13.2. Standalone controller
 * for the `PATCH /task-chat-messages/:id` endpoint per
 * `features/task-tracking/plan.md §4`. Kept off the main /tasks
 * route so the message id alone identifies the row — the UI doesn't
 * need to thread the parent taskId through.
 */
@ApiTags('tasks')
@Controller('api/task-chat-messages')
export class TaskChatController {
    constructor(
        private readonly chat: TaskChatService,
        // Review-fix I5: mention-lookup population on edit too — keeps
        // the materialized `mentions` JSON column (refreshed in
        // TaskChatService.edit per Review-fix I3) honest when the user
        // changes which Agent they were tagging mid-edit.
        private readonly agents: AgentRepository,
    ) {}

    @Patch(':id')
    @ApiOperation({
        summary:
            'Edit a chat message within the 5-min window. Past the window returns 403. Only the original author can edit.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 60, ttl: 60_000 } })
    async editChat(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: { body: string },
    ) {
        if (typeof body?.body !== 'string') {
            throw new BadRequestException('body is required.');
        }
        const ownedAgentSlugs = new Map<string, string>();
        try {
            const { rows } = await this.agents.findByUserIdScoped(auth.userId, { limit: 500 });
            for (const a of rows) {
                if (a?.slug && a?.id) ownedAgentSlugs.set(a.slug, a.id);
            }
        } catch {
            // Best-effort.
        }
        return this.chat.edit(auth.userId, id, body.body, { ownedAgentSlugs });
    }
}
