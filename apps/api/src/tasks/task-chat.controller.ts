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
	constructor(private readonly chat: TaskChatService) {}

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
		return this.chat.edit(auth.userId, id, body.body, {});
	}
}
